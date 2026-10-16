# Network Architecture

The network is a peer to peer fully connected mesh network.

Every peer is an independent node in a mesh network. Each peer connect to every other peer. The first peer we are connected to is the leader. This is usually not a good idea but we need a way to get a leader before we are connected to everyone. Since the leader is the one who created the room, Typically, everyone will connect to them. 

**Potential Issues**: 
1) Someone might connect to another peer intentionally, however, this isnt a big deal because it will affect them only.
2) If the leader disconnects, we need to elect a new leader. This is not implemented yet. We will need to implement a heartbeat system to check if the leader is still alive and if not, elect a new leader.

# Game State Management

Once there are enough peers, the leader will start the game. Once the game is started, the leader will send a message that tells other peers so that they do not accept new connections. 

## Game State Synchronization

The game state consists of the following:
1) The deck of cards: This needs to be shuffled and Encrypted by all players so that no one knows the order of the cards. 
2) The order of the players: This is determined by the leader. The leader shuffles the list of players and sends it to everyone. This list is important because with it and the encrypted deck, everyone can determine the order of the cards and who has which cards.

Now since each peer will encrypt the deck, if a peer needs to know what a card is, they need to ask all other peers to decrypt it. Since each peer has the state of the game, they know which cards are in play and which cards are in the player hands. So if it was asked, it can determine if the peer is allowed to know what the card is.
