# Darkwind.Combat GMCP Protocol

`Darkwind.Combat 1` carries recipient-safe combat presentation data for
Darkflow's visual Combat pane. It complements the standard `Char` packages; it
does not replace combat authority or provide a second set of hit points.

The client advertises `Darkwind.Combat 1` only when the visual combat manager
and renderer are available. The server does not advertise this package back to
the client.

## Messages

| Message | Direction | Purpose |
| --- | --- | --- |
| `Darkwind.Combat.State` | Server -> Client | Recoverable encounter lifecycle and actor snapshot |
| `Darkwind.Combat.Events` | Server -> Client | Ordered, bounded batches of transient outcomes |
| `Darkwind.Combat.Resync` | Client -> Server | Request current state without replaying stale effects |

## Readiness And Text Fallback

Advertising the package is necessary but is not permission to suppress combat
text. Darkflow also sends a fresh, explicit client subscription:

```json
{
  "features": {
    "combatPane": true
  }
}
```

`combatPane: true` means that the renderer is initialized and the only visual
combat surface is visible and able to present events. Darkflow sends
`combatPane: false` when that surface is closed, hidden, collapsed, disabled
by Zork-only mode, disconnected, or unable to render.

The server suppresses a routine swing for one recipient only after accepting
its corresponding event and only when every server-side eligibility gate
passes. Missing capability, stale or absent readiness, screenreader mode,
channel filters, queue failure, reconnect, and the operator kill switch all
fail open to the existing terminal text.

To bootstrap a hidden pane without creating a readiness deadlock, the server
may send an active State with `visual_enabled: true` and `effective: false`.
Darkflow opens the pane without stealing command focus, sends
`combatPane: true`, and requests a Resync. The swing that triggered that
bootstrap still appears as terminal text; suppression can begin only after the
fresh readiness update succeeds.

## `Darkwind.Combat.State`

State is a recoverable snapshot, not an animation command:

```json
{
  "epoch": "connection-7",
  "encounter_id": "encounter-12",
  "seq": 17,
  "visual_enabled": true,
  "effective": true,
  "active": true,
  "current_actor_id": "self",
  "current_target_id": "actor-2",
  "actors": [
    { "id": "self", "name": "Acer", "role": "self" },
    { "id": "actor-2", "name": "an ash drake", "role": "target" }
  ],
  "outcome": "",
  "summary": "Combat begins against an ash drake."
}
```

| Field | Notes |
| --- | --- |
| `epoch` | Opaque connection epoch. A change invalidates all earlier encounter and event data. |
| `encounter_id` | Opaque, session-scoped encounter identity. It changes for a new target object even when the display name is unchanged. |
| `seq` | Latest sequence covered by the snapshot. |
| `visual_enabled` | Saved character preference from `combatbrief visual`. |
| `effective` | Whether guarded visual presentation is currently effective. |
| `active` | Whether an encounter is active. |
| `current_actor_id` | Actor id staged on the left side. It is `self` while the recipient is fighting; a passive observer receives the stable identity of the actual combatant instead. |
| `current_target_id` | Actor id staged on the right side opposite `current_actor_id`. An observed pair retains the same orientation when its attack direction reverses. |
| `actors` | Recipient-safe roster. IDs never expose LPC object paths. |
| `outcome` | Empty while active; final values may include `victory`, `defeat`, `fled`, `target-lost`, or `disconnected`. |
| `summary` | Short accessible lifecycle summary. |

In observed group combat, the server may update `current_actor_id` as another
player acts against the same right-side focus without changing
`encounter_id`. This preserves pane position, history, and manual-close state
instead of presenting every group swing as a new encounter.

When `current_actor_id` is `self`, `Char.Vitals` remains authoritative for
player HP, `Char.Enemy` remains authoritative for the current target's HP,
condition, and art, and `Darkwind.Char.Avatar` remains authoritative for
player art. The sticky `Char.Status` snapshot supplies the recipient's race,
class, and gender as descriptor text under the player token, and maps that
race and gender pair to the bundled portrait used only while no avatar URL
is available or the generated portrait fails to load. A passive observer must not reuse those recipient-private
snapshots for somebody else's fight: actor names come from the State roster,
while health and art remain unavailable or use non-private placeholders.
Additional actor entries are compact context or threat indicators, not a
private-stat feed.

## `Darkwind.Combat.Events`

Events are transient and arrive in ordered, bounded batches:

```json
{
  "epoch": "connection-7",
  "encounter_id": "encounter-12",
  "first_seq": 18,
  "last_seq": 20,
  "events": [
    {
      "seq": 18,
      "kind": "attack",
      "perspective": "outgoing",
      "actor_id": "self",
      "target_id": "actor-2",
      "result": "critical",
      "damage": 42,
      "absorbed": 3,
      "summary": "You critically hit an ash drake for 42 damage."
    }
  ],
  "overflow": {
    "omitted": 0,
    "hits": 0,
    "damage": 0
  }
}
```

Version 1 uses `kind: "attack"` and the results `hit`, `critical`, `miss`,
`dodge`, and `absorb`. `perspective` is `outgoing`, `incoming`, or
`observed`. Numeric fields and numeric wording are omitted when the player's
existing `combatbrief damage` toggle is off.

Darkflow rejects events from an older epoch or encounter, ignores duplicate or
out-of-order sequence numbers, and bounds its presentation history. Overflow
is summarized instead of expanding into another combat log. Current HP and
State snapshots take priority over cosmetic event playback.

## `Darkwind.Combat.Resync`

Direction: `Client -> Server`

```text
Darkwind.Combat.Resync
```

An empty object is also valid:

```text
Darkwind.Combat.Resync {}
```

The server replies with the current `Darkwind.Combat.State` and refreshes the
authoritative `Char.Vitals`, `Char.Enemy`, and player-avatar snapshots. It does
not replay old attack animations. Darkflow requests this after reopening the
pane during an encounter and as part of a full handshake/subscription refresh.

## Pane And Accessibility Behavior

The existing `enemy` panel id is retained. When visual combat is inactive it
uses the compact Enemy renderer; an active visual State changes its title and
renderer to Combat. On desktop, each encounter takes over that pane as an
expanded, centered floating window and keeps it above the other workspace
panes without stealing command focus. On mobile, it opens as the active Combat
sheet. The pane is hidden as soon as the encounter ends. Closing or collapsing
it during combat restores server text fallback without changing the saved
character preference.

Both health bars expose progressbar semantics. Server-provided summaries feed
a rate-limited polite live region. Reduced-motion mode removes lunges, shakes,
flashes, moving damage numbers, and crossfades while preserving static outcome
badges and summaries.

## Canvas Stage

When the browser provides a 2D canvas, the Combat pane draws its stage on a
canvas: a backdrop chosen from the room's canonical terrain tile, two
procedural fighter figures whose heads are the player and target portraits,
and per-event effects (lunge,
slash arcs and burst for `hit`/`critical`, a whiff arc for `miss`, a sidestep
with afterimage for `dodge`, and a shield bubble for `absorb`). Damage numbers
and result badges are drawn on the canvas; names, health bars, condition text,
the current exchange, threats, history, and the live region stay in the DOM so
the accessibility contract above is unchanged.

The figures are drawn from a pose rig rather than image assets. The player's
wielded and worn items from `Char.Items` shape the figure: the main-hand
item's name picks the weapon (blade, knife, axe, blunt, polearm, staff, bow,
or bare hands when nothing is wielded), an off-hand item is drawn in the
left hand, a shield rides the left forearm, head armor draws a helmet, and
body armor thickens the torso. Weapon kind is a keyword heuristic over the
item name because the protocol carries no weapon type; an unrecognized name,
or no inventory yet, falls back to the guild's weapon. Race scales the body,
and NPC targets use a hunched beast form. Each event blends the actor
through windup and strike poses and the victim through recoil, dodge, or guard
poses; bows and staves add a projectile between the figures. Pose names are
the seam for future sprite sheets.

Bodies are shaded shapes rather than strokes: tapered limbs with an outline
and a shade band, a torso that is wider at the shoulders than the hips, boots,
hands, a belt, a cloak on humanoids and a tail on beasts that lag the body by
a spring. Legs are solved by inverse kinematics toward planted feet, so a
lunge moves the body while the rear foot stays put. Strikes anticipate, snap,
and hold; a landed blow freezes both figures for a beat (hit-stop), squashes
the victim, stretches the striker, draws a smear behind a melee swing, and
kicks dust at the victim's feet. Reduced motion removes all of it and leaves
the figures at rest.

When a sprite sheet is shipped for a figure kind (see
[combat-sprites.md](combat-sprites.md)), it replaces the procedural body
while weapons, shield, helmet, cloak, and the portrait head keep drawing on
top. A missing or invalid sheet falls back to the rig.

The stage plays each accepted event once, keyed by `seq` within the epoch and
encounter, and ignores repeated publishes of the same beat. Portraits come from
`Darkwind.Char.Avatar` and `Char.Enemy`; a failed image falls back to the
bundled player or NPC placeholder. The frame loop stops when the pane is
hidden, the tab is not visible, the encounter ends and no effect is still
playing, or the canvas leaves the document. Without canvas support the pane
renders the DOM card stage instead; readiness reporting is identical in both
modes.
