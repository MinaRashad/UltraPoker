/**
 * @description This constructor goal is to help simulate
 */
class Game {
    constructor() {
        this.players = [];
        this.currentPlayerIndex = 0;
        this.deck = [];
        this.communityCards = [];
        this.pot = 0;
        this.currentBet = 0;
        this.round = 0; // 0: Pre-flop, 1: Flop, 2: Turn, 3: River
    }
}

class Poker extends Game {
    constructor(connectionManager, engine) {
        super();
        this.connectionManager = connectionManager;
        this.engine = engine;
        this.order = null;
        this.pendingCardRequests = new Map();
        this.cardRequestCounter = 0;
        this.onCardLog = null;

        engine.attachConnectionManager(connectionManager);
        connectionManager.registerGameHandler("Poker", (message, from) =>
            this.receiveGameMessage(message, from)
        );
    }

    setPlayers(order) {
        this.engine.validateOrder(order);
        if (this.engine.order &&
            JSON.stringify(order) !== JSON.stringify(this.engine.order)) {
            throw new Error("Poker player order must match the encrypted deck order.");
        }
        this.order = [...order];
        this.players = [...order];
    }

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

    async requestCard(dealPosition) {
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

        // Trace this card's position through each layer; the owner removes its key last.
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
    }

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