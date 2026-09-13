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

# Gwent Classic v5.0

A browser remake of the original Gwent minigame from The Witcher 3: Wild Hunt. <br/>Click [here](https://ia2904.github.io/Gwent-classic-v5.0/) to play.

Some factions adapt [Novigrad Tavern's](https://www.ebay.com/usr/novigrad_tavern) card designs (with some differences) but with a much deeper balance redesign. Card abilities have been tweaked to offer more complexity, and two brand-new factions have been added: Ofir and Novigrad.

## Screenshots
<img width="45%" alt="gameplay 1" src="https://github.com/user-attachments/assets/e5fa4ae3-f549-4eba-9549-e6803ac9e335" />
<img width="45%" alt="gameplay 2" src="https://github.com/user-attachments/assets/5f92f31a-58d3-43f0-8060-a8f7f3edfd74" />

## 🚀 Improvements

#### 🛡️ New Factions v5.0
* **Ofir:** This faction includes some card designs and abilities from [Novigrad Tavern](https://www.ebay.com/usr/novigrad_tavern) and [Gwent-electron](https://github.com/camerensmith/gwent-electron), sticking to character card designs based on The Witcher lore, specifically characters from the comic *The Witcher: Of Flesh and Flame*. Additionally, new abilities and various runes were incorporated that will make the gameplay more interesting.
* **Novigrad:** This faction is based on the great work of Gwent-electron, but changing or incorporating character cards from Novigrad and removing those that do not belong there. In addition, new abilities were added, and several mechanics from other factions were recycled and adapted for this deck. This completely reworks the visual identity of the deck with a curated list of high-quality character cards that strictly belong to the Novigrad lore.

#### 🛡️ Faction Identity Reworks
Addressed overlapping cards by giving each faction a unique and distinct gameplay identity:
* **Syndicate (The Gold, Hypocrisy & Crime Faction):** Focuses on criminals and corrupt religious zealots working from the shadows.
* **Novigrad (The Intellect, Resistance & Entertainment Faction):** Stripped of crime and religion, it highlights the wealthy bourgeoisie, outcast mages (Triss), dopplers (Dudu), and artists (Dandelion, Priscilla) uniting to resist the Syndicate and King Radovid.
* **Redania (The Iron & Oppression Faction):** Pure, ruthless state power and King Radovid V's unstoppable war machine, free from street and religious elements.

#### 🎨 Visuals & Customization
* **Custom Boards:** Designed new custom boards featuring an interactive **Board Selector**.
* **Interface Updates:** Changed the initial background image, added a custom Gwent logo, improved card borders, and fixed faction emblem displays.
* **Enhanced FX:** Added custom visual effects for Hero card activations and the *Clear Weather* card effect.

#### 🔊 Audio & Music
* **Local Player:** Replaced YouTube with a local music system and a shuffled skip-track button.
* **Game Audio:** Added original leader ability sound effects and integrated a coin-flip SFX.

#### 🔧 Fixes & Balance
* **Content Restored:** Recovered missing neutral cards and factions.
* **Board Reset:** Fixed the "Give Up" button to completely wipe the field and reset pending effects.
* **Bugs & Text:** Fixed multiple ability bugs and shortened text descriptions for faster reading.

#### 🎴 Deck Management
* **Internal Saving:** Added a local save/load system to store custom decks in-game without downloads.
* **Import/Export:** Fixed deck download errors on mobile devices and integrated a one-click copy-to-clipboard option.
* **Menu Cleanup:** Reorganized and streamlined the deck options menu layout.

#### 📱 Mobile & Responsive UI
* **Fully Responsive Experience:** Optimized all visual styles, layouts, and carousel positioning for mobile screens.
* **Vibration Mechanics:** Implemented vibration and a toggle switch to enable or disable it on mobile devices.
* **UI Scaling & Space:** Fixed card description styles and reduced text clutter to save screen space.
* **Android APK:** Included the standalone Android build in the **Releases** section.

### Operations included with the keyboard:
**"E"** starts the game<br />
**"X"** uses or modifies the leader card<br />
**"Q"** closes the card explanation windows<br />
**"Space"** passes the round<br />
**"Enter"** plays the cards<br />
**Arrows** select cards on the carousel


## v1.0.4 forfeit fix
Online **Give up** is synchronized to both clients. Both browsers now enter the end screen and may use Customize or the synchronized Replay flow.


## v1.1.0 rematch/new-match reset fix

Every online match now starts with a full `Game.reset()` and the host sends an authoritative host/guest opening-player role. This fixes second games/rematches after Give up or Customize where both screens could wait for the opponent.

## v1.1.1 Firefox UI fixes

The landing buttons are now labelled **Play vs Computer** and **Player vs Friend**. The landing layout no longer uses a negative margin that could place the first action underneath the GWENT title in Firefox. The deck-builder **Export / Import Deck** and **Save / Load Deck** controls now use grouped flow layout rather than separate absolute text offsets, improving Firefox/Chrome/Edge consistency.


## v1.1.2 — Ready after pairing

- Quick Match: both players can press Ready as soon as the relay has paired them.
- Join Room: the joining player's Ready button is enabled immediately after a successful join.
- The host still waits for the relay's `peer-joined` event, so Ready is never enabled before a real opponent is connected.

## v1.1.3 — Private-zone turn synchronization

Each player's browser is now authoritative for its own hand/deck.  At the end
of an online action the acting client sends a post-action private-zone snapshot,
and the peer refreshes its hidden replica before the public turn-state check.
Hand/deck counts are diagnostic rather than blocking invariants; board cards,
row scores, weather, pass state, round and turn ownership remain strict.


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


## v1.3.4 passed-state audit
- `Player.setPassed()` is now idempotent and forces the DOM badge to match the model every time.
- Removed unsafe reset paths that assigned `.passed = false` before calling `setPassed(false)`.
- Audited pass/reset/round-end/rematch/forfeit paths for state/UI divergence.
