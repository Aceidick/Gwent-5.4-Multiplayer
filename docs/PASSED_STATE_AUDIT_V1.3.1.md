# Passed-State Audit v1.3.1

Covers all lifecycle transitions that mutate the passed flag:
`Player.setPassed`, `Player.passRound`, `Player.endRound`, round
normalization at `startRound`, forfeit, and rematch. `setPassed()` is
idempotent and forces the DOM badge to match the model every time.
