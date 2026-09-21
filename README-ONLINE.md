# v1.4.4 — Falske desync-stop i Player vs Friend rettet

Se `docs/PVP_DESYNC_FIX_V1.4.4_DA.md`. Bevar serverens eksisterende `img`-mappe.

---

# v1.4.3 — Audit af spillets valgforløb

Se `docs/CHOICE_AUDIT_V1.4.3_DA.md`. Bevar serverens eksisterende `img`-mappe.

---

# v1.4.2 — Klikadgang på slutskærmen

Se `docs/ENDSCREEN_FIX_V1.4.2_DA.md`. Bevar serverens eksisterende `img`-mappe.

---

# v1.4.1 — Rettelse af låst betjening efter lederhandlinger

Se `docs/INPUT_FIX_V1.4.1_DA.md`. Opdater serverfilerne og genindlæs siden hos begge spillere. Bevar serverens eksisterende `img`-mappe.

---

# v1.4.0 — Fælles audit af valg og multiplayer

Se `docs/AUDIT_V1.4.0_DA.md` for fejlårsag, rettelser, testdækning og installation. Begge spillere skal genindlæse siden efter opdateringen; v1.4.0 ændrer valgprotokollen. Serverens eksisterende `img`-mappe bevares.

---

> **v1.3.9 note:** Built directly from v1.3.8. Full continuation/multi-stage ability audit: destination choices are now awaited and decision-owner scoped, Emhyr Invader resolves both restored cards inside one atomic leader action, leader preview carousels are local-only, and audited detached async card moves are awaited.

> **v1.3.8 note:** Built directly from v1.3.6. Full multi-select carousel audit: selected cards are visibly consumed one-by-one using stable card identities; actions commit deterministically when the selection closes; the remote peer batches the same transaction until `choice-end`. v1.3.6 decision-sync, v1.3.5 round-transition fixes, v1.3.4 mouse-wheel navigation, and the working relay/domain behavior are preserved.

> **v1.3.6 note:** Built directly from v1.3.5. Full decision-sync audit: deterministic per-effect decision IDs, 30s fail-fast timeouts for remote popup/carousel decisions, and detailed decision relay traces. This fixes the Monsters round-end retake deadlock exposed by v1.3.5 logs.

> **v1.3.6 note:** Built directly from v1.3.4 wheel-only. Full round-transition audit: awaited round cleanup/lifecycle chaining, deterministic round effect tracing, and peer barriers after round-end and round-start effects. Mouse-wheel navigation and the working v1.3.3 relay/domain behavior are preserved.


> **v1.3.6 note:** This release is built directly from v1.3.3 and only adds mouse-wheel navigation in card-selection carousels. Relay/WebSocket/domain behavior is unchanged from v1.3.3.
# v1.3.4 — passed-state audit

This build is cumulative from v1.3.0. It does not roll back to an older branch. The audit binds decisions to the owning player/effect, scopes all generic UI decisions with decision IDs, and resolves carousel cards by their real gameplay location rather than temporary-list indices. See `docs/FULL_MULTIPLAYER_AUDIT_V1.3.0.md`.

# v1.2.4 — stable role mapping fix (base v1.1.7)

Host/guest identity is now pinned directly to Player objects. Post-mulligan/private-zone synchronization validates role and faction before touching cards, preventing cross-faction reconciliation. Large private-zone dumps are console-only.

# v1.2.3 — leader decision ownership fix

Online round-start decisions such as Madman Lugos are now owned by the leader owner rather than by the round starter.


## v1.2.4-base-v1.1.7 — Ephemeral carousel sync fix

Filtered/random carousels now send the selected card's authoritative source zone. This fixes abilities such as Madman Lugos where each client could independently build a different two-card candidate list and then reject the peer's valid selection.

# Gwent Classic v5.0 — Online Multiplayer integration

This repository is built from the uploaded `ia2904/gwent-classic-v5.0` source and integrates a room-code WebSocket multiplayer layer inspired by `Wanesia/gwent-classic-multiplayer`.

## Important: restore `img/`
The v5.0 archive supplied for this build intentionally omitted the very large `img/` directory. Copy your original v5.0 `img` directory into the repository root before launching. All original image paths remain unchanged.

## Run locally
1. Install Node.js 18+.
2. In the repository root: `npm install`
3. Start relay + web server: `npm start`
4. Open `http://localhost:8080` in two browsers/devices.
5. Build/select a valid deck and choose **Online Multiplayer**.
6. One player creates a room. The other enters the 5-character room code.
7. Both press **Ready**. The host starts the synchronized match automatically.

