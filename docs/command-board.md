# Command Board

The Command Board is a workspace panel of player-defined buttons. Each button
sends one command line exactly as if it had been typed, so aliases, variables,
and slash commands all apply. A button can carry a keyboard shortcut that
works anywhere in the client while the panel is showing.

Open it from the Panels menu (System group). It docks under the terminal, or
floats when the terminal is floating.

## Editing

Press **Edit** in the panel. Each button becomes a small form with its label,
its command, and a shortcut control. **+ Add button** appends a blank button,
the arrows reorder, the cross removes, **Columns** sets the grid width, and
**Reset** restores the three starter buttons (look, inventory, score). Press
**Done** to return to the clickable board. Changes save as you make them.

## Shortcuts

Click a button's shortcut control, then press the key combination. Escape
clears it. A shortcut must include Ctrl, Alt, or Meta, or be a function or
numpad key, so that ordinary typing in the command line is never captured.
Shortcuts fire while the client window has focus, including while typing in
the command line, and are ignored inside dialogs. Combinations the browser
or operating system reserves (for example Ctrl+T or Alt+F4) may be taken
before the client sees them.

Shortcuts are stored by physical key (KeyboardEvent.code), so they stay on
the same key across keyboard layouts, and are shown as Alt+1, Ctrl+Shift+H,
F5, or Num 1.

## Storage

The board is saved per character in local storage under
`darkflow-command-board:<characterProfileId>` as one record: the column
count and the ordered buttons (id, label, command, shortcut). Up to 48
buttons; labels are capped at 40 characters and commands at 500.

## Wiring

`client/runtime/command-board.ts` owns the board (`session.commandBoard`):
the buttons, their normalisation and persistence, and the shortcut rules
(`shortcutFromEvent`, `normalizeShortcut`, `shortcutLabel`, `matchShortcut`).
`client/workspace/CommandBoardPanel.svelte` renders it, records shortcuts,
listens for them on the window in the capture phase, and sends commands
through `session.terminal.executeCommand`.
