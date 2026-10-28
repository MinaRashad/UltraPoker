/**
 * @typedef {Object} DeckLayer
 * @property {number} key This peer's XOR key. Prototype obfuscation only.
 * @property {number[]} order Maps positions after this peer's shuffle to prior positions.
 */

/**
 * @typedef {Object} DeckProtocolMessage
 * @property {string[]} [order] Participant order announced by the leader.
 * @property {number[]} [deck] Numeric card values being passed through the ceremony.
 * @property {number} [step] Index of the peer expected to process the deck next.
 */

/**
 * Minimum connection-manager API used by the generic deck engine.
 * @typedef {Object} EngineConnectionManager
 * @property {string} id This peer's network ID.
 * @property {(type: "deck_order"|"deck_forward"|"deck_ready", handler: (message: DeckProtocolMessage, from: string) => void|Promise<void>) => void} registerReliableMessageHandler
 * @property {(peerId: string, type: "deck_order"|"deck_forward"|"deck_ready", payload: Object) => Promise<void>} sendReliableMessage
 */

class P2PEngine {
  /**
   * Create a generic deck engine. Card values in a ceremony are numeric indexes
   * into `cardDefinitions`, so the original card names need not travel in clear.
   * @param {{deck?: string[], random?: () => number}} [options]
   */
  constructor({ deck = P2PEngine.createStandardDeck(), random = Math.random } = {}) {
    /** @type {number[]} */
    this.drawPile = [...deck];
    /** @type {string[]} */
    this.cardDefinitions = [...deck];
    /** @type {() => number} */
    this.random = random;
    /** @type {number[]} The shared final deck encrypted by every peer. */
    this.EncryptedDeck = [];
    /** @type {Record<string, number[]>} Reserved for game-specific dealt hands. */
    this.hands = {};
    /** @type {string[]|null} Participant order; the leader is at index zero. */
    this.order = null;
    /** @type {number|null} This peer's most recently generated layer key. */
    this.privateKey = null;
    /** @type {boolean} Whether the final encrypted deck is ready for dealing. */
    this.deckReady = false;
    /** @type {DeckLayer[]} Layers owned by this peer, in application order. */
    this.encryptionLayers = [];
    /** @type {((event: {stage: string, deck: number[]}) => void)|null} */
    this.onDeckStage = null;
    /** @type {EngineConnectionManager|null} */
    this.connectionManager = null;
    /** @type {number[]|undefined} Position map created by the most recent shuffle. */
    this.lastShuffleOrder = undefined;
  }

  /**
   * Create the engine's default card-definition list.
   * Games can pass their own deck to the constructor when they need fewer suits.
   * @returns {string[]}
   */
  static createStandardDeck() {
    const suits = ["♣", "♦", "♥", "♠", 
                   "☪", "𖤓", "☘", "✝",
                   "☠", "᪥"];
    const ranks = [
      "A", "2", "3", "4", "5", "6", "7",
      "8", "9", "10", "J", "Q", "K",
    ];
    const deck = suits.flatMap((suit) =>
      ranks.map((rank) => (`${rank}${suit}`))
    );

    return deck;
  }
  /**
   * Shuffle a deck and remember the position mapping needed to trace an
   * individual card back through this shuffle during reveal.
   * @template T
   * @param {T[]} [deck]
   * @returns {T[]}
   */
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

  /**
   * Register this engine as the handler for reliable deck-ceremony messages.
   * @param {EngineConnectionManager} connectionManager
   * @returns {void}
   */
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

  /**
   * Start the leader-driven shuffle/encryption pass. Every peer applies exactly
   * one layer before forwarding the deck to the next peer.
   * @param {string[]} order Unique participant IDs, with the leader first.
   * @param {EngineConnectionManager} [connectionManager]
   * @returns {Promise<void>}
   */
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

  /**
   * Reject an empty order, non-string IDs, or duplicate participants before
   * their order is used to authorize deck operations.
   * @param {unknown} order
   * @returns {asserts order is string[]}
   */
  validateOrder(order) {
    if (!Array.isArray(order) || order.length === 0 ||
        order.some((peerId) => typeof peerId !== "string" || peerId.length === 0) ||
        new Set(order).size !== order.length) {
      throw new TypeError("Deck order must contain unique, non-empty peer IDs.");
    }
  }

