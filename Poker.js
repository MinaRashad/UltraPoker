/**
 * Shared state for game implementations built on the generic deck engine.
 */
class Game {
    constructor() {
        /** @type {string[]} */
        this.players = [];
        /** @type {number} */
        this.currentPlayerIndex = 0;
        /** @type {number[]} */
        this.deck = [];
        /** @type {string[]} */
        this.communityCards = [];
        /** @type {number} */
        this.pot = 0;
        /** @type {number} */
        this.currentBet = 0;
        /** @type {number} 0: pre-flop, 1: flop, 2: turn, 3: river. */
        this.round = 0; // 0: Pre-flop, 1: Flop, 2: Turn, 3: River
    }
}

/**
 * @typedef {Object} PokerMessage
 * @property {string} [action]
 * @property {string} [requestId]
 * @property {string} [requester]
 * @property {string} [ownerId]
 * @property {"private"|"public"} [visibility]
 * @property {number} [dealPosition]
 * @property {number} [layerIndex]
 * @property {number} [value]
 * @property {number} [position]
 */

/**
 * Data sent to a peer that owns a layer needed to reveal one card.
 * @typedef {Object} CardLayerRequest
 * @property {string} peerId
 * @property {string} requester
 * @property {number} dealPosition
 * @property {string|null} ownerId
 * @property {"private"|"public"} visibility
 * @property {number} layerIndex
 * @property {number} value
 * @property {number} position
 */

/**
 * @typedef {Object} DecryptedCard
 * @property {number} cardId Numeric index into the engine's card definitions.
 * @property {string} card Human-readable card label.
 * @property {string|null} ownerId Player who owns this private card, or null for public cards.
 * @property {"private"|"public"} visibility
 * @property {number} dealPosition Position in the final encrypted deck.
 */

/**
 * @typedef {Object} PendingCardRequest
 * @property {string} peerId
 * @property {(result: {value: number, position: number}) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {ReturnType<typeof setTimeout>} timer
 */

/**
 * Minimum connection-manager API required by Poker.
 * @typedef {Object} PokerConnectionManager
 * @property {string} id
 * @property {(gameName: string, handler: (message: PokerMessage, from: string) => void|Promise<void>) => void} registerGameHandler
 * @property {(peerId: string, gameName: string, payload: Object) => void} sendGameMessage
 * @property {(reason: string) => void} leaveGame
 */

class Poker extends Game {
    /**
     * Connect game-level rules to the transport and generic deck engine.
     * @param {PokerConnectionManager} connectionManager
     * @param {P2PEngine} engine
     */
    constructor(connectionManager, engine) {
        super();
        /** @type {PokerConnectionManager} */
        this.connectionManager = connectionManager;
        /** @type {P2PEngine} */
        this.engine = engine;
        /** @type {string[]|null} */
        this.order = null;
        /** @type {Map<string, PendingCardRequest>} */
        this.pendingCardRequests = new Map();
        /** @type {number} */
        this.cardRequestCounter = 0;
        /** @type {boolean} */
        this.hasLeftGame = false;
        /** @type {((entry: Object) => void)|null} */
        this.onCardLog = null;

        engine.attachConnectionManager(connectionManager);
        connectionManager.registerGameHandler("Poker", (message, from) =>
            this.receiveGameMessage(message, from)
        );
    }

    /**
     * Set the shared dealing order and ensure it agrees with the deck ceremony.
     * @param {string[]} order
     * @returns {void}
     */
    setPlayers(order) {
        this.engine.validateOrder(order);
        if (this.engine.order &&
            JSON.stringify(order) !== JSON.stringify(this.engine.order)) {
            throw new Error("Poker player order must match the encrypted deck order.");
        }
        this.order = [...order];
        this.players = [...order];
    }

    /**
     * In the prototype's two-round deal, each player's first card is dealt
     * before the second round begins. Positions after those private cards are
     * treated as public/community cards.
     * @param {number} dealPosition
     * @returns {string|null} The owning player ID, or null for a public card.
     */
    getCardOwner(dealPosition) {
        if (!this.order) {
            throw new Error("Poker players have not been set.");
        }
        if (!Number.isInteger(dealPosition) ||
            dealPosition < 0 || dealPosition >= this.engine.EncryptedDeck.length) {
            throw new RangeError("Card position is outside the encrypted deck.");
        }

        const privateCardCount = this.order.length * 2;
        return dealPosition < privateCardCount
            ? this.order[dealPosition % this.order.length]
            : null;
    }

    /**
     * Resolve one card without changing the shared encrypted deck. Each peer
     * removes only its own layer; private-card owners keep the final key removal
     * local so their hole-card value is not sent to another player.
     * @param {number} dealPosition
     * @returns {Promise<DecryptedCard>}
     */
    async requestCard(dealPosition) {
        if (this.hasLeftGame) {
            throw new Error("You have left the game.");
        }
        if (!this.engine.deckReady || !this.order) {
            throw new Error("The encrypted deck and player order must be ready.");
        }

        const ownerId = this.getCardOwner(dealPosition);
        const visibility = ownerId === null ? "public" : "private";
        if (visibility === "private" && ownerId !== this.connectionManager.id) {
            throw new Error("You may only request your own private cards.");
        }

        let value = this.engine.EncryptedDeck[dealPosition];
        let position = dealPosition;
        const ownerLayerIndex = ownerId === null ? -1 : this.order.indexOf(ownerId);

        try {
            // Walk the layers backwards so each peer receives the card position and
            // value that correspond to its own shuffle/encryption layer.
            for (let layerIndex = this.order.length - 1; layerIndex >= 0; layerIndex -= 1) {
                const peerId = this.order[layerIndex];
                if (peerId === this.connectionManager.id) {
                    if (visibility === "private" && layerIndex === ownerLayerIndex) {
                        position = this.engine.getPreviousLayerCardPosition(position, layerIndex);
                    } else {
                        const decrypted = this.engine.decryptCardLayer(value, position, layerIndex);
                        value = decrypted.value;
                        position = decrypted.position;
                    }
                    this.logCardMessage("LOCAL DECRYPT", {
                        dealPosition, layerIndex, value, position, visibility,
                    });
                } else {
                    const result = await this.requestLayerFromPeer({
                        peerId,
                        requester: this.connectionManager.id,
                        dealPosition,
                        ownerId,
                        visibility,
                        layerIndex,
                        value,
                        position,
                    });
                    value = result.value;
                    position = result.position;
                }
            }

            if (visibility === "private") {
                value = this.engine.decryptOwnCard(value, ownerLayerIndex);
                this.logCardMessage("OWNER FINAL DECRYPT", {
                    dealPosition, layerIndex: ownerLayerIndex, value, visibility,
                });
            }

            const card = this.engine.cardDefinitions[value];
            if (typeof card !== "string") {
                throw new Error("Decrypted card ID is not in this game's deck.");
            }
            return { cardId: value, card, ownerId, visibility, dealPosition };
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            const reason =
                `Card decryption failed; leaving the game because this may indicate a dishonest node. ${details}`;
            this.leaveGame(reason);
            throw new Error(reason);
        }
    }

    /**
     * Leave the peer game after a card cannot be decrypted reliably.
     * @param {string} reason
     * @returns {void}
     */
    leaveGame(reason) {
        if (this.hasLeftGame) return;
        this.hasLeftGame = true;
        this.players = [];
        this.order = null;

        for (const pending of this.pendingCardRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("You have left the game."));
        }
        this.pendingCardRequests.clear();
        this.connectionManager.leaveGame(reason);
    }

    /**
     * Ask a remote layer owner to process one card and resolve when its response
     * arrives. A timeout rejects the request rather than exposing a partial card.
     * @param {CardLayerRequest} request
     * @returns {Promise<{value: number, position: number}>}
     */
    requestLayerFromPeer(request) {
        const requestId =
            `${this.connectionManager.id}-${Date.now()}-${++this.cardRequestCounter}`;
        const message = { ...request, action: "decrypt_card", requestId };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingCardRequests.delete(requestId);
                reject(new Error(`Timed out waiting for ${request.peerId} to decrypt a card.`));
            }, 10000);

            this.pendingCardRequests.set(requestId, {
                peerId: request.peerId,
                resolve,
                reject,
                timer,
            });
            try {
                this.logCardMessage("SEND DECRYPT REQUEST", {
                    to: request.peerId,
                    requestId,
                    dealPosition: request.dealPosition,
                    layerIndex: request.layerIndex,
                    encryptedValue: request.value,
                    encryptedPosition: request.position,
                    visibility: request.visibility,
                });
                this.connectionManager.sendGameMessage(
                    request.peerId,
                    "Poker",
                    message
                );
            } catch (error) {
                clearTimeout(timer);
                this.pendingCardRequests.delete(requestId);
                reject(error);
            }
        });
    }

    /**
     * Route an incoming Poker protocol message to its request or response handler.
     * @param {PokerMessage} message
     * @param {string} from
     * @returns {Promise<void>}
     */
    async receiveGameMessage(message, from) {
        if (!message || typeof message.action !== "string") {
            throw new TypeError("Poker message must include an action.");
        }
        if (message.action === "decrypt_card") {
            await this.handleDecryptRequest(message, from);
        } else if (message.action === "decrypt_card_result") {
            this.handleDecryptResult(message, from);
        } else {
            throw new Error(`Unknown Poker message action: ${message.action}`);
        }
    }

    /**
     * Validate that the sender may request this layer, decrypt that layer only,
     * and return the transformed value and position to the requester.
     * @param {PokerMessage} message
     * @param {string} from
     * @returns {Promise<void>}
     */
    async handleDecryptRequest(message, from) {
        if (!this.engine.deckReady || !this.order) {
            throw new Error("Cannot decrypt a card before the final deck is ready.");
        }
        this.logCardMessage("RECEIVE DECRYPT REQUEST", {
            from,
            requestId: message.requestId,
            dealPosition: message.dealPosition,
            layerIndex: message.layerIndex,
            encryptedValue: message.value,
            encryptedPosition: message.position,
            visibility: message.visibility,
        });

        const layerIndex = this.order ? this.order.indexOf(this.connectionManager.id) : -1;
        const expectedSender = message.requester;
        const ownerId = this.getCardOwner(message.dealPosition);
        const expectedVisibility = ownerId === null ? "public" : "private";
        if (layerIndex < 0 || layerIndex !== message.layerIndex ||
            from !== expectedSender ||
            (message.visibility === "private" && message.requester !== ownerId) ||
            message.ownerId !== ownerId || message.visibility !== expectedVisibility) {
            throw new Error("Poker card-decryption request is not authorized or in order.");
        }

        const decrypted = this.engine.decryptCardLayer(
            message.value,
            message.position,
            layerIndex
        );
        this.logCardMessage("LOCAL DECRYPT FOR REQUESTER", {
            requester: message.requester,
            requestId: message.requestId,
            dealPosition: message.dealPosition,
            layerIndex,
            value: decrypted.value,
            position: decrypted.position,
        });

        this.connectionManager.sendGameMessage(from, "Poker", {
            action: "decrypt_card_result",
            requestId: message.requestId,
            layerIndex,
            value: decrypted.value,
            position: decrypted.position,
            value: decrypted.value,
            position: decrypted.position,
        });
        this.logCardMessage("SEND DECRYPT RESULT", {
            to: from,
            requestId: message.requestId,
            layerIndex,
        });
    }

    /**
     * Match a decryption response to its outstanding request and resolve it.
     * @param {PokerMessage} message
     * @param {string} from
     * @returns {void}
     */
    handleDecryptResult(message, from) {
        this.logCardMessage("RECEIVE DECRYPT RESULT", {
            from,
            requestId: message.requestId,
            layerIndex: message.layerIndex,
            value: message.value,
            position: message.position,
        });
        const pending = this.pendingCardRequests.get(message.requestId);
        if (!pending || pending.peerId !== from ||
            !Number.isInteger(message.value) || !Number.isInteger(message.position)) {
            throw new Error("Unexpected or invalid Poker decryption response.");
        }

        clearTimeout(pending.timer);
        this.pendingCardRequests.delete(message.requestId);
        pending.resolve({ value: message.value, position: message.position });
    }

    /**
     * Emit a card-protocol event to the optional UI/test logger.
     * @param {string} action
     * @param {Object} details
     * @returns {void}
     */
    logCardMessage(action, details) {
        const entry = {
            action,
            peerId: this.connectionManager.id,
            ...details,
        };
        if (typeof this.onCardLog === "function") {
            this.onCardLog(entry);
        }
    }
}