<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { Readable } from "svelte/store";
  import type { Session } from "../runtime/session.ts";
  import type { PanelState } from "./workspace.ts";
  // @ts-expect-error The retained DPS renderer is JavaScript without a declaration file.
  import { renderDpsPanel } from "../../public/js/dps-panel-renderer.mjs";

  let { panelId, session }: { panelId: string; state: Readable<PanelState>; session?: Session } =
    $props();

  const resolvedSession = untrack(() => session);
  if (!resolvedSession) throw new Error("DPS Meter requires a session");
  const activeSession: Session = resolvedSession;
  let body: HTMLElement;

  onMount(() => {
    const onReset = (): void => activeSession.dps.resetSession();
    return activeSession.dps.subscribe((snapshot) => {
      renderDpsPanel(body, snapshot, { onReset });
    });
  });
</script>

<section class="dps-meter-panel" data-panel-id={panelId} data-workspace-owned="true">
  <div bind:this={body}></div>
</section>
