<script lang="ts">
  import { untrack } from "svelte";
  import type { Readable } from "svelte/store";
  import type { Session } from "../runtime/session.ts";
  import {
    guildBarReading,
    guildBarSlotForPanel,
    guildBarStorageKey,
    guildMeterGroups,
    loadGuildBarPins,
    saveGuildBarPin,
  } from "./vital-bar.ts";
  import type { PanelState } from "./workspace.ts";

  let { panelId, session }: { panelId: string; state: Readable<PanelState>; session?: Session } =
    $props();

  const resolvedSession = untrack(() => session);
  if (!resolvedSession) throw new Error("Guild Resource panels require a session");
  const activeSession: Session = resolvedSession;
  const slot = guildBarSlotForPanel(untrack(() => panelId)) || 1;
  const storageKey = guildBarStorageKey(activeSession.characterProfileId);
  const storage = typeof localStorage === "undefined" ? null : localStorage;

  let guildVitals = $state<unknown>(activeSession.information.getSnapshot().guildVitals);
  let pinnedId = $state(loadGuildBarPins(storage, storageKey)[String(slot)] ?? "");
  const reading = $derived(guildBarReading(guildVitals, slot, pinnedId));
  // One <optgroup> per guild when meters from several guilds are on offer;
  // a flat list when they all belong to one.
  const groups = $derived(guildMeterGroups(reading.choices));
  const critical = $derived(
    reading.meter !== null &&
      (reading.meter.reverse ? reading.percent >= 85 : reading.percent <= 30),
  );

  function pin(meterId: string): void {
    saveGuildBarPin(storage, storageKey, slot, meterId);
    pinnedId = meterId;
  }

  $effect(() =>
    activeSession.information.subscribe((snapshot) => {
      untrack(() => {
        guildVitals = snapshot.guildVitals;
      });
    }),
  );
</script>

<section
  class="vital-bar-panel vital-bar-guild"
  class:is-unknown={!reading.known}
  class:is-critical={critical}
  data-panel-id={panelId}
  data-workspace-owned="true"
  aria-label="Guild resource {slot}"
>
  <div
    class="vital-bar-track"
    role="progressbar"
    aria-label={reading.label}
    aria-valuemin="0"
    aria-valuemax={reading.known ? reading.max : 100}
    aria-valuenow={reading.known ? reading.current : undefined}
    aria-valuetext={reading.text}
    title={reading.meter
      ? `${reading.meter.guild ? reading.meter.guild + ": " : ""}${reading.meter.label}${reading.meter.tip ? ". " + reading.meter.tip : ""}${reading.pinMissing ? ". Chosen resource not present; showing the slot's default." : ""}`
      : "No guild resource to show yet."}
  >
    <div
      class="vital-bar-fill"
      style:transform={`scaleX(${reading.percent / 100})`}
      style:background-color={reading.color}
    ></div>
    <div class="vital-bar-text">
      <span class="vital-bar-name">{reading.known ? reading.label : `Guild ${slot}`}</span>
      <span class="vital-bar-value">{reading.text}</span>
      <span class="vital-bar-percent">{reading.known ? `${reading.percent}%` : ""}</span>
    </div>
  </div>
  <!-- The dropdown sits in the corner, faint until the pointer or focus
       reaches the panel, and pins the slot to whichever meter is chosen. -->
  <select
    class="vital-bar-select"
    aria-label="Guild resource shown in slot {slot}"
    title={reading.pinMissing
      ? `Chosen resource "${reading.pinnedId}" is not in the current guild data; showing the slot's default.`
      : "Choose which guild resource this slot shows."}
    value={reading.pinnedId}
    onchange={(event) => pin(event.currentTarget.value)}
  >
    <option value="">Automatic (resource {slot})</option>
    {#if reading.pinMissing}
      <option value={reading.pinnedId}>{reading.pinnedId} (not present)</option>
    {/if}
    {#if groups.length <= 1}
      {#each reading.choices as meter (meter.id)}
        <option value={meter.id}>{meter.label}</option>
      {/each}
    {:else}
      {#each groups as group (group.guild)}
        <optgroup label={group.guild || "Other"}>
          {#each group.meters as meter (meter.id)}
            <option value={meter.id}>{meter.label}</option>
          {/each}
        </optgroup>
      {/each}
    {/if}
  </select>
</section>
