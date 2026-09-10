<script lang="ts">
  import { untrack } from "svelte";
  import type { Readable } from "svelte/store";
  import type { CharDefence } from "../gmcp/contracts/char.ts";
  import type { Session } from "../runtime/session.ts";
  import { buffBarReading, buffBarStorageKey, loadBuffBarPin, saveBuffBarPin } from "./buff-bar.ts";
  import type { PanelState } from "./workspace.ts";

  let { panelId, session }: { panelId: string; state: Readable<PanelState>; session?: Session } =
    $props();

  const resolvedSession = untrack(() => session);
  if (!resolvedSession) throw new Error("The Buff Bar requires a session");
  const activeSession: Session = resolvedSession;
  const storageKey = buffBarStorageKey(activeSession.characterProfileId);
  const storage = typeof localStorage === "undefined" ? null : localStorage;

  // Each defence entry is a fresh object when the server (re)sends it, so
  // the moment it was first seen is the moment its `remaining` was true.
  const receivedAt = new WeakMap<CharDefence, number>();
  const stamp = (item: CharDefence): number => {
    const seen = receivedAt.get(item);
    if (seen !== undefined) return seen;
    const at = Date.now();
    receivedAt.set(item, at);
    return at;
  };

  let defences = $state<readonly CharDefence[]>(activeSession.information.getSnapshot().defences);
  let pinnedName = $state(loadBuffBarPin(storage, storageKey));
  let now = $state(Date.now());
  const reading = $derived(buffBarReading(defences, pinnedName, now, stamp));
  // A buff about to run out pulses; a debuff pulses while it lingers.
  const critical = $derived(
    reading.known &&
      ((reading.kind === "buff" && reading.timed && reading.percent <= 10) ||
        reading.kind === "debuff"),
  );

  function pin(name: string): void {
    pinnedName = saveBuffBarPin(storage, storageKey, name);
  }

  $effect(() =>
    activeSession.information.subscribe((snapshot) => {
      untrack(() => {
        defences = snapshot.defences;
      });
    }),
  );

  // The countdown ticks once a second while a timed buff is on show.
  $effect(() => {
    if (!reading.timed) return;
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
</script>

<section
  class="vital-bar-panel vital-bar-buff vital-bar-buff-{reading.kind}"
  class:is-unknown={!reading.known}
  class:is-critical={critical}
  data-panel-id={panelId}
  data-workspace-owned="true"
  aria-label="Buff bar"
>
  <div
    class="vital-bar-track"
    role="progressbar"
    aria-label={reading.label}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={reading.known ? reading.percent : undefined}
    aria-valuetext={reading.text}
    title={reading.buff
      ? `${reading.buff.name}${reading.buff.desc ? ". " + reading.buff.desc : ""}${reading.kind === "debuff" ? " (debuff)" : ""}`
      : reading.pinMissing
        ? `"${reading.pinnedName}" is not active.`
        : "No active buffs."}
  >
    <div
      class="vital-bar-fill"
      style:transform={`scaleX(${reading.percent / 100})`}
      style:background-color={reading.color}
    ></div>
    <div class="vital-bar-text">
      <span class="vital-bar-name">{reading.label}</span>
      <span class="vital-bar-value">{reading.text}</span>
      <span class="vital-bar-percent"
        >{reading.known && reading.timed ? `${reading.percent}%` : ""}</span
      >
    </div>
  </div>
  <!-- The dropdown sits in the corner, faint until the pointer or focus
       reaches the panel, and pins the bar to whichever buff is chosen. -->
  <select
    class="vital-bar-select"
    aria-label="Buff shown in the bar"
    title={reading.pinMissing
      ? `"${reading.pinnedName}" is not active; the bar shows it empty until it returns.`
      : "Choose which buff this bar tracks."}
    value={reading.pinnedName}
    onchange={(event) => pin(event.currentTarget.value)}
  >
    <option value="">Automatic (soonest to expire)</option>
    {#if reading.pinMissing}
      <option value={reading.pinnedName}>{reading.pinnedName} (not active)</option>
    {/if}
    {#each reading.choices as choice (choice.name)}
      <option value={choice.name}>{choice.name}{choice.kind === "debuff" ? " (debuff)" : ""}</option
      >
    {/each}
  </select>
</section>
