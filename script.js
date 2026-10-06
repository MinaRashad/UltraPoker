// Can we connect to more than one peer at the same time?

class PeerConnectionManager {
  constructor() {

    /** @type {string[]} */
    this.peer_ids = [];

    /** @type {Record<string, {send: (data: string) => void}>} */
    this.peerConnections = {};

    /** @type {Record<string, number>} */
    this.lastSeen = {};
    this.peer = new Peer();

    /** @type {string} */
    this.id = null

    this.peer.on('open', (id) => {
        this.id = id;
        resolve(id);
      });

    /**
     * @type {string[]}
     */
    this.log = [];
  }

  getPeerId() {
    return new Promise((resolve, reject) => {
      if (this.id) {
        resolve(this.id);
      }
    });
}

  /**
   * @param {string} peer_id
   * @returns {void}
   */
  connectToPeer(peer_id) {
    if (this.peer_ids.includes(peer_id)) {
      console.log(`Already connected to peer ${peer_id}`);
      return;
    }
    this.peer_ids.push(peer_id);

    const conn = this.peer.connect(peer_id);
    this.peerConnections[peer_id] = conn;
    this.lastSeen[peer_id] = Date.now();
  }

  /**
   * @param {string} peer_id
   * @param {string} message
   * @returns {void}
   */
  sendMessage(peer_id, message) {
    if (!this.peerConnections[peer_id]) {
      console.log(`Not connected to peer ${peer_id}`);
      return;
    }
    this.peerConnections[peer_id]
            .send(`{type: "message", message: "${message}", from: "${this.id}"}`);
  }

  /**
   * @param {string} peer_id
   * @returns {void}
   */
  heartbeat(peer_id) {
    this.peerConnections[peer_id]
            .send(`{type: "heartbeat", message: "${peer_id}"}`);
      }

  logMessage(type, message, from) {
    this.log.push(`[${type}] ${from}: ${message}`);
  }
      
/**
 * 
 * @param {string} message 
 * @returns {void}
 */
 receiveMessage(message) {
    let messageObj;
    try {
      messageObj = JSON.parse(message);
    } catch (e) {
      this.logMessage("ERROR", "Failed to parse message", "System");
      return;
    }

    switch (messageObj.type) {
      case "message":
        this.logMessage("MESSAGE", messageObj.message, messageObj.from);
        break;
      case "heartbeat":
        this.lastSeen[messageObj.message] = Date.now();
        break;
      default:
        this.logMessage("ERROR", `Unknown message type: ${messageObj.type}`, "System");
    }


 }
}