  /**
   * Accept the participant order only from its announced leader.
   * @param {DeckProtocolMessage} message
   * @param {string} from
   * @returns {void}
   */
  receiveDeckOrder(message, from) {
    this.validateOrder(message.order);
    if (from !== message.order[0] || !message.order.includes(this.connectionManager.id)) {
      throw new Error("Deck order must come from its leader and include this peer.");
    }
    this.order = [...message.order];
    this.deckReady = false;
  }

  /**
   * Validate a forwarded deck and either apply this peer's layer, finalize the
   * ceremony at the leader, or distribute the final deck to all participants.
   * @param {DeckProtocolMessage} message
   * @param {string} from
   * @returns {Promise<void>}
   */
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

  /**
   * Apply this peer's shuffle and XOR layer to every numeric card value.
   * XOR is intentionally a prototype placeholder, not secure encryption.
   * @param {number[]} deck
   * @returns {number[]}
   */
  applyDeckLayer(deck) {
    const key = new Uint32Array(1);
    if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
      throw new Error("Secure random number generation is unavailable.");
    }
    do {
      globalThis.crypto.getRandomValues(key);
    } while (key[0] === 0);
    this.privateKey = key[0];

    // Store the permutation and key together: reveals need this peer's mapping
    // to trace one card without rebuilding or unshuffling the full deck.
    const shuffledDeck = this.shuffleDeck(deck);
    this.encryptionLayers.push({
      key: this.privateKey,
      order: this.lastShuffleOrder,
    });
    return shuffledDeck.map((card) => (card ^ this.privateKey) >>> 0);
  }

  /**
   * Notify an optional UI/test observer of a copy of a deck-stage snapshot.
   * @param {string} stage
   * @param {number[]} deck
   * @returns {void}
   */
  reportDeckStage(stage, deck) {
    if (typeof this.onDeckStage === "function") {
      this.onDeckStage({ stage, deck: [...deck] });
    }
  }

  /**
   * Forward the transformed deck to the next peer, or back to the leader after
   * the last participant has applied its layer.
   * @param {number[]} deck
   * @param {number} nextStep
   * @returns {Promise<void>}
   */
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

  /**
   * Save the completed shared deck without removing any encryption layers.
   * @param {number[]} deck
   * @returns {void}
   */
  completeDeck(deck) {
    this.EncryptedDeck = [...deck];
    this.deckReady = true;
  }

  /**
   * Accept the leader's final encrypted deck after checking its order and shape.
   * @param {DeckProtocolMessage} message
   * @param {string} from
   * @returns {void}
   */
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

  /**
   * Remove this peer's XOR layer from one card and map its position back
   * through this peer's shuffle.
   * @param {number} value Encrypted numeric card value.
   * @param {number} position Card position in the current layer.
   * @param {number} layerIndex This peer's index in the announced order.
   * @returns {{value: number, position: number}}
   */
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

  /**
   * Map a private card's position through this peer's shuffle without removing
   * this peer's key; the owner keeps that final private-key operation local.
   * @param {number} position Card position in the current layer.
   * @param {number} layerIndex This peer's index in the announced order.
   * @returns {number} Position in the layer immediately before this peer.
   */
  getPreviousLayerCardPosition(position, layerIndex) {
    const ownIndex = this.order.indexOf(this.connectionManager.id);
    const layer = this.encryptionLayers[0];
    if (ownIndex !== layerIndex || !layer ||
        !Number.isInteger(position) || position < 0 || position >= layer.order.length) {
      throw new Error("This peer cannot map the requested card position.");
    }
    return layer.order[position];
  }

  /**
   * Remove this peer's key from the owner's private card after other layers
   * have been handled, without returning the private value over the network.
   * @param {number} value Card value with all other layers already removed.
   * @param {number} layerIndex This peer's index in the announced order.
   * @returns {number}
   */
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