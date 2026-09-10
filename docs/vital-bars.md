# HP Bar, SP Bar, and Guild Resource panels

The Vitals panel shows every bar the server sends (HP, SP, Move, Level, Carry)
in one card. The HP Bar and SP Bar panels are free-standing copies of the two
that matter in a fight: one bar each, floating by default, movable and
resizable like any workspace window, so a player can park a large health or
spell-point readout wherever they look most.

Open them from the Panels menu (Character group), or from the panel sheet on a
narrow screen. They open floating in the bottom-left corner, stacked; when the
rails are off and the terminal is docked they split under the terminal
instead. Their placement is saved with the workspace like every other panel.

The bar fills the panel and the text scales with its height, hiding the
percentage and then the label as the panel gets narrow. HP at or below 30%
pulses (not under reduced motion). Colours follow the shared vitals scale:
green above 60%, amber above 30%, red below.

Both read `Char.Vitals`. HP is `hp`/`maxhp` (or the legacy `mhp`); SP is
`sp`/`maxsp`, falling back to the `mana` and `mp` spellings. A vital the server
has not sent shows as `--` rather than as zero.

## Guild Resource slots

Guild resources (vitae, prowess, wrath, heat...) arrive in
`Darkwind.GuildVitals` as items with a stable `id`, a display `label`, a
`guild`, and a `kind`; the meter kinds (`meter`, `meter_reverse`, and the v1
`warning`) are bars. The client knows no guild by name, so instead of one menu
entry per guild there are three Guild Resource panels, each a slot:

- By default slot N shows the Nth meter in the current guild vitals, using the
  item's own label, so an alt in another guild sees that guild's resources
  with no setup.
- A dropdown in the panel's corner (visible on hover or focus) lists the meters
  currently on offer, grouped by guild when more than one guild's meters are
  present; choosing one pins the slot to that item id. If the pinned item is
  missing from a later snapshot the slot falls back to its positional default,
  the dropdown shows the id as "not present", and the tooltip says so.
  "Automatic" clears the pin.
- Pins are a panel preference, saved per character in local storage under
  `darkflow-guild-bars:<characterProfileId>` as `{ pins: { "1": "<id>" } }`,
  like the Command Board's column count.
- Reverse (danger-when-full) meters use the inverted colour scale and pulse at
  85% or more; normal meters pulse at 30% or less. `street_samurai.heat` keeps
  its heat ramp.
## Buff Bar

The Buffs panel lists every active defence with its time left. The Buff Bar
is one floating bar for one of them, with a dropdown in its corner (visible
on hover or focus) listing the buffs active right now. Automatic shows the
timed buff closest to running out; pinning a name keeps the bar on that
buff, and when it drops the bar shows empty under that name ("not active")
so the gap is visible at a glance. The pin is saved per character under
`darkflow-buff-bar:<characterProfileId>` as `{ pin: "<name>" }`.

The fill drains from the buff's `duration` down to nothing, counting from the
`remaining` the server sent when the entry arrived (`Char.Defences.List` and
`Add` each replace the entry, so a refreshed `remaining` restarts the count).
Buffs turn amber under a quarter left and red under a tenth, where the bar
pulses; debuffs are red and pulse while they last; untimed buffs show full
with "active". `client/workspace/buff-bar.ts` holds the reading and pin
helpers and `BuffBarPanel.svelte` the panel; WorkspaceHost lists it with the
other vital bars.
## Wiring

`client/workspace/vital-bar.ts` is the pure part: which fields a bar reads and
what it shows (`vitalReading`), plus the panel ids (`hpBar`, `spBar`).
`VitalBarPanel.svelte` renders one bar from `session.information`, and
`GuildBarPanel.svelte` one guild meter with its dropdown (`guildBarReading`,
`guildMeters`, `loadGuildBarPins`, `saveGuildBarPin`); WorkspaceHost
registers both panels, adds them to the Character menu group, the sheet, and
the restore list, and places them when opened.
