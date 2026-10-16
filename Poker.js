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