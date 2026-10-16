class P2PEngine {
  /**
   * @param {{deck?: unknown[], random?: () => number}} options
   */
  constructor({ deck = P2PEngine.createStandardDeck(), random = Math.random } = {}) {
    this.drawPile = [...deck];
    this.cardDefinitions = [...deck];
    this.random = random;
    this.EncryptedDeck = [];
    this.hands = {};
    this.order = null;
    this.privateKey = null;
    this.deckReady = false;
    this.encryptionLayers = [];
    this.onDeckStage = null;
  }

  /**
   * @param {{includeJokers?: boolean}} options
   * @returns {{suit: string, rank: string}[]}
   */
  static createStandardDeck() {
    const suits = ["♣", "♦", "♥", "♠", 
                   "☪", "𖤓", "☘", "✝",
                   "☠", ""];
    const ranks = [
      "A", "2", "3", "4", "5", "6", "7",
      "8", "9", "10", "J", "Q", "K",
    ];
    const deck = suits.flatMap((suit) =>
      ranks.map((rank) => (`${rank}${suit}`))
    );

    return deck;
  }


  shuffleDeck(deck = this.drawPile) {
    const shuffled = [...deck];
    const order = shuffled.map((_, index) => index);
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const value = this.random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new RangeError("Random source must return a number in [0, 1).");
      }

      const j = Math.floor(value * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      [order[i], order[j]] = [order[j], order[i]];
    }
    this.lastShuffleOrder = order;
    return shuffled;
  }

  attachConnectionManager(connectionManager) {
    this.connectionManager = connectionManager;
    // Let the connection manager route deck protocol messages to this engine.
    connectionManager.registerReliableMessageHandler("deck_order", (message, from) =>
      this.receiveDeckOrder(message, from)
    );
    connectionManager.registerReliableMessageHandler("deck_forward", (message, from) =>
      this.receiveDeck(message, from)
    );
  }

  async startDeckCeremony(order, connectionManager = this.connectionManager) {
    if (!connectionManager) {
      throw new Error("A connection manager is required to start the deck ceremony.");
    }
    this.attachConnectionManager(connectionManager);
    this.validateOrder(order);
    if (order[0] !== connectionManager.id) {
      throw new Error("Only the first peer in the order can start the deck ceremony.");
    }

    this.order = [...order];
    this.deckReady = false;
    this.EncryptedDeck = [];
    this.encryptionLayers = [];
    // Cards travel as numeric IDs during the ceremony; cardDefinitions maps IDs back to cards.
    this.drawPile = this.cardDefinitions.map((card, index) => index);
    this.reportDeckStage("before-encryption", this.drawPile);

    // Tell every participant the same sequence before sending the deck to the first participant.
    await Promise.all(order.slice(1).map((peerId) =>
      connectionManager.sendReliableMessage(peerId, "deck_order", { order: this.order })
    ));

    // The leader is first in the order, so it applies its own shuffle and XOR layer first.
    const encryptedDeck = this.applyDeckLayer(this.drawPile);
    this.reportDeckStage("after-encryption", encryptedDeck);
    await this.forwardDeck(encryptedDeck, 1);
  }

  validateOrder(order) {
    if (!Array.isArray(order) || order.length === 0 ||
        order.some((peerId) => typeof peerId !== "string" || peerId.length === 0) ||
        new Set(order).size !== order.length) {
      throw new TypeError("Deck order must contain unique, non-empty peer IDs.");
    }
  }

  receiveDeckOrder(message, from) {
    this.validateOrder(message.order);
    if (from !== message.order[0] || !message.order.includes(this.connectionManager.id)) {
      throw new Error("Deck order must come from its leader and include this peer.");
    }
    this.order = [...message.order];
    this.deckReady = false;
  }

  async receiveDeck(message, from) {
    if (!this.order) {
      throw new Error("Received a deck before the leader's order.");
    }
    if (!Array.isArray(message.deck) ||
        message.deck.some((card) => !Number.isInteger(card) || card < 0 || card > 0xffffffff) ||
        !Number.isInteger(message.step)) {
      throw new TypeError("Received an invalid encrypted deck.");
    }

    const lastPeerIndex = this.order.length - 1;
    // The final step comes back to the leader after every participant has applied a layer.
    if (message.step === this.order.length) {
      if (this.connectionManager.id !== this.order[0] || from !== this.order[lastPeerIndex]) {
        throw new Error("Final deck must be returned by the last peer to the leader.");
      }
      this.completeDeck(message.deck);
      this.reportDeckStage("fully-encrypted", message.deck);
      return;
    }

    if (message.action === "decrypt") {
      await this.receiveDeckForDecryption(message, from);
      return;
    }

    // Only accept the deck from the peer immediately before us in the announced order.
    if (message.step < 1 || message.step > lastPeerIndex ||
        this.order[message.step] !== this.connectionManager.id ||
        this.order[message.step - 1] !== from) {
      throw new Error("Encrypted deck was forwarded out of order.");
    }

    const encryptedDeck = this.applyDeckLayer(message.deck);
    this.reportDeckStage("after-encryption", encryptedDeck);
    await this.forwardDeck(encryptedDeck, message.step + 1);
  }

  applyDeckLayer(deck) {
    const key = new Uint32Array(1);
    if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
      throw new Error("Secure random number generation is unavailable.");
    }
    do {
      globalThis.crypto.getRandomValues(key);
    } while (key[0] === 0);
    this.privateKey = key[0];

    // XOR applies this peer's layer; later this same key can remove that layer.
    // XOR is obfuscation for this prototype, not secure encryption.
    const shuffledDeck = this.shuffleDeck(deck);
    this.encryptionLayers.push({
      key: this.privateKey,
      order: this.lastShuffleOrder,
    });
    return shuffledDeck.map((card) => (card ^ this.privateKey) >>> 0);
  }

  decryptDeckLayer(deck) {
    const layer = this.encryptionLayers.pop();
    if (!layer) {
      throw new Error("There are no encryption layers to remove.");
    }
    if (!Array.isArray(deck) || deck.length !== layer.order.length) {
      this.encryptionLayers.push(layer);
      throw new TypeError("Deck does not match the encryption layer.");
    }

    // XOR first to restore the shuffled values, then put each value back in its old position.
    const unshuffled = new Array(deck.length);
    deck.forEach((card, shuffledIndex) => {
      unshuffled[layer.order[shuffledIndex]] = (card ^ layer.key) >>> 0;
    });
    return unshuffled;
  }

  async startDeckDecryption() {
    if (!this.connectionManager || !this.deckReady || !this.order) {
      throw new Error("The encrypted deck must be ready before decryption starts.");
    }
    if (this.connectionManager.id !== this.order[0]) {
      throw new Error("Only the leader can start deck decryption.");
    }

    this.deckReady = false;
    this.reportDeckStage("before-decryption", this.EncryptedDeck);
    const lastPeerIndex = this.order.length - 1;
    if (lastPeerIndex === 0) {
      this.completeDeck(this.decryptDeckLayer(this.EncryptedDeck));
      this.reportDeckStage("fully-decrypted", this.EncryptedDeck);
      return;
    }

    await this.connectionManager.sendReliableMessage(
      this.order[lastPeerIndex],
      "deck_forward",
      { action: "decrypt", deck: this.EncryptedDeck, step: lastPeerIndex }
    );
  }

  async receiveDeckForDecryption(message, from) {
    const step = message.step;
    const myIndex = this.order.indexOf(this.connectionManager.id);
    const expectedSender = step === this.order.length - 1
      ? this.order[0]
      : this.order[step + 1];
    if (myIndex !== step || from !== expectedSender) {
      throw new Error("Encrypted deck was sent to the wrong peer for decryption.");
    }

    this.reportDeckStage("before-decryption", message.deck);
    const decryptedDeck = this.decryptDeckLayer(message.deck);
    this.reportDeckStage("after-decryption", decryptedDeck);

    if (step === 0) {
      this.completeDeck(decryptedDeck);
      this.reportDeckStage("fully-decrypted", decryptedDeck);
      return;
    }

    await this.connectionManager.sendReliableMessage(
      this.order[step - 1],
      "deck_forward",
      { action: "decrypt", deck: decryptedDeck, step: step - 1 }
    );
  }

  reportDeckStage(stage, deck) {
    if (typeof this.onDeckStage === "function") {
      this.onDeckStage({ stage, deck: [...deck] });
    }
  }

  async forwardDeck(deck, nextStep) {
    // With only the leader in the order, the leader's own layer is already the whole ceremony.
    if (nextStep >= this.order.length && this.order.length === 1) {
      this.completeDeck(deck);
      return;
    }

    const isFinalTransfer = nextStep >= this.order.length;
    // After the last participant, send the fully layered deck back to the leader.
    const peerId = isFinalTransfer ? this.order[0] : this.order[nextStep];
    await this.connectionManager.sendReliableMessage(peerId, "deck_forward", {
      deck,
      step: isFinalTransfer ? this.order.length : nextStep,
    });
  }

  completeDeck(deck) {
    this.EncryptedDeck = [...deck];
    this.deckReady = true;
  }

}