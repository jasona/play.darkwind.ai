<script lang="ts">
  import { onMount } from "svelte";
  import type { Readable } from "svelte/store";
  import type { SessionInformationSnapshot } from "../gmcp/contracts/information.ts";
  import type { DarkwindCyberwareItem } from "../gmcp/contracts/information.ts";
  import type { Session } from "../runtime/session.ts";
  import type { PanelState } from "./workspace";
  // @ts-expect-error Shared DOM renderer is legacy-compatible JavaScript.
  import { createInformationPanelRenderers } from "../../public/js/core-information-panel-renderers.mjs";

  let {
    panelId,
    state: _state,
    session,
  }: { panelId: string; state: Readable<PanelState>; session?: Session } = $props();

  let body: HTMLElement;
  let imageDialog: HTMLDialogElement;
  let imageUrl = $state("");
  let imageAlt = $state("");
  let snapshot = $state<SessionInformationSnapshot | null>(null);
  let cyberwareDialog: HTMLDialogElement;
  let activeCyberwareId = $state<string | null>(null);

  function panelData(snapshot: SessionInformationSnapshot): unknown {
    switch (panelId) {
      case "avatar":
        return snapshot.avatar;
      case "status":
        return snapshot.status;
      case "vitals":
        return snapshot.vitals;
      case "guildVitals":
        return snapshot.guildVitals;
      case "xpmon":
        return snapshot.xpmon;
      case "omens":
        return snapshot.omens;
      case "sky":
        return snapshot.sky;
      case "stats":
        return snapshot.stats;
      case "buffs":
        return snapshot.defences;
      case "worth":
        return (
          snapshot.worth ??
          (snapshot.status ? { gold: snapshot.status.gold, bank: snapshot.status.bank } : null)
        );
      case "group":
        return snapshot.group;
      case "inventory":
        return snapshot.inventory;
      case "quests":
        return snapshot.quests;
      case "achievements":
        return snapshot.achievements;
      case "cyberware":
        return snapshot.cyberware;
      default:
        return null;
    }
  }

  onMount(() => {
    if (!session || !body) return;
    const renderers = createInformationPanelRenderers({
      sendCommand: (command: string) => session.terminal.sendCommand(command),
      openImageDialog: (url: string, alt: string) => {
        imageUrl = url;
        imageAlt = alt;
        imageDialog?.showModal();
      },
      requestCyberwareDetails: (item: DarkwindCyberwareItem) => {
        activeCyberwareId = item.id;
        session.information.requestCyberwareDetails(item.id);
        cyberwareDialog?.showModal();
      },
    });
    // Every panel hears every information publish, but a snapshot keeps the
    // slices it did not change by reference, so a panel whose data is the
    // same object (or the same shallow shape) as last time has nothing to draw.
    let lastData: unknown = renderers;
    const render = (nextSnapshot: SessionInformationSnapshot, force = false) => {
      snapshot = nextSnapshot;
      const renderer = renderers[panelId];
      if (!renderer) return;
      const data = panelData(nextSnapshot);
      if (!force && sameShallow(data, lastData)) return;
      lastData = data;
      renderer(body, data);
    };
    const unsubscribe = session.information.subscribe((nextSnapshot) => render(nextSnapshot));
    // Only the sky clock advances between frames; re-render it on a timer.
    const timer =
      panelId === "sky"
        ? window.setInterval(() => render(session.information.getSnapshot(), true), 1000)
        : undefined;
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearInterval(timer);
    };
  });

  function sameShallow(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) || Array.isArray(b)) return false;
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => left[key] === right[key]);
  }

  function activeCyberwareDetail() {
    return snapshot?.cyberwareDetail?.id === activeCyberwareId ? snapshot.cyberwareDetail : null;
  }

  function restoreCyberwareFocus(): void {
    const index = snapshot?.cyberware?.installed.findIndex(({ id }) => id === activeCyberwareId);
    const trigger =
      index === undefined || index < 0
        ? null
        : body.querySelector<HTMLElement>(`.cyber-item[data-cyber-index="${index}"]`);
    queueMicrotask(() => trigger?.focus());
  }
</script>

<section
  class="information-panel"
  data-panel-id={panelId}
  data-workspace-owned="true"
  data-tutorial-target={panelId === "inventory"
    ? "inventory-panel"
    : panelId === "vitals"
      ? "vitals-panel"
      : undefined}
>
  <div bind:this={body}></div>
</section>

<dialog bind:this={imageDialog} aria-label={imageAlt || "Avatar image"}>
  {#if imageUrl}
    <img src={imageUrl} alt={imageAlt} />
  {/if}
  <button type="button" onclick={() => imageDialog.close()}>Close image</button>
</dialog>

<dialog bind:this={cyberwareDialog} aria-label="Cyberware details" onclose={restoreCyberwareFocus}>
  <h2>{activeCyberwareDetail()?.name || "Implant details"}</h2>
  {#if activeCyberwareDetail()?.image}
    <img
      src={activeCyberwareDetail()?.image}
      alt={activeCyberwareDetail()?.name || "Implant schematic"}
    />
  {/if}
  <p>
    {activeCyberwareDetail()?.error || activeCyberwareDetail()?.description || "Querying implant…"}
  </p>
  {#if activeCyberwareDetail()?.scan}
    <pre>{activeCyberwareDetail()?.scan}</pre>
  {/if}
  <button type="button" onclick={() => cyberwareDialog.close()}>Close details</button>
</dialog>

<style>
  .information-panel {
    box-sizing: border-box;
    height: 100%;
    overflow: auto;
    padding: 0.75rem;
  }
  dialog img {
    display: block;
    max-height: min(75vh, 50rem);
    max-width: min(90vw, 50rem);
  }
</style>
