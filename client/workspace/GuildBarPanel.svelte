<script lang="ts">
  import { untrack } from "svelte";
  import type { Readable } from "svelte/store";
  import type { Session } from "../runtime/session.ts";
  import {
    guildBarReading,
    guildBarSlotForPanel,
    guildBarStorageKey,
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
  let picking = $state(false);
  const reading = $derived(guildBarReading(guildVitals, slot, pinnedId));
  const critical = $derived(
    reading.meter !== null &&
      (reading.meter.reverse ? reading.percent >= 85 : reading.percent <= 30),
  );

  function pin(meterId: string): void {
    saveGuildBarPin(storage, storageKey, slot, meterId);
    pinnedId = meterId;
    picking = false;
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
  class:is-picking={picking}
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
      ? `${reading.meter.guild ? reading.meter.guild + ": " : ""}${reading.meter.label}${reading.meter.tip ? ". " + reading.meter.tip : ""}${reading.pinMissing ? ". Pinned resource not present; showing the slot's default." : ""}`
      : "No guild resource to show yet."}
  >
    <div
      class="vital-bar-fill"
      style:width={`${reading.percent}%`}
      style:background-color={reading.color}
    ></div>
    <div class="vital-bar-text">
      <span class="vital-bar-name">{reading.known ? reading.label : `Guild ${slot}`}</span>
      <span class="vital-bar-value">{reading.text}</span>
      <span class="vital-bar-percent">{reading.known ? `${reading.percent}%` : ""}</span>
    </div>
  </div>
  <button
    type="button"
    class="vital-bar-pick"
    title={reading.pinnedId
      ? `Pinned to ${reading.pinnedId}. Choose which guild resource this slot shows.`
      : "Choose which guild resource this slot shows."}
    aria-label="Choose guild resource"
    aria-expanded={picking}
    onclick={() => (picking = !picking)}>&#x2699;</button
  >
  {#if picking}
    <div class="vital-bar-picker" role="group" aria-label="Guild resource for slot {slot}">
      <button
        type="button"
        class="vital-bar-choice"
        aria-pressed={reading.pinnedId === ""}
        onclick={() => pin("")}
      >
        Automatic: resource {slot} of the guild
      </button>
      {#each reading.choices as choice (choice.id)}
        <button
          type="button"
          class="vital-bar-choice"
          aria-pressed={reading.pinnedId === choice.id}
          onclick={() => pin(choice.id)}
        >
          {choice.label}{choice.guild ? ` (${choice.guild})` : ""}
        </button>
      {/each}
      {#if reading.pinMissing}
        <p class="vital-bar-picker-note">
          Pinned resource "{reading.pinnedId}" is not in the current guild data.
        </p>
      {/if}
      {#if reading.choices.length === 0}
        <p class="vital-bar-picker-note">No guild resources have arrived yet.</p>
      {/if}
    </div>
  {/if}
</section>
