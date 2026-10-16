class PeerConnectionManager {
  /**
   * 
   * @param {string|null} name 
   */
  constructor(name=null) {

    // Network information
    /** @type {string[]} */
    this.peer_ids = [];
    /** @type {Record<string, {send: (data: string) => void}>} */
    this.peerConnections = {};
    /** @type {Record<string, string>} */
    this.peerNames = {};
    /** @type {Record<string, number>} */
    this.lastSeen = {};
    this.leader = null; // if the leader is null, then I am the leader.

    // My information
    /** @type {Peer} */
    this.peer = new Peer();
    /** @type {string} */
    this.id = null
    /** @type {string[]} */
    this.log = [];
    this.name = name;
    this.canConnect = true
    // Handlers process the two deck-ceremony messages after they arrive.
    this.reliableMessageHandlers = new Map();
    // Outgoing messages stay here until the intended peer acknowledges them.
    this.pendingReliableMessages = new Map();
    // Remember received transfer IDs so retries are acknowledged but not processed twice.
    this.receivedReliableMessages = new Set();
    // Add a local counter to the sender ID and timestamp to distinguish transfers.
    this.reliableMessageCounter = 0;
    

    this.initialize(); // call the initialize method to set up event listeners
  }

  initialize() {
    // set up event listeners for incoming connections
    this.peer.on('open', (id) => {
        this.id = id;
        this.logMessage("INFO", `Peer initialized with id: ${id}`, "System");
    });
    this.peer.on('connection', (conn) => {
      if (!this.canConnect){
        conn.close()
        return
      }
      const peer_id = conn.peer;
      this.peer_ids.push(peer_id);
      this.peerConnections[peer_id] = conn;
      this.lastSeen[peer_id] = Date.now();  
      this.logMessage("INFO", `Connected to peer ${peer_id}`, "System");

      // set up event listener for incoming messages from this peer
      conn.on('data', (data) => {
        console.log(`Received message from ${peer_id}:`, data);
        this.receiveMessage({...data, from: peer_id});
      });

      conn.on('open', () => {
        
        this.relayPeers();

        this.sendName(peer_id, this.name);
      })
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
      this.receiveMessage({...data, from: peer_id});
    });

    conn.on('open', () => {
      // send our name to the new peer
      this.sendName(peer_id, this.name);
    })

    // Guests connect to the room host first, so this identifies that host as leader.
    // This is only a simple initial leader choice; it does not elect a replacement.
    if (this.leader === null) {
      this.leader = peer_id;
      this.logMessage("INFO", `Set leader to ${peer_id}`, "System");
    }
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
            .send({type: "message", message: message});
  }
  
  sendToAll(message) {
    this.logMessage("MESSAGE", message, this.id);

    for (const peer_id of this.peer_ids) {
      this.sendMessage(peer_id, message);
    }
  }

  registerReliableMessageHandler(type, handler) {
    if (type !== "deck_order" && type !== "deck_forward") {
      throw new TypeError(`Unsupported reliable message type: ${type}`);
    }
    this.reliableMessageHandlers.set(type, handler);
  }

  /**
   * Send a deck-ceremony message and wait for the receiving peer to acknowledge it.
   * Retries use the same transfer ID so the receiver can recognize duplicates.
   * @param {string} peer_id
   * @param {"deck_order"|"deck_forward"} type
   * @param {Object} payload
   * @returns {Promise<void>}
   */
  sendReliableMessage(peer_id, type, payload) {
    if (type !== "deck_order" && type !== "deck_forward") {
      return Promise.reject(new TypeError(`Unsupported reliable message type: ${type}`));
    }

    const connection = this.peerConnections[peer_id];
    if (!connection) {
      return Promise.reject(new Error(`Not connected to peer ${peer_id}`));
    }

    const transferId = `${this.id}-${Date.now()}-${++this.reliableMessageCounter}`;
    const message = { ...payload, type, transferId };

    return new Promise((resolve, reject) => {
      // Keep the message and its promise callbacks until an ACK arrives or retries run out.
      const pending = { peer_id, message, resolve, reject, attempts: 0, timer: null };
      this.pendingReliableMessages.set(transferId, pending);

      const transmit = () => {
        try {
          pending.attempts += 1;
          connection.send(message);
          // A synchronous/in-memory receiver may already have acknowledged during send().
          if (!this.pendingReliableMessages.has(transferId)) return;
          pending.timer = setTimeout(() => {
            if (pending.attempts >= 4) {
              this.pendingReliableMessages.delete(transferId);
              reject(new Error(`No acknowledgement from peer ${peer_id} for ${type}`));
              return;
            }
            transmit();
          }, 1000);
        } catch (error) {
          clearTimeout(pending.timer);
          this.pendingReliableMessages.delete(transferId);
          reject(error);
        }
      };

      transmit();
    });
  }

  /**
   * Acknowledge every delivery, including retries, but run the handler only once.
   * The ACK means the message was received; the handler may continue processing afterward.
   * @param {Object} message
   */
  receiveReliableMessage(message) {
    if (typeof message.transferId !== "string") {
      this.logMessage("ERROR", `Missing transfer ID for ${message.type}`, "System");
      return;
    }

    const receivedKey = `${message.from}:${message.transferId}`;
    const connection = this.peerConnections[message.from];
    if (!connection) {
      this.logMessage("ERROR", `No connection to acknowledge peer ${message.from}`, "System");
      return;
    }

    try {
      connection.send({ type: "deck_ack", transferId: message.transferId });
    } catch (error) {
      this.logMessage("ERROR", `Could not acknowledge ${message.type}: ${error.message || error}`, "System");
    }
    // If an ACK was lost, the sender retries; do not apply the same deck layer twice.
    if (this.receivedReliableMessages.has(receivedKey)) return;
    this.receivedReliableMessages.add(receivedKey);

    const handler = this.reliableMessageHandlers.get(message.type);
    if (!handler) {
      this.logMessage("ERROR", `No handler registered for ${message.type}`, "System");
      return;
    }

    try {
      Promise.resolve(handler(message, message.from)).catch((error) => {
        this.logMessage("ERROR", `Failed to process ${message.type}: ${error.message || error}`, "System");
      });
    } catch (error) {
      this.logMessage("ERROR", `Failed to process ${message.type}: ${error.message || error}`, "System");
    }
  }

  /**
   * @param {string} peer_id
   * @returns {void}
   */
  heartbeat(peer_id) {
    this.peerConnections[peer_id]
            .send({type: "heartbeat"});
  }

  /**
   * @description Relay the list of connected peers to all connected peers
   * @returns {void}
   */
  relayPeers() {
    for (const peer_id of this.peer_ids) {
      this.peerConnections[peer_id]
            .send({type: "peers", peers: this.peer_ids, names: this.peerNames});
    }
  }

  closeConnections(from){
    if(from == this.leader) this.canConnect = false
  }

  updateName(peer_id, name) {
    this.peerNames[peer_id] = name;
  }
  sendName(peer_id, name) {
    this.peerConnections[peer_id]
            .send({type: "nameChange", name: name});
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
        break;
      case "heartbeat":
        break;
      case "deck_order":
      case "deck_forward":
        this.receiveReliableMessage(message);
        break;
      case "deck_ack": {
        // Only the peer we sent this transfer to may complete its pending send.
        const pending = this.pendingReliableMessages.get(message.transferId);
        if (pending && pending.peer_id === message.from) {
          clearTimeout(pending.timer);
          this.pendingReliableMessages.delete(message.transferId);
          pending.resolve();
        }
        break;
      }
      case "nameChange":
        this.updateName(message.from, message.name);
        this.logMessage("INFO", `Peer ${message.from} changed name to ${message.name}`, "System");
        break;
      case "closeConnections":
        this.closeConnections(message.from)
        break;
      case "request_peers":
        // A peer is requesting the list of peers
        this.peerConnections[message.from]
            .send({type: "peers", peers: this.peer_ids, names: {...this.peerNames, [this.id]: this.name}});
        break;
      case "peers":
        // A list of peers that host has
        if (Array.isArray(message.peers)) {
          console.log(`Received peers list: ${message.peers.join(", ")}`);
          for (const peer_id of message.peers) {
            if (!this.peer_ids.includes(peer_id) && peer_id !== this.id) {
              this.connectToPeer(peer_id);
            }
            if (message.names && message.names[peer_id]) {
              this.updateName(peer_id, message.names[peer_id]);
            }
          }
        }
        break;
      default:
        this.logMessage("ERROR", `Unknown message type: ${message.type}`, "System");
    }
    if (message.from) this.lastSeen[message.from] = Date.now();



 }
}
