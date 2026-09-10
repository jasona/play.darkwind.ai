# DPS Meter

The DPS Meter is a client-side panel that reports how much damage the player
is dealing. It computes everything in the browser from the
[`Darkwind.Combat`](gmcp-darkwind-combat.md) event stream; the server needs no
changes and sends no DPS figures of its own.

Open it from the **Panels** menu under Character ("DPS Meter"). It is hidden by
default and its position, size, and visibility persist with the rest of the
workspace layout.

## What It Measures

The meter counts **outgoing** swings only, so it reports what the player deals
rather than what the group deals or what the player takes. Events arriving
with `perspective` of `incoming` or `observed` still advance the sequence
cursor, so a replayed batch cannot be counted twice, but they never reach a
tally.

| Figure | Meaning |
| --- | --- |
| Headline | The rolling ten second rate during a fight; the finished fight's rate when idle |
| Fight DPS | Encounter damage divided by the elapsed encounter |
| Peak | The highest rolling value the current encounter reached |
| Damage / Best hit | Encounter damage total and single largest hit |
| Swings / Hits / Crits / Missed | Encounter counts, with hit rate and crit rate |
| Absorbed | Damage the target's armor absorbed, reported separately from damage dealt |
| Session | Totals since connect or since the last **Reset session** |
| Recent fights | The last five encounters, newest first |

## Timing Rules

Timing is where a damage meter is easiest to get wrong, so the rules are
explicit:

- **The fight clock starts at the first outgoing swing**, not when the
  encounter id appears. A target acquired long before the first blow does not
  dilute the rate.
- **A fight runs until the frame that reports its outcome.** Ending it at the
  last swing instead would shorten the divisor and overstate DPS.
- **Session DPS divides by combat time, not wall clock.** Time spent walking,
  shopping, or idling is never in the divisor, so the session figure stays
  comparable to the per-fight one.
- **No rate is reported until a fight has run for a second.** A whole batch of
  swings can share one timestamp; dividing by that sliver would read as
  hundreds of thousands of DPS. Until then the meter shows `--`.
- **A fight that goes quiet for fifteen seconds is closed at its last swing.**
  If the server never sends the State frame that ends an encounter, this stops
  dead air from being billed to the session clock.

## Degraded Modes

The meter is deliberately independent of the visual combat pane. `Darkwind.Combat 1`
is advertised at handshake and the meter subscribes directly, so it keeps
working while the animated pane is closed, collapsed, or disabled. Note that
`combat-visual-core` drops events unless the saved `combatbrief visual`
preference is on; the meter does not share that gate.

Two cases are surfaced rather than guessed at:

- **Damage numbers off.** With `combatbrief damage` off the server omits every
  numeric field, so swings arrive with no damage attached. The meter detects a
  landed hit that carried no number, dashes out the damage figures, and says
  to turn them on. Swing and hit counts stay accurate and stay on screen. The
  check is scoped to the current fight, so turning the toggle off mid-session
  is reported on the very next encounter.
- **No State frame.** If events arrive for an encounter the meter has not seen
  a State frame for, it adopts the encounter from the event batch. The target
  name is unavailable in that case, but the numbers are not.

A new connection epoch clears every tally, since ids from an earlier
connection carry no meaning.

## Layout

- `public/js/dps-meter-core.mjs` -- pure, DOM-free reducers and the view
  selector. It reuses `normalizeCombatEvent` and `normalizeCombatState` from
  `combat-visual-core.mjs` so both consumers parse frames the same way.
- `client/runtime/dps.ts` -- the session-owned meter: subscribes to the
  three `Darkwind.Combat` packages on the session's GMCP bus, runs the one
  second tick that keeps a live fight moving between swings through the
  session's resource scope, closes the fight on disconnect, and publishes
  frozen view models. Every session has its own, so two connections never
  share a tally.
- `public/js/dps-panel-renderer.mjs` -- pure data-in, HTML-out rendering.
- `client/workspace/DpsPanel.svelte` -- mounts the renderer on the session's
  meter and passes its Reset button through to `session.dps.resetSession()`.

The meter is reachable from a running session as `session.dps`; the
workspace registers the panel under the id `dps` and lists it in the
Panels menu under Character.
