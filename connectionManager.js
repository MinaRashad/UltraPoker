class PeerConnectionManager {
  /**
   * 
   * @param {string|null} name 
   */
  constructor(name=null) {

    /** @type {string[]} */
    this.peer_ids = [];

    /** @type {Record<string, {send: (data: string) => void}>} */
    this.peerConnections = {};

    /** @type {Record<string, string>} */
    this.peerNames = {};

    /** @type {Record<string, number>} */
    this.lastSeen = {};

    /** @type {Peer} */
    this.peer = new Peer();

    /** @type {string} */
    this.id = null

    /**
     * @type {string[]}
     */
    this.log = [];

    this.name = name;
    

    this.initialize(); // call the initialize method to set up event listeners
  }

  initialize() {
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
      case "nameChange":
        this.updateName(message.from, message.name);
        this.logMessage("INFO", `Peer ${message.from} changed name to ${message.name}`, "System");
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