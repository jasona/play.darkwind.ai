<script lang="ts">
  import { untrack } from "svelte";
  import type { Readable } from "svelte/store";
  import {
    COMMAND_BOARD_LIMITS,
    shortcutFromEvent,
    shortcutLabel,
    type CommandBoardButton,
    type CommandBoardSnapshot,
  } from "../runtime/command-board.ts";
  import type { Session } from "../runtime/session.ts";
  import type { PanelState } from "./workspace.ts";

  let { panelId, session }: { panelId: string; state: Readable<PanelState>; session?: Session } =
    $props();

  const resolvedSession = untrack(() => session);
  if (!resolvedSession) throw new Error("The Command Board requires a session");
  const activeSession: Session = resolvedSession;
  const board = activeSession.commandBoard;

  let root = $state<HTMLElement>();
  let snapshot = $state<CommandBoardSnapshot>(board.getSnapshot());
  let editing = $state(false);
  // The button whose shortcut is being recorded: the next key press sets it.
  let recordingId = $state<string | null>(null);
  // Buttons that just fired, for a short press highlight.
  let pressed = $state<Record<string, boolean>>({});
  // The character's own buttons, in their stored order; shared-set buttons
  // are shown but edited in Settings.
  const localIds = $derived(
    snapshot.buttons.filter((button) => button.source === "local").map((button) => button.id),
  );
  const visibleButtons = $derived(
    editing ? snapshot.buttons : snapshot.buttons.filter((button) => button.enabled),
  );
  const columnChoices = Array.from(
    { length: COMMAND_BOARD_LIMITS.maxColumns - COMMAND_BOARD_LIMITS.minColumns + 1 },
    (_, index) => COMMAND_BOARD_LIMITS.minColumns + index,
  );

  function fire(button: CommandBoardButton): void {
    if (!button.command) return;
    activeSession.terminal.executeCommand(button.command);
    pressed = { ...pressed, [button.id]: true };
    setTimeout(() => {
      const { [button.id]: _gone, ...rest } = pressed;
      pressed = rest;
    }, 160);
  }

  function press(button: CommandBoardButton): void {
    if (editing) return;
    fire(button);
  }

  function addButton(): void {
    board.addButton({ label: "Button " + (localIds.length + 1), command: "" });
  }

  function insideDialog(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const dialog = target.closest<HTMLElement>('dialog, [role="dialog"]');
    return dialog !== null && !dialog.classList.contains("dv-resize-container");
  }

  // Shortcuts fire anywhere in the client while this panel is showing. They
  // always carry a modifier or are function/numpad keys, so they cannot
  // collide with typing; the listener runs in the capture phase so a match
  // wins over the terminal's own key handling.
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (recordingId !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        board.updateButton(recordingId, { shortcut: "" });
        recordingId = null;
        return;
      }
      const shortcut = shortcutFromEvent(event);
      if (!shortcut) return;
      board.updateButton(recordingId, { shortcut });
      recordingId = null;
      return;
    }
    if (editing || event.repeat) return;
    if (!root || !root.isConnected || root.getClientRects().length === 0) return;
    if (insideDialog(event.target)) return;
    const hit = board.matchShortcut(event);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    fire(hit);
  }

  $effect(() => {
    const unsubscribe = board.subscribe((next) => {
      untrack(() => {
        snapshot = next;
        if (recordingId !== null && !next.buttons.some((button) => button.id === recordingId)) {
          recordingId = null;
        }
      });
    });
    window.addEventListener("keydown", onWindowKeydown, true);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", onWindowKeydown, true);
    };
  });
</script>

<section
  bind:this={root}
  class="command-board-panel"
  class:is-editing={editing}
  data-panel-id={panelId}
  data-workspace-owned="true"
  aria-label="Command Board"
>
  <div class="cboard-toolbar">
    <button
      type="button"
      class="cboard-tool"
      aria-pressed={editing}
      onclick={() => {
        editing = !editing;
        recordingId = null;
      }}
    >
      {editing ? "Done" : "Edit"}
    </button>
    {#if editing}
      <button
        type="button"
        class="cboard-tool"
        disabled={localIds.length >= COMMAND_BOARD_LIMITS.maxButtons}
        onclick={addButton}>+ Add button</button
      >
      <label class="cboard-columns">
        Columns
        <select
          value={snapshot.columns}
          onchange={(event) => board.setColumns(Number(event.currentTarget.value))}
        >
          {#each columnChoices as choice (choice)}
            <option value={choice}>{choice}</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        class="cboard-tool cboard-tool-quiet"
        title="Replace your own buttons with Look, Inventory, and Score"
        onclick={() => board.resetToDefaults()}
      >
        {localIds.length ? "Reset to starters" : "Add starter buttons"}
      </button>
    {:else if snapshot.buttons.some((button) => button.enabled && button.shortcut)}
      <span class="cboard-hint">Shortcuts work anywhere in the client.</span>
    {/if}
  </div>

  {#if visibleButtons.length === 0}
    <p class="cboard-empty">
      No buttons yet. {editing
        ? "Add one above, or add the starter buttons."
        : "Press Edit to add some, or manage them under Settings."}
    </p>
  {/if}

  <div
    class="cboard-grid"
    style:grid-template-columns={`repeat(${snapshot.columns}, minmax(0, 1fr))`}
  >
    {#each visibleButtons as button (button.id)}
      {#if editing && button.source !== "local"}
        <div class="cboard-editor cboard-editor-shared" class:is-disabled={!button.enabled}>
          <div class="cboard-shared-title">
            <span class="cboard-label">{button.label || button.command || "Untitled"}</span>
            <span class="cboard-badge">Shared set</span>
          </div>
          <code class="cboard-shared-command">{button.command}</code>
          <span class="cboard-shared-note">
            {button.shortcut ? shortcutLabel(button.shortcut) + ". " : ""}Edit in Settings.
          </span>
        </div>
      {:else if editing}
        <div
          class="cboard-editor"
          class:is-recording={recordingId === button.id}
          class:is-disabled={!button.enabled}
        >
          <input
            class="cboard-field"
            type="text"
            placeholder="Label"
            maxlength={COMMAND_BOARD_LIMITS.maxLabel}
            value={button.label}
            aria-label="Button label"
            oninput={(event) => board.updateButton(button.id, { label: event.currentTarget.value })}
          />
          <input
            class="cboard-field cboard-field-command"
            type="text"
            placeholder="Command, e.g. cast heal"
            maxlength={COMMAND_BOARD_LIMITS.maxCommand}
            value={button.command}
            aria-label="Command to send"
            spellcheck="false"
            oninput={(event) =>
              board.updateButton(button.id, { command: event.currentTarget.value })}
          />
          <button
            type="button"
            class="cboard-shortcut"
            aria-pressed={recordingId === button.id}
            title="Click, then press the key combination. Esc clears it."
            onclick={() => (recordingId = recordingId === button.id ? null : button.id)}
          >
            {#if recordingId === button.id}
              Press keys... (Esc clears)
            {:else if button.shortcut}
              {shortcutLabel(button.shortcut)}
            {:else}
              Set shortcut
            {/if}
          </button>
          <div class="cboard-editor-actions">
            <label
              class="cboard-enabled"
              title="Disabled buttons stay in the list but are hidden and never fire"
            >
              <input
                type="checkbox"
                checked={button.enabled}
                onchange={(event) =>
                  board.updateButton(button.id, { enabled: event.currentTarget.checked })}
              />
              On
            </label>
            <button
              type="button"
              class="cboard-tool cboard-tool-quiet"
              aria-label="Move earlier"
              disabled={localIds.indexOf(button.id) <= 0}
              onclick={() => board.moveButton(button.id, -1)}>&larr;</button
            >
            <button
              type="button"
              class="cboard-tool cboard-tool-quiet"
              aria-label="Move later"
              disabled={localIds.indexOf(button.id) === localIds.length - 1}
              onclick={() => board.moveButton(button.id, 1)}>&rarr;</button
            >
            <button
              type="button"
              class="cboard-tool cboard-tool-danger"
              aria-label="Remove button"
              onclick={() => board.removeButton(button.id)}>&#x2715;</button
            >
          </div>
        </div>
      {:else}
        <button
          type="button"
          class="cboard-btn"
          class:is-pressed={pressed[button.id]}
          disabled={!button.command}
          title={button.command || "No command set"}
          onclick={() => press(button)}
        >
          <span class="cboard-label">{button.label || button.command || "Untitled"}</span>
          {#if button.shortcut}<kbd class="cboard-kbd">{shortcutLabel(button.shortcut)}</kbd>{/if}
        </button>
      {/if}
    {/each}
  </div>
</section>
