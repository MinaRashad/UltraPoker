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

    /**
     * @type {string[]}
     */
    this.log = [];

    // set up event listeners for incoming connections
    this.peer.on('open', (id) => {
        this.id = id;
        this.logMessage("INFO", `Peer initialized with id: ${id}`, "System");
    });
    this.peer.on('connection', (conn) => {
      const peer_id = conn.peer;
      this.peer_ids.push(peer_id);
      this.peerConnections[peer_id] = conn;
      this.lastSeen[peer_id] = Date.now();  
      this.logMessage("INFO", `Connected to peer ${peer_id}`, "System");

      // set up event listener for incoming messages from this peer
      conn.on('data', (data) => {
        console.log(`Received message from ${peer_id}:`, data);
        this.receiveMessage(data);
      });
    });
    this.peer.on('disconnected', () => {
      this.logMessage("INFO", "Peer disconnected", "System");
    });


    // send heartbeat messages to all connected peers every 5 seconds 
    setInterval(() => {
      console.log(this.peer_ids)
      for (const peer_id of this.peer_ids) {
        this.heartbeat(peer_id);
      }
    }, 5000);
  }

  getPeerId() {
    // wait for the peer to be initialized and return the id
    return new Promise((resolve) => {
      const checkId = () => {
        if (this.id) {
          resolve(this.id);
        } else {
          setTimeout(checkId, 100);
        }
      };
      checkId();
    });
}

  /**
   * @param {string} peer_id
   * @returns {void}
   */
  connectToPeer(peer_id) {
    if (this.peer_ids.includes(peer_id)) {
      this.logMessage("INFO", `Already connected to peer ${peer_id}`, "System");
      return;
    }
    this.peer_ids.push(peer_id);

    const conn = this.peer.connect(peer_id);
    this.peerConnections[peer_id] = conn;
    this.lastSeen[peer_id] = Date.now();
    this.logMessage("INFO", `Connected to peer ${peer_id}`, "System");
    

    // set up event listener for incoming messages from this peer
    conn.on('data', (data) => {
      console.log(`Received message from ${peer_id}:`, data);
      this.receiveMessage(data);
    });
  }

  /**
   * @param {string} peer_id
   * @param {string} message
   * @returns {void}
   */
  sendMessage(peer_id, message) {
    if (!this.peerConnections[peer_id]) {
      this.logMessage("ERROR", `Not connected to peer ${peer_id}`, "System");
      return;
    }
    this.peerConnections[peer_id]
            .send({type: "message", message: message, from: this.id});
  }
  
  sendToAll(message) {
    this.logMessage("MESSAGE", message, this.id);

    for (const peer_id of this.peer_ids) {
      this.sendMessage(peer_id, message);
    }
  }

  /**
   * @param {string} peer_id
   * @returns {void}
   */
  heartbeat(peer_id) {
    this.peerConnections[peer_id]
            .send({type: "heartbeat", from: this.id});
  }

  /**
   * @description Relay the list of connected peers to all connected peers
   * @returns {void}
   */
  relayPeers() {
    for (const peer_id of this.peer_ids) {
      this.sendMessage(peer_id, {type: "peers", peers: this.peer_ids});
    }
  }


  logMessage(type, message, from) {
    this.log.push(`[${type}] ${from}: ${message}`);
  }
  
      
/**
 * 
 * @param {Object} message 
 * @returns {void}
 */
 receiveMessage(message) {
    console.log(message);
    switch (message.type) {
      case "message":
        this.logMessage("MESSAGE", message.message, message.from);
        this.lastSeen[message.from] = Date.now();
        break;
      case "heartbeat":
        this.lastSeen[message.from] = Date.now();
        break;
      case "peers":
        // A list of peers that host has
        if (Array.isArray(message.peers)) {
          for (const peer_id of message.peers) {
            if (!this.peer_ids.includes(peer_id) && peer_id !== this.id) {
              this.connectToPeer(peer_id);
            }
          }
        }
        break;
      default:
        this.logMessage("ERROR", `Unknown message type: ${message.type}`, "System");
    }


 }
}
