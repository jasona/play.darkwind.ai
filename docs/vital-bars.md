# HP Bar and SP Bar panels

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

## Wiring

`client/workspace/vital-bar.ts` is the pure part: which fields a bar reads and
what it shows (`vitalReading`), plus the panel ids (`hpBar`, `spBar`).
`VitalBarPanel.svelte` renders one bar from `session.information`; WorkspaceHost
registers both panels, adds them to the Character menu group, the sheet, and
the restore list, and places them when opened.
