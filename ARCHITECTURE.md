# UltraPoker Architecture

UltraPoker is a browser-based, peer-to-peer card-game prototype. The browser pages
compose three layers: `PeerConnectionManager` transports messages, `P2PEngine`
coordinates the generic encrypted deck, and `Poker` applies poker-specific card
ownership and reveal rules. The demo UI lives in `poker.html`.

## Components

### PeerConnectionManager (`connectionManager.js`)

- Creates a PeerJS identity and maintains direct peer connections.
- Sends ordinary game messages and routes named game messages to registered
  handlers.
- Provides acknowledged, retried delivery for the deck-ceremony messages.
- Tracks connected peers and relays discovered peer IDs.

It does not own card rules or decrypt cards. Deck protocol messages are routed
to the engine; `"Poker"` game messages are routed to the poker handler.

### P2PEngine (`Engine.js`)

- Holds the card definitions and a deck represented by numeric card IDs.
- Accepts a shared participant order with one leader at index `0`.
- Applies one shuffle and one XOR obfuscation layer per participant, in order.
- Keeps each participant's own key and shuffle permutation locally.
- Stores the final encrypted deck and supports removal of one participant's
  layer from a requested card.

The engine is game-agnostic. It does not decide who receives a private card or
when community cards are revealed. XOR is only a prototype obfuscation method;
it is not cryptographically secure.

### Poker (`Poker.js`)

- Associates the encrypted deck order with poker players.
- Assigns the first two cards per player in round-robin order; later positions
  are public cards.
- Allows a player to request only their own private cards. Public card requests
  can be made by any player.
- Requests each other participant's required layer, verifies incoming requests
  against the requester, card ownership, visibility, and layer order, then
  returns the transformed card value and its mapped position.
- Applies the requesting player's final private-key step locally for their own
  private card.

Poker does not reveal an entire encrypted deck. Reveal proceeds one card at a
time, removing the relevant participant layers while leaving the shared final
deck unchanged.

### Poker demo (`poker.html`)

- A room host shares their PeerJS ID; guests connect to that ID.
- The host starts the deck ceremony automatically when at least four peers
  (including the host) are connected.
- Each player reveals their own two private cards locally.
- The host advances the shared board through flop, turn, and river. Community
  card requests are processed by every participant, and the UI shows the
  revealed board.

The demo focuses on the deck and reveal flow. Betting actions, blinds, hand
ranking, showdown resolution, and pot settlement are not implemented.

## Deck ceremony

1. The host creates the participant order and sends it to every participant.
2. The host creates a numeric deck and applies its own shuffle and XOR layer.
3. Each next participant accepts the deck only from the preceding participant
   in the announced order, applies its own shuffle and XOR layer, then forwards
   the result.
4. The final participant returns the fully transformed deck to the host.
5. The host distributes that final encrypted deck to all participants.

Reliable deck messages carry a transfer ID. Receivers acknowledge a transfer
and avoid applying a retried transfer more than once. The acknowledgement
confirms receipt, not successful completion of game-level work.

## Card reveal

The final deck's array position identifies the dealt card, while the numeric
value at that position has had every participant's XOR layer applied. To reveal
a card, the requester follows the layers in reverse order:

1. The peer holding the next layer removes its own XOR key.
2. That peer maps the card position through its own shuffle permutation to the
   position in the previous layer.
3. The peer returns the resulting value and position to the requester.
4. For a private card, its owner removes their own final XOR key locally;
   other players never receive that final private value.

This is per-card processing. It does not restore or unshuffle the whole deck.
For public cards, every participant may contribute their layer, so the final
card value is visible to all participants.

## Current limitations

- The XOR layer is not secure encryption and the protocol is not resistant to
  malicious participants.
- The host is a single point of coordination; leader election and recovery after
  host disconnection are not implemented.
- Peer discovery and room membership are prototype-level and do not provide
  authenticated membership or consensus.
- Poker betting, blinds, turn enforcement, hand evaluation, and winner
  determination are future work.
