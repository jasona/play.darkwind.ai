<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { Readable } from "svelte/store";
  import type { SessionCombatSnapshot } from "../runtime/combat.ts";
  import type { Session } from "../runtime/session.ts";
  import type { PanelState } from "./workspace.ts";
  // @ts-expect-error The canvas combat stage is retained JavaScript without a declaration file.
  import * as combatRenderer from "../../public/js/combat-stage-renderer.mjs";

  const { createCombatStageRenderer } = combatRenderer;

  let {
    panelId,
    state: _state,
    session,
  }: { panelId: string; state: Readable<PanelState>; session?: Session } = $props();

  const resolvedSession = untrack(() => session);
  if (!resolvedSession) throw new Error("Combat panels require a session");
  const activeSession: Session = resolvedSession;
  let root: HTMLElement;
  let body: HTMLElement;

  onMount(() => {
    const renderer = createCombatStageRenderer(body);
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncReducedMotion = (): void => {
      activeSession.combat.setReducedMotion(motionQuery.matches);
    };
    let renderSucceeded = false;
    let shouldPresent = false;

    const reportReady = (ready: boolean): void => {
      if (activeSession.combat.getSnapshot().presentationReady === ready) return;
      activeSession.combat.setPresentationReady(ready);
    };

    const syncReadiness = (): void => {
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      reportReady(
        renderSucceeded &&
          shouldPresent &&
          root.isConnected &&
          bounds.width > 0 &&
          bounds.height > 0,
      );
    };

    let lastSnapshot: SessionCombatSnapshot | null = null;
    const render = (snapshot: SessionCombatSnapshot): void => {
      lastSnapshot = snapshot;
      shouldPresent = snapshot.shouldPresent;
      try {
        renderSucceeded =
          renderer.render({
            model: snapshot.model,
            enemy: snapshot.enemy,
            vitals: snapshot.vitals,
            avatar: snapshot.avatar,
            status: snapshot.status,
            inventory: snapshot.inventory,
            // The stage paints a terrain backdrop from the current room.
            room: activeSession.world.getSnapshot().room,
          }) !== false;
        syncReadiness();
      } catch (error) {
        renderSucceeded = false;
        reportReady(false);
        console.error("Combat renderer failed", error);
      }
    };

    syncReducedMotion();
    motionQuery.addEventListener("change", syncReducedMotion);
    window.addEventListener("darkflow:workspace-layout-changed", syncReadiness);
    const sizeObserver = new ResizeObserver(syncReadiness);
    sizeObserver.observe(root);
    const unsubscribe = activeSession.combat.subscribe(render);
    let lastRoomGeneration = activeSession.world.getSnapshot().roomGeneration;
    const unsubscribeWorld = activeSession.world.subscribe((world) => {
      if (world.roomGeneration === lastRoomGeneration) return;
      lastRoomGeneration = world.roomGeneration;
      if (lastSnapshot) render(lastSnapshot);
    });
    return () => {
      unsubscribe();
      unsubscribeWorld();
      sizeObserver.disconnect();
      motionQuery.removeEventListener("change", syncReducedMotion);
      window.removeEventListener("darkflow:workspace-layout-changed", syncReadiness);
      reportReady(false);
      renderer.dispose();
    };
  });
</script>

<section
  bind:this={root}
  class="combat-panel"
  data-panel-id={panelId}
  data-workspace-owned="true"
  data-tutorial-target="enemy-panel"
  aria-label="Combat"
>
  <div bind:this={body}></div>
</section>
