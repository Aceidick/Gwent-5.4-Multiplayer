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

# Proxmox / LXC start

This build uses ONE port for both the website and online multiplayer.

```bash
cd /srv/gwent-classic-v5-online-complete
npm install
npm start
```

Open `http://LXC-IP:8080/` from both players.

The browser automatically connects its WebSocket to the same host and port.
No separate port 8765 is required.

Check the listener with:

```bash
ss -lntp | grep :8080
```

A successful Create Room also prints `room-created code=.....` in the npm start console.


## v1.0.3 rematch note

Online rematches use the same room and the same `/ws` connection on port 8080. The Replay button is a mutual ready-up; a fresh match starts only after both players choose Replay. This prevents each browser from starting an independent second game.


## v1.0.4 forfeit fix
Online **Give up** is synchronized to both clients. Both browsers now enter the end screen and may use Customize or the synchronized Replay flow.


## v1.1.0 rematch/new-match reset fix

Every online match now starts with a full `Game.reset()` and the host sends an authoritative host/guest opening-player role. This fixes second games/rematches after Give up or Customize where both screens could wait for the opponent.


## v1.1.4 — Decoy / Spy turn transaction fix
Online Decoy resolution is now atomic. The selected unit is fully moved to the acting player's hand (with ownership explicitly assigned to that player), then the Decoy is placed, and only then is the turn ended. This prevents the stock v5 un-awaited `board.toHand()` race from leaving both clients waiting after using Decoy on a Spy.


## v1.1.6 — Authoritative turn commit / Spy-Decoy diagnostics

Online turn boundaries now carry an explicit logical `nextRole` and monotonically increasing turn sequence. The acting peer is authoritative for the next host/guest role, so the two browsers no longer independently infer the next player after complex actions. Turn-state waits now time out with a concrete diagnostic instead of freezing indefinitely. Spy/Decoy transactions and action/turn commits are logged with sequence and logical role.

## v1.1.7 — Decoy duplicate-action fix

Fixed an online deadlock where selecting a Decoy target emitted both a generic `play` action and a `decoy` action for the same turn. The remote controller could consume the generic action and never execute the actual swap. Decoy row selection now suppresses the preliminary `play`, and the receiver defensively ignores such legacy packets while waiting for the target-bearing `decoy` action.

## v1.2.4-base-v1.1.7 — Mulligan + board settle fix

This build is based directly on v1.1.7. The music changes from v1.1.8 and v1.1.9 are intentionally NOT included.

- Clears stale Carousel/UI state at every online match boundary so opening redraw remains clickable after rematches/customization.
- Clears any stale carousel again immediately before the local opening mulligan.
- Adds a 2.2 second public-board settle window before a blocking turn-state desync. A mismatch that persists still stops the match.
- Adds `mulligan:open`, `mulligan:done`, `sync:settle-wait`, and `sync:settle-ok` client traces for diagnosis.


## v1.3.4 passed-state audit
- `Player.setPassed()` is now idempotent and forces the DOM badge to match the model every time.
- Removed unsafe reset paths that assigned `.passed = false` before calling `setPassed(false)`.
- Audited pass/reset/round-end/rematch/forfeit paths for state/UI divergence.
