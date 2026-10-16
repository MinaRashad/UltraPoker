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
    connectionManager.registerReliableMessageHandler("deck_ready", (message, from) =>
      this.receiveFinalDeck(message, from)
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
    if (message.action !== undefined) {
      throw new Error("Deck forwarding only supports the encryption ceremony.");
    }

    const lastPeerIndex = this.order.length - 1;
    // The final step comes back to the leader after every participant has applied a layer.
    if (message.step === this.order.length) {
      if (this.connectionManager.id !== this.order[0] || from !== this.order[lastPeerIndex]) {
        throw new Error("Final deck must be returned by the last peer to the leader.");
      }
      this.completeDeck(message.deck);
      this.reportDeckStage("fully-encrypted", message.deck);
      await Promise.all(this.order.slice(1).map((peerId) =>
        this.connectionManager.sendReliableMessage(peerId, "deck_ready", {
          deck: message.deck,
          order: this.order,
        })
      ));
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

  receiveFinalDeck(message, from) {
    if (!this.order || from !== this.order[0] ||
        JSON.stringify(message.order) !== JSON.stringify(this.order) ||
        !Array.isArray(message.deck) || message.deck.length !== this.cardDefinitions.length ||
        message.deck.some((card) => !Number.isInteger(card) || card < 0 || card > 0xffffffff)) {
      throw new Error("Received an invalid final encrypted deck.");
    }
    this.completeDeck(message.deck);
    this.reportDeckStage("fully-encrypted", message.deck);
  }

  decryptCardLayer(value, position, layerIndex) {
    const ownIndex = this.order.indexOf(this.connectionManager.id);
    const layer = this.encryptionLayers[0];
    if (ownIndex !== layerIndex || !layer ||
        !Number.isInteger(position) || position < 0 || position >= layer.order.length ||
        !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error("This peer cannot decrypt the requested card layer.");
    }

    return {
      value: (value ^ layer.key) >>> 0,
      position: layer.order[position],
    };
  }

  getPreviousLayerCardPosition(position, layerIndex) {
    const ownIndex = this.order.indexOf(this.connectionManager.id);
    const layer = this.encryptionLayers[0];
    if (ownIndex !== layerIndex || !layer ||
        !Number.isInteger(position) || position < 0 || position >= layer.order.length) {
      throw new Error("This peer cannot map the requested card position.");
    }
    return layer.order[position];
  }

  decryptOwnCard(value, layerIndex) {
    const ownIndex = this.order.indexOf(this.connectionManager.id);
    const layer = this.encryptionLayers[0];
    if (ownIndex !== layerIndex || !layer ||
        !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error("This peer cannot remove its key from the requested card.");
    }
    return (value ^ layer.key) >>> 0;
  }

}