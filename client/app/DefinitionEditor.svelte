<script lang="ts">
  import { untrack } from "svelte";
  import { identityKeyForDefinition } from "../configuration/identity.ts";
  import type { CharacterConfigurationSnapshot } from "../configuration/editor.ts";
  import type {
    AliasDefinition,
    AutomationStep,
    CommandButtonDefinition,
    ConfigKind,
    ConfigSourceMetadata,
    FunctionDefinition,
    HighlightDefinition,
    KeyMappingDefinition,
    TimerDefinition,
    TriggerDefinition,
  } from "../model/configuration.ts";
  import type { ConfigSetId } from "../model/ids.ts";
  import { normalizeShortcut, shortcutFromEvent, shortcutLabel } from "../runtime/command-board.ts";
  import type { Session } from "../runtime/session.ts";
  import AutomationStepsEditor from "./AutomationStepsEditor.svelte";

  type Definition =
    | AliasDefinition
    | TriggerDefinition
    | HighlightDefinition
    | FunctionDefinition
    | KeyMappingDefinition
    | TimerDefinition
    | CommandButtonDefinition;
  type Draft = {
    id: string;
    enabled: boolean;
    code: string;
    label: string;
    legacyKey: string;
    command: string;
    shortcut: string;
    patternSource: string;
    description: string;
    group: string;
    ignoreCase: boolean;
    fg: string;
    bg: string;
    bold: boolean;
    name: string;
    script: string;
    trigger: string;
    pattern: string;
    isRegex: boolean;
    gag: boolean;
    durationMs: number;
    recurring: boolean;
    autoStart: boolean;
    steps: AutomationStep[];
  };
  type EditSource =
    { kind: "local" } | { kind: "shared-set"; configSetId: ConfigSetId; revision: number };

  let { session, kind }: { session: Session; kind: ConfigKind } = $props();
  let snapshot = $state<CharacterConfigurationSnapshot>(
    untrack(() => session.configuration.getSnapshot()),
  );
  let draft = $state<Draft | null>(null);
  let source = $state<EditSource | null>(null);
  let stale = $state(false);
  let status = $state("");
  let editor = $state<HTMLElement>();
  let keyCapture = $state<HTMLButtonElement>();
  let deleteCancel = $state<HTMLButtonElement>();
  let pendingDelete = $state<{
    definition: Definition;
    metadata: ConfigSourceMetadata;
  } | null>(null);
  let search = $state("");
  // Command button shortcut recorder: the next key press fills the draft.
  let recordingShortcut = $state(false);

  const title = $derived(
    kind === "keyMappings"
      ? "Key mappings"
      : kind === "commandButtons"
        ? "Command buttons"
        : `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`,
  );
  const noun = $derived(
    kind === "keyMappings"
      ? "mapping"
      : kind === "aliases"
        ? "alias"
        : kind === "triggers"
          ? "trigger"
          : kind === "timers"
            ? "timer"
            : kind === "functions"
              ? "function"
              : kind === "commandButtons"
                ? "button"
                : "highlight",
  );
  const entries = $derived(snapshot.effectiveConfiguration[kind]);
  const visibleEntries = $derived(
    entries.filter(({ definition }) =>
      labelFor(definition).toLowerCase().includes(search.trim().toLowerCase()),
    ),
  );
  const selectedEntry = $derived(entries.find(({ definition }) => definition.id === draft?.id));

  $effect(() =>
    session.configuration.subscribe((next) => {
      if (source?.kind === "shared-set") {
        const revision = next.attachedConfigurationSets[source.configSetId]?.revision;
        if (revision !== source.revision) stale = true;
      }
      snapshot = next;
    }),
  );
  $effect(() => {
    if (!recordingShortcut) return;
    const onKeydown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        if (draft) draft.shortcut = "";
        recordingShortcut = false;
        return;
      }
      const shortcut = shortcutFromEvent(event);
      if (!shortcut) return;
      if (draft) draft.shortcut = shortcut;
      recordingShortcut = false;
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });
  $effect(() => {
    if (kind === "keyMappings" || draft || !visibleEntries.length) return;
    const first = visibleEntries[0]!;
    untrack(() => edit(first.definition, first.source));
  });

  function blankDraft(): Draft {
    return {
      id: crypto.randomUUID(),
      enabled: true,
      code: "",
      label: "",
      legacyKey: "",
      command: "",
      shortcut: "",
      patternSource: "",
      description: "",
      group: "",
      ignoreCase: false,
      fg: "yellow",
      bg: "black",
      bold: false,
      name: "",
      script: "",
      trigger: "",
      pattern: "",
      isRegex: false,
      gag: false,
      durationMs: 1000,
      recurring: false,
      autoStart: false,
      steps: [],
    };
  }

  function draftFor(definition: Definition): Draft {
    const next = blankDraft();
    Object.assign(next, structuredClone(definition));
    if ("style" in definition) {
      next.fg = definition.style.fg;
      next.bg = definition.style.bg;
      next.bold = definition.style.bold;
    }
    return next;
  }

  function toDefinition(value: Draft): Definition {
    if (kind === "commandButtons") {
      return {
        id: value.id,
        enabled: value.enabled,
        label: value.label.trim(),
        command: value.command.trim(),
        shortcut: normalizeShortcut(value.shortcut),
      };
    }
    if (kind === "keyMappings") {
      return {
        id: value.id,
        enabled: value.enabled,
        code: value.code.trim(),
        label: value.label.trim(),
        legacyKey: value.legacyKey,
        command: value.command.trim(),
      };
    }
    if (kind === "highlights") {
      return {
        id: value.id,
        enabled: value.enabled,
        patternSource: value.patternSource.trim(),
        description: value.description.trim(),
        group: value.group.trim(),
        ignoreCase: value.ignoreCase,
        style: { fg: value.fg.trim(), bg: value.bg.trim(), bold: value.bold },
      };
    }
    if (kind === "aliases") {
      return {
        id: value.id,
        enabled: value.enabled,
        trigger: value.trigger.trim(),
        description: value.description.trim(),
        group: value.group.trim(),
        isRegex: value.isRegex,
        ignoreCase: value.ignoreCase,
        steps: value.steps.map((step) => ({ ...step })),
      };
    }
    if (kind === "triggers") {
      return {
        id: value.id,
        enabled: value.enabled,
        pattern: value.pattern.trim(),
        description: value.description.trim(),
        group: value.group.trim(),
        isRegex: value.isRegex,
        ignoreCase: value.ignoreCase,
        gag: value.gag,
        steps: value.steps.map((step) => ({ ...step })),
      };
    }
    if (kind === "timers") {
      return {
        id: value.id,
        enabled: value.enabled,
        name: value.name.trim(),
        description: value.description.trim(),
        group: value.group.trim(),
        durationMs: value.durationMs,
        recurring: value.recurring,
        autoStart: value.autoStart,
        steps: value.steps.map((step) => ({ ...step })),
      };
    }
    return {
      id: value.id,
      enabled: value.enabled,
      name: value.name.trim(),
      description: value.description.trim(),
      group: value.group.trim(),
      script: value.script,
    };
  }

  function labelFor(definition: Definition): string {
    if ("shortcut" in definition) return definition.label || definition.command;
    if ("code" in definition) return definition.label || definition.code;
    if ("patternSource" in definition) return definition.patternSource;
    if ("trigger" in definition) return definition.trigger;
    if ("pattern" in definition) return definition.pattern;
    return definition.name;
  }

  function keyDefinition(definition: Definition): KeyMappingDefinition {
    return definition as KeyMappingDefinition;
  }

  function keyLabel(label: string, code: string): string {
    const comparable = (value: string) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return label && comparable(label) !== comparable(code) ? label : code;
  }

  function showKeyCode(label: string, code: string): boolean {
    return Boolean(label && keyLabel(label, code) !== code);
  }

  function captureKey(event: KeyboardEvent): void {
    if (!draft || !recordKey(event, draft)) return;
    if (draft.command.trim()) save();
  }

  function recordKey(event: KeyboardEvent, value: Draft): boolean {
    if (event.key === "Tab") return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Backspace" || event.key === "Delete") {
      value.code = "";
      value.label = "";
      value.legacyKey = "";
      return true;
    }
    if (
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      ["Shift", "Control", "Alt", "Meta"].includes(event.key)
    )
      return false;
    value.code = event.code;
    value.label = event.key === " " ? "Space" : event.key;
    value.legacyKey = event.shiftKey && event.key.length === 1 ? event.key : "";
    return true;
  }

  function sourceFor(metadata: ConfigSourceMetadata): EditSource | null {
    if (metadata.kind === "builtin") return null;
    return metadata.kind === "local"
      ? { kind: "local" }
      : {
          kind: "shared-set",
          configSetId: metadata.configSetId!,
          revision: metadata.revision!,
        };
  }

  function updateDefinition(definition: Definition, metadata: ConfigSourceMetadata): void {
    const editSource = sourceFor(metadata);
    if (!editSource) return;
    const definitions = targetDefinitions(editSource);
    const identity = identityKeyForDefinition(kind, definition);
    if (
      definitions.some(
        (item) => item.id !== definition.id && identityKeyForDefinition(kind, item) === identity,
      )
    ) {
      status = `${title} must have unique identities.`;
      return;
    }
    const index = definitions.findIndex((item) => item.id === definition.id);
    if (index === -1) definitions.push(definition);
    else definitions[index] = definition;
    const result = write(definitions, editSource);
    status = result.success ? `${title} saved.` : result.message;
  }

  function selectDefinition(id: string): void {
    snapshot = session.configuration.getSnapshot();
    const entry = snapshot.effectiveConfiguration[kind].find(
      ({ definition }) => definition.id === id,
    );
    if (entry) edit(entry.definition, entry.source);
  }

  function canMove(offset: number): boolean {
    if (!selectedEntry) return false;
    const editSource = sourceFor(selectedEntry.source);
    if (!editSource) return false;
    const definitions = targetDefinitions(editSource);
    const index = definitions.findIndex((item) => item.id === selectedEntry.definition.id);
    return index + offset >= 0 && index + offset < definitions.length;
  }

  function moveSelected(offset: number): void {
    if (!selectedEntry) return;
    const editSource = sourceFor(selectedEntry.source);
    if (!editSource) return;
    const definitions = targetDefinitions(editSource);
    const index = definitions.findIndex((item) => item.id === selectedEntry.definition.id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= definitions.length) return;
    [definitions[index], definitions[target]] = [definitions[target]!, definitions[index]!];
    const result = write(definitions, editSource);
    status = result.success ? `${title} reordered.` : result.message;
    if (result.success) selectDefinition(selectedEntry.definition.id);
  }

  function duplicateSelected(): void {
    if (!selectedEntry) return;
    const editSource = sourceFor(selectedEntry.source);
    if (!editSource) return;
    const next = draftFor(selectedEntry.definition);
    next.id = crypto.randomUUID();
    if (kind === "aliases") next.trigger += " copy";
    else if (kind === "triggers") next.pattern += " copy";
    else if (kind === "highlights") next.patternSource += " copy";
    else next.name += " copy";
    const definition = toDefinition(next);
    const definitions = targetDefinitions(editSource);
    const index = definitions.findIndex((item) => item.id === selectedEntry.definition.id);
    definitions.splice(index + 1, 0, definition);
    const result = write(definitions, editSource);
    status = result.success ? `${title} duplicated.` : result.message;
    if (result.success) selectDefinition(definition.id);
  }

  function captureExistingKey(
    event: KeyboardEvent,
    definition: Definition,
    metadata: ConfigSourceMetadata,
  ): void {
    const next = draftFor(definition);
    if (recordKey(event, next)) updateDefinition(toDefinition(next), metadata);
  }

  function updateExistingDefinition(
    definition: Definition,
    metadata: ConfigSourceMetadata,
    patch: Partial<Draft>,
  ): void {
    const next = draftFor(definition);
    Object.assign(next, patch);
    updateDefinition(toDefinition(next), metadata);
  }

  function sourceLabel(metadata: ConfigSourceMetadata): string {
    if (metadata.kind === "local") return "Local";
    if (metadata.kind === "builtin") return "Built-in";
    const set = snapshot.attachedConfigurationSets[metadata.configSetId!];
    return `Shared: ${set?.label ?? metadata.configSetId} (revision ${metadata.revision})`;
  }

  function edit(definition: Definition, metadata: ConfigSourceMetadata): void {
    draft = draftFor(definition);
    source =
      metadata.kind === "shared-set"
        ? {
            kind: "shared-set",
            configSetId: metadata.configSetId!,
            revision: metadata.revision!,
          }
        : { kind: "local" };
    stale = false;
    status = "";
    queueMicrotask(() =>
      editor?.querySelector<HTMLInputElement>("input:not([type=checkbox])")?.focus(),
    );
  }

  function add(): void {
    draft = blankDraft();
    source = { kind: "local" };
    stale = false;
    status = "";
    queueMicrotask(() => {
      if (kind === "keyMappings") keyCapture?.focus();
      else editor?.querySelector<HTMLInputElement>("input:not([type=checkbox])")?.focus();
    });
  }

  function cancel(): void {
    draft = null;
    source = null;
    stale = false;
  }

  function targetDefinitions(editSource: EditSource): Definition[] {
    if (editSource.kind === "local") {
      return structuredClone(snapshot.localDefinitions[kind]);
    }
    return structuredClone(
      snapshot.attachedConfigurationSets[editSource.configSetId]?.definitions ?? [],
    );
  }

  function write(definitions: Definition[], editSource: EditSource) {
    if (editSource.kind === "local") {
      return session.configuration.replaceLocalDefinitions(kind, definitions as never);
    }
    return session.configuration.publishConfigurationSet({
      configSetId: editSource.configSetId,
      expectedRevision: editSource.revision,
      definitions: definitions as never,
    });
  }

  function save(): void {
    if (!draft || !source) return;
    const invalid = editor?.querySelector<HTMLInputElement | HTMLTextAreaElement>(":invalid");
    if (invalid) {
      invalid.reportValidity();
      return;
    }

    const definition = toDefinition(draft);
    const definitions = targetDefinitions(source);
    const identity = identityKeyForDefinition(kind, definition);
    if (
      definitions.some(
        (item) => item.id !== definition.id && identityKeyForDefinition(kind, item) === identity,
      )
    ) {
      status = `${title} must have unique identities.`;
      return;
    }

    const index = definitions.findIndex((item) => item.id === definition.id);
    if (index === -1) definitions.push(definition);
    else definitions[index] = definition;
    const result = write(definitions, source);
    if (!result.success) {
      status = result.message;
      if ("code" in result && result.code === "stale-revision") stale = true;
      return;
    }
    status = `${title} saved.`;
    if (kind === "keyMappings") cancel();
    else selectDefinition(definition.id);
  }

  function requestRemove(definition: Definition, metadata: ConfigSourceMetadata): void {
    pendingDelete = { definition, metadata };
    queueMicrotask(() => deleteCancel?.focus());
  }

  function openModal(node: HTMLDialogElement): { destroy(): void } {
    node.showModal();
    return {
      destroy(): void {
        if (node.open) node.close();
      },
    };
  }

  function remove(): void {
    if (!pendingDelete) return;
    const { definition, metadata } = pendingDelete;
    pendingDelete = null;
    const editSource = sourceFor(metadata);
    if (!editSource) return;
    const result = write(
      targetDefinitions(editSource).filter((item) => item.id !== definition.id),
      editSource,
    );
    status = result.success ? `${title} entry deleted.` : result.message;
    if (result.success && draft?.id === definition.id) {
      cancel();
      if (kind !== "keyMappings") {
        snapshot = session.configuration.getSnapshot();
        const next = snapshot.effectiveConfiguration[kind][0];
        if (next) edit(next.definition, next.source);
      }
    }
  }

  function reload(): void {
    if (!draft || source?.kind !== "shared-set") return;
    snapshot = session.configuration.getSnapshot();
    const entry = snapshot.effectiveConfiguration[kind].find(
      ({ definition }) => definition.id === draft?.id,
    );
    if (entry) edit(entry.definition, entry.source);
    else cancel();
  }
</script>

<fieldset class:automation-editor={kind !== "keyMappings"}>
  <legend>{title}</legend>
  {#if kind === "keyMappings"}
    <p class="helper-text">
      Press a key in the Key field to capture it. Top-row numbers and numpad numbers are different
      keys.
    </p>
    <div class="mapping-list">
      {#each entries as entry (entry.definition.id)}
        {@const mapping = keyDefinition(entry.definition)}
        <div class="mapping-row" title={sourceLabel(entry.source)}>
          <button
            aria-label={`Key for ${labelFor(mapping)}`}
            class="key-input"
            type="button"
            onkeydown={(event) => captureExistingKey(event, mapping, entry.source)}
          >
            <span>{keyLabel(mapping.label, mapping.code)}</span>
            {#if showKeyCode(mapping.label, mapping.code)}<small>({mapping.code})</small>{/if}
          </button>
          <input
            aria-label={`Command for ${labelFor(mapping)}`}
            value={mapping.command}
            onchange={(event) =>
              updateExistingDefinition(mapping, entry.source, {
                command: event.currentTarget.value,
              })}
          />
          <input
            aria-label={`Enable ${labelFor(mapping)}`}
            type="checkbox"
            checked={mapping.enabled}
            disabled={entry.source.kind === "builtin"}
            onchange={(event) =>
              updateExistingDefinition(mapping, entry.source, {
                enabled: event.currentTarget.checked,
              })}
          />
          <button
            type="button"
            disabled={entry.source.kind === "builtin"}
            onclick={() => requestRemove(mapping, entry.source)}>Remove</button
          >
        </div>
      {/each}
      {#if draft}
        <div class="mapping-row new-mapping">
          <button
            bind:this={keyCapture}
            aria-label="Key for new mapping"
            class="key-input"
            type="button"
            onkeydown={captureKey}
          >
            <span>{draft.code ? keyLabel(draft.label, draft.code) : "Press a key"}</span>
            {#if showKeyCode(draft.label, draft.code)}<small>({draft.code})</small>{/if}
          </button>
          <input
            aria-label="Command for new mapping"
            bind:value={draft.command}
            placeholder="Command to send"
            onchange={() => draft?.code && save()}
          />
          <input aria-label="Enable new mapping" type="checkbox" bind:checked={draft.enabled} />
          <button type="button" onclick={cancel}>Remove</button>
        </div>
      {/if}
    </div>
    <div class="inline-actions">
      <button type="button" disabled={Boolean(draft)} onclick={add}>Add mapping</button>
    </div>
  {:else}
    <div class="automation-toolbar">
      <input
        aria-label={`Search ${title}`}
        bind:value={search}
        placeholder={`Search ${title.toLowerCase()}`}
      />
      <button type="button" onclick={add}>New {noun}</button>
    </div>
    <div class="automation-layout">
      <div class="automation-list-pane">
        <div class="automation-list" aria-label={title}>
          {#each visibleEntries as entry (entry.definition.id)}
            <div
              class:active={selectedEntry?.definition.id === entry.definition.id}
              class="list-row"
            >
              <button
                class="list-select"
                type="button"
                aria-label={`Edit ${labelFor(entry.definition)}`}
                onclick={() => edit(entry.definition, entry.source)}
              >
                <strong>{labelFor(entry.definition)}</strong>
                <span>{sourceLabel(entry.source)}</span>
              </button>
              <input
                aria-label={`Enable ${labelFor(entry.definition)}`}
                type="checkbox"
                checked={entry.definition.enabled}
                disabled={entry.source.kind === "builtin"}
                onchange={(event) =>
                  updateExistingDefinition(entry.definition, entry.source, {
                    enabled: event.currentTarget.checked,
                  })}
              />
            </div>
          {:else}
            <p>
              {entries.length
                ? `No ${title.toLowerCase()} match.`
                : `No ${title.toLowerCase()} configured.`}
            </p>
          {/each}
        </div>
        <div class="list-actions">
          <button type="button" disabled={!canMove(-1)} onclick={() => moveSelected(-1)}>Up</button>
          <button type="button" disabled={!canMove(1)} onclick={() => moveSelected(1)}>Down</button>
          <button
            type="button"
            disabled={!selectedEntry || selectedEntry.source.kind === "builtin"}
            onclick={duplicateSelected}>Duplicate</button
          >
          <button
            type="button"
            disabled={!selectedEntry || selectedEntry.source.kind === "builtin"}
            aria-label={selectedEntry
              ? `Delete ${labelFor(selectedEntry.definition)}`
              : `Delete ${noun}`}
            onclick={() =>
              selectedEntry && requestRemove(selectedEntry.definition, selectedEntry.source)}
            >Delete</button
          >
        </div>
      </div>
      <div class="automation-detail">
        {#if draft}
          <section bind:this={editor} class="editor" aria-label={`Edit ${title.toLowerCase()}`}>
            <label><input type="checkbox" bind:checked={draft.enabled} /> Enabled</label>
            {#if kind === "commandButtons"}
              <label>Label <input bind:value={draft.label} required /></label>
              <label
                >Command <input
                  bind:value={draft.command}
                  placeholder="Sent as if typed, e.g. cast heal"
                  required
                /></label
              >
              <label
                >Shortcut <input
                  bind:value={draft.shortcut}
                  placeholder="Alt+Digit1, Ctrl+Shift+KeyH, F5"
                /></label
              >
              <div class="actions">
                <span
                  >{draft.shortcut
                    ? `Shows as ${shortcutLabel(normalizeShortcut(draft.shortcut)) || "nothing (not allowed)"}`
                    : "No shortcut"}</span
                >
                <button
                  type="button"
                  aria-pressed={recordingShortcut}
                  onclick={() => (recordingShortcut = !recordingShortcut)}
                  >{recordingShortcut ? "Press keys... (Esc clears)" : "Record shortcut"}</button
                >
              </div>
            {:else if kind === "highlights"}
              <label>Pattern <input bind:value={draft.patternSource} required /></label>
              <label>Description <input bind:value={draft.description} /></label>
              <label>Group <input bind:value={draft.group} /></label>
              <label><input type="checkbox" bind:checked={draft.ignoreCase} /> Ignore case</label>
              <label>Foreground <input bind:value={draft.fg} required /></label>
              <label>Background <input bind:value={draft.bg} required /></label>
              <label><input type="checkbox" bind:checked={draft.bold} /> Bold</label>
            {:else if kind === "functions"}
              <label>Name <input bind:value={draft.name} required /></label>
              <label>Description <input bind:value={draft.description} /></label>
              <label>Group <input bind:value={draft.group} /></label>
              <label>Script <textarea bind:value={draft.script} required></textarea></label>
            {:else}
              {#if kind === "aliases"}
                <label>Trigger <input bind:value={draft.trigger} required /></label>
              {:else if kind === "triggers"}
                <label>Pattern <input bind:value={draft.pattern} required /></label>
                <label><input type="checkbox" bind:checked={draft.gag} /> Gag matching output</label
                >
              {:else}
                <label>Name <input bind:value={draft.name} required /></label>
                <label
                  >Duration (milliseconds) <input
                    type="number"
                    min="0"
                    bind:value={draft.durationMs}
                    required
                  /></label
                >
                <label><input type="checkbox" bind:checked={draft.recurring} /> Recurring</label>
                <label
                  ><input type="checkbox" bind:checked={draft.autoStart} /> Start automatically</label
                >
              {/if}
              <label>Description <input bind:value={draft.description} /></label>
              <label>Group <input bind:value={draft.group} /></label>
              {#if kind !== "timers"}
                <label
                  ><input type="checkbox" bind:checked={draft.isRegex} /> Regular expression</label
                >
                <label><input type="checkbox" bind:checked={draft.ignoreCase} /> Ignore case</label>
              {/if}
              <AutomationStepsEditor bind:steps={draft.steps} />
            {/if}
            {#if stale}
              <p class="error">This shared definition changed while you were editing it.</p>
              <button type="button" onclick={reload}>Reload shared definition</button>
            {/if}
            <div class="actions">
              <button type="button" onclick={cancel}>Cancel edit</button>
              <button type="button" onclick={save}>Save {title.toLowerCase()}</button>
            </div>
          </section>
        {:else}
          <p>Select {noun === "alias" ? "an" : "a"} {noun} to edit, or create a new one.</p>
        {/if}
      </div>
    </div>
  {/if}
  {#if pendingDelete}
    <dialog
      use:openModal
      class="definition-modal"
      aria-label={`Delete ${labelFor(pendingDelete.definition)}`}
      oncancel={(event) => {
        event.preventDefault();
        pendingDelete = null;
      }}
    >
      <section class="delete-confirmation">
        <h3>Delete {labelFor(pendingDelete.definition)}?</h3>
        <p>This change is not permanent until you apply Settings.</p>
        <div class="actions">
          <button bind:this={deleteCancel} type="button" onclick={() => (pendingDelete = null)}
            >Keep it</button
          >
          <button type="button" onclick={remove}>Delete</button>
        </div>
      </section>
    </dialog>
  {/if}
  <p class:error={stale} aria-live="polite">{status}</p>
</fieldset>

<style>
  fieldset {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  .helper-text,
  p {
    margin: 0;
  }

  .mapping-list {
    display: grid;
    gap: 0.5rem;
  }

  .mapping-row {
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr) auto auto;
    gap: 0.5rem;
    align-items: center;
  }

  .key-input {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    text-align: center;
    cursor: pointer;
  }

  .key-input small {
    color: var(--df-muted, #8b949e);
    font-size: 0.72rem;
    white-space: nowrap;
  }

  .inline-actions,
  .automation-toolbar,
  .list-actions,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .automation-toolbar input {
    flex: 1;
  }

  .automation-layout {
    display: flex;
    gap: 0.75rem;
    min-height: 320px;
  }

  .automation-list-pane {
    display: flex;
    flex: 0 1 230px;
    min-width: 150px;
    min-height: 0;
    flex-direction: column;
    gap: 0.5rem;
  }

  .automation-list {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    flex-direction: column;
    gap: 0.375rem;
    padding-right: 0.25rem;
  }

  .list-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.375rem;
    align-items: center;
    border: 1px solid var(--border-color, #30363d);
    border-radius: 0.35rem;
    background: var(--df-bg, #0d1117);
  }

  .list-row.active {
    border-color: var(--df-accent, #58a6ff);
    background: rgb(88 166 255 / 12%);
  }

  .list-select {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
    padding: 0.5rem;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
  }

  .list-select strong,
  .list-select span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .list-select span {
    color: var(--df-muted, #8b949e);
    font-size: 0.75rem;
  }

  .list-row > input {
    margin-right: 0.5rem;
  }

  .automation-detail {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }

  .editor {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
    padding: 0.75rem;
    border: 1px solid var(--border-color, #30363d);
    border-radius: 0.35rem;
  }

  .definition-modal {
    max-width: none;
    max-height: none;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
  }

  .definition-modal::backdrop {
    background: var(--df-overlay, rgb(0 0 0 / 60%));
  }

  .delete-confirmation {
    box-sizing: border-box;
    width: min(34rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow: auto;
    background: var(--df-panel, #161b22);
  }

  .delete-confirmation {
    display: grid;
    gap: 0.75rem;
    padding: 1rem;
    border: 1px solid var(--border-color, #30363d);
    border-radius: 0.35rem;
  }

  .delete-confirmation h3 {
    margin: 0;
  }

  label {
    display: grid;
    gap: 0.25rem;
  }

  label:has(input[type="checkbox"]) {
    grid-template-columns: auto 1fr;
    align-items: center;
  }

  input,
  textarea,
  button {
    box-sizing: border-box;
    min-height: 2.75rem;
    min-width: 0;
  }

  textarea {
    min-height: 6rem;
    resize: vertical;
  }

  .error {
    color: var(--df-err, #ff6b6b);
  }

  @media (max-width: 700px) {
    .mapping-row {
      grid-template-columns: 100px minmax(0, 1fr) auto;
    }

    .mapping-row > button {
      grid-column: 1 / -1;
    }

    .automation-layout {
      flex-direction: column;
    }

    .automation-list-pane {
      flex-basis: auto;
      min-height: 220px;
    }
  }
</style>