The multiplayer relay uses the same HTTP server and port as the game, on the `/ws` WebSocket endpoint. For example, a game opened at `http://192.168.10.34:8080` connects to `ws://192.168.10.34:8080/ws`. For HTTPS, use the same host via `wss://.../ws`.

## Architecture
- `online-net.js`: WebSocket room protocol client.
- `online.js`: v5.0 integration, remote controller, role translation, mulligan/choice synchronization, seeded RNG.
- `server/server.js`: WebSocket relay server.
- Existing v5.0 game files remain the authoritative game engine.

## Compatibility note
v5.0 has a much larger card/ability set than the older multiplayer fork. This build synchronizes the common action paths (row play, special play through `UI.selectRow`, decoy, pass, leader, active faction ability, redraw and carousel choices) and deterministic random sources in the main game files. Very unusual abilities with bespoke popups, number inputs, drag/rearrangement, or asynchronous UI-specific decisions may still need an additional wire message if one is found to desync in testing.

## Proxmox LXC / LAN

The bundled server is single-port. It listens on `0.0.0.0:8080` by default and serves both the game and WebSocket multiplayer (`/ws`). Example: if the game is opened as `http://192.168.1.50:8080`, multiplayer connects to `ws://192.168.1.50:8080/ws`.

Required port from players to the LXC:

- TCP 8080 — game web server + WebSocket multiplayer

Check inside the LXC:

```bash
ss -lntp | grep ':8080'
```

For HTTPS deployments, use a reverse proxy and WSS. Browsers will block plain
`ws://` from a page loaded over `https://`.


## v0.5.0 engine fixes

- Online lobby keyboard input is isolated from v5 global shortcuts. Typing E/Q/X/Enter in the room-code UI can no longer start or control an offline match.
- Remote turns are now explicitly started by the v5 engine. `ControllerRemoteV5` remains a non-AI controller so special-card logic does not accidentally execute AI branches.
- Server log `peer-paired` means sockets are paired; `match-handshake` means both ready/deck handshake reached actual match startup.

## v1.0 synchronization architecture

v1.0 replaces several index-only lockstep assumptions with explicit synchronization barriers. Opening mulligan ends by exchanging exact hand/deck order, top-level actions include a private-zone snapshot, and every completed turn is checked with a logical host/guest state hash before the next turn starts.

Run `npm test` for the built-in syntax/protocol audit. On a Debian/Ubuntu LXC with Chromium installed, `npm run test:e2e` runs two independent browser contexts through Create/Join/Ready/mulligan/card play/turn transfer/pass.


## v1.0.2 sync-barrier fix
The blocking per-turn checksum now compares canonical gameplay state (turn owner, score, health, pass state, hand/deck counts, exact board card identities, row totals/specials, weather, leader/faction availability and round). Full hand/deck/grave ordering remains available as a non-blocking browser-console audit. A real mismatch now reports the first differing state path instead of only two hashes.


## v1.0.3 second-match / rematch turn fix

- Fixes the upstream v5.0 `Game.reset()` typo so `firstPlayer` is actually cleared.
- Every online `startMatch()` explicitly clears stale first/current-player references.
- Match ready state is cleared when a match starts/ends.
- End-screen **Replay** is now a synchronized rematch ready-up. It never starts a local-only replay.
- A rematch receives a fresh shared seed through the existing host/guest lobby-start handshake.

This specifically fixes the deadlock where, after finishing one online game, both screens could report that it was the opponent's turn in the next game.


## v1.0.4 forfeit fix
Online **Give up** is synchronized to both clients. Both browsers now enter the end screen and may use Customize or the synchronized Replay flow.


## v1.1.0 rematch/new-match reset fix

Every online match now starts with a full `Game.reset()` and the host sends an authoritative host/guest opening-player role. This fixes second games/rematches after Give up or Customize where both screens could wait for the opponent.


## v1.1.0 — Play vs Computer / Play vs Friend

The title screen now chooses the session type. **Play vs Computer** keeps the normal v5 AI deck-builder flow and hides multiplayer setup. **Play vs Friend** shows **Online Multiplayer** for room setup. Once both peers are in the same room, the deck-builder **Start game** button acts as Ready. After Customize, the room is preserved and both players can edit their decks and press Start game again without reopening the lobby.


## v1.1.1 — Firefox UI fixes

The landing labels are now **Play vs Computer** and **Player vs Friend**. The landing action stack no longer uses a negative margin that could place the first button under the GWENT title in Firefox. Export/Import and Save/Load are grouped with inline-flex layout so their spacing no longer depends on browser-specific font metrics.


## v1.1.2 — Ready after pairing

- Quick Match: both players can press Ready as soon as the relay has paired them.
- Join Room: the joining player's Ready button is enabled immediately after a successful join.
- The host still waits for the relay's `peer-joined` event, so Ready is never enabled before a real opponent is connected.

## v1.1.3 — Private-zone turn synchronization

The turn barrier now treats the owning browser as authoritative for private
hand/deck state. The acting player sends `actorState` with `turn-state`; the
peer reconciles the hidden remote replica before comparing public gameplay
state. This prevents false/repairable `handCount` or `deckCount` desync stops
while retaining strict checks for board, score, weather and turn ownership.


## v1.1.4 — Decoy / Spy turn transaction fix
Online Decoy resolution is now atomic. The selected unit is fully moved to the acting player's hand (with ownership explicitly assigned to that player), then the Decoy is placed, and only then is the turn ended. This prevents the stock v5 un-awaited `board.toHand()` race from leaving both clients waiting after using Decoy on a Spy.


## v1.1.6 — Authoritative turn commit / Spy-Decoy diagnostics

Online turn boundaries now carry an explicit logical `nextRole` and monotonically increasing turn sequence. The acting peer is authoritative for the next host/guest role, so the two browsers no longer independently infer the next player after complex actions. Turn-state waits now time out with a concrete diagnostic instead of freezing indefinitely. Spy/Decoy transactions and action/turn commits are logged with sequence and logical role.


## v1.1.6 Decoy trace
This diagnostic build logs client turn/Decoy stages to the relay terminal as `client-trace` and surfaces unhandled async errors instead of silently freezing.

## v1.1.7 — Decoy duplicate-action fix

Fixed an online deadlock where selecting a Decoy target emitted both a generic `play` action and a `decoy` action for the same turn. The remote controller could consume the generic action and never execute the actual swap. Decoy row selection now suppresses the preliminary `play`, and the receiver defensively ignores such legacy packets while waiting for the target-bearing `decoy` action.

## v1.2.4-base-v1.1.7 — Mulligan + board settle fix

This build is based directly on v1.1.7. The music changes from v1.1.8 and v1.1.9 are intentionally NOT included.

- Clears stale Carousel/UI state at every online match boundary so opening redraw remains clickable after rematches/customization.
- Clears any stale carousel again immediately before the local opening mulligan.
- Adds a 2.2 second public-board settle window before a blocking turn-state desync. A mismatch that persists still stops the match.
- Adds `mulligan:open`, `mulligan:done`, `sync:settle-wait`, and `sync:settle-ok` client traces for diagnosis.

## v1.2.4-base-v1.1.7
- Built from the v1.1.7 branch (no v1.1.8/v1.1.9 music changes).
- Carousel choices from a player's private hand/deck now carry an authoritative private-zone snapshot.
- The remote client reconciles that private replica before replaying the selected card.
- Duplicate-card occurrence drift falls back only when a card key is unique in the resolved container.
- Improved carousel desync diagnostics include logical container and remote card list.


## v1.3.4 passed-state audit
- `Player.setPassed()` is now idempotent and forces the DOM badge to match the model every time.
- Removed unsafe reset paths that assigned `.passed = false` before calling `setPassed(false)`.
- Audited pass/reset/round-end/rematch/forfeit paths for state/UI divergence.

## v1.3.4 opening mulligan audit

Opening redraw is now a first-class carousel mode rather than being inferred from UI title text. `startGame()` awaits mulligan completion, both online peers open their own redraw immediately, redraw packets are match-scoped, and special 3-card / 13-to-11 opening-hand cases are covered by the same barrier.

### v1.3.8 carousel commit audit
Multi-select carousels now retain ownership of `Carousel.curr` until every selected-card action has completed. Hiding the carousel no longer means the transaction is complete. This guarantees that online `choice-end` is emitted only after all choices have been sent and committed, prevents the next carousel from starting over a still-running hand/deck/grave mutation, and fixes private-zone mismatches seen with multi-stage leaders such as Eredin - Destroyer of Worlds.
