# Auto-Angler

The Auto-Angler plays Darkwind's fishing mini-game unattended. It lives in
`client/runtime/fishing-auto.ts` (the session runtime: loop, timers,
persistence, slash command) and `public/js/fishing-auto-core.mjs` (pure
decision logic, unit-tested). The Fishing panel carries its controls. The
protocol it drives is in `gmcp-darkwind-fishing.md`.

## Using it

| Command | Effect |
| --- | --- |
| `/autofish on` | Start. If no session is open it sends `fish`; otherwise it takes over the session at whatever phase it is in. |
| `/autofish off` | Stop and hand control back. The session stays open. |
| `/autofish` | Print status: on/off, panel phase, fish landed and lost (by cause), cycles, cast power, and why the last run stopped. |
| `/autofish power <0-100>` | Pin the cast power. |
| `/autofish power auto` | Return to the adaptive cast power. |

The Fishing panel has the same on/off control as an `Auto: OFF` / `Auto: ON`
button under the stage. While the addon is on, the stage carries an accent
border and an `AUTO` badge, and the status line shows the run counters.
Any click, tap, or Space press on the stage, and closing the panel, stop
the addon immediately with the reason "You took over."

## The loop

1. A baited session opens: charge a cast and release it when the live
   power meter reads the target, jittered by two points. The cast goes out
   through the same code a manual cast uses.
2. A bite: hook after a human-shaped delay of 180 to 550 ms, never under
   150 ms, and never past 60% of the server's window.
3. The fight: the controller drives the existing simulation with a lagged,
   velocity-projected steering rule, a tension guard that always wins, and
   deliberate drop-offs that keep the reported accuracy off 1.0.
4. The server's verdict (Caught or Escaped): update the counters and the
   adaptive power, wait 1.2 to 2.6 s, send `bait hook`, then `fish`.
5. If the session then opens unbaited again, there was no bait to apply: the
   run stops with "Out of bait."

Every command the addon sends is echoed to the output window.

## Halting

The run stops, and says why in the output window and the panel, when:

- bait runs out (one failed `bait hook` cycle);
- the server ends the session, the panel is closed, or the connection
  drops (a dead session nonce is never restarted into);
- the player touches the panel;
- a fight arrives with parameters the controller cannot model.

There is no catch limit or failure circuit breaker (PRD 9.1). A fish the
current skill cannot land will keep costing bait until it is gone, with
the adaptive power backing off eight points per escape.

## Adaptive cast power

Power starts at 55, rises two points on a server-confirmed catch, falls
eight on a snap or slack, and is clamped to 25..95. Timeouts and
implausible rejections leave it alone: neither says anything about the
fish. The +2 step is a deliberate deviation from the PRD's +5, which would
settle the policy at a 62% land rate against its own 80% target; +2/-8
settles at 80%.

## Settings

Persisted per character in local storage under
`darkflow-autofish:<characterProfileId>` as one record:

| Field | Meaning |
| --- | --- |
| `enabled` | Whether the addon was on when the client last ran. |
| `castPower` | The adaptive power, 25..95. |
| `powerOverride` | The pinned power, or null for adaptive. |

A restored "on" comes back armed but does not send `fish` by itself: at
startup the socket sits at the login prompt, where `fish` would be typed
as a character name. The armed addon takes over as soon as a fishing
session opens.

## Wiring

The runtime is created per session (`session.fishingAuto`) and follows the
server's side of the game through the session's fishing snapshot: a new
Open, Bite, Fight, Caught, Escaped, or End drives the loop, and a lost
connection halts it. It sends casts and hooks through the same interactions
runtime the panel uses, and `fish` and `bait hook` through the transport
as commands, echoed to the terminal.

The panel's part is small: it mirrors the addon's actions on the stage
(`cast-begin`, `cast`, `hook`), asks `resolveHeld()` for the held state
each simulation frame while the addon is on, reports the end of a fight
through `notifyFightEnd()`, and calls `notifyManualInput()` on any
deliberate press or when the panel is closed. `/autofish` is answered in
the terminal automation layer before the alias engine sees the line.
