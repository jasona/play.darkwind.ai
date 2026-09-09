<script lang="ts">
  import { untrack } from "svelte";
  import type { Readable } from "svelte/store";
  import type { CharVitals } from "../gmcp/contracts/char.ts";
  import type { Session } from "../runtime/session.ts";
  import { vitalBarKindForPanel, vitalReading } from "./vital-bar.ts";
  import type { PanelState } from "./workspace.ts";

  let { panelId, session }: { panelId: string; state: Readable<PanelState>; session?: Session } =
    $props();

  const resolvedSession = untrack(() => session);
  if (!resolvedSession) throw new Error("Vital bars require a session");
  const activeSession: Session = resolvedSession;
  const kind = vitalBarKindForPanel(untrack(() => panelId)) ?? "hp";

  let vitals = $state<CharVitals | null>(activeSession.information.getSnapshot().vitals);
  const reading = $derived(vitalReading(vitals, kind));
  // Below 30% the bar pulses so a glance catches it even when the panel is small.
  const critical = $derived(reading.known && reading.percent <= 30 && kind === "hp");

  $effect(() =>
    activeSession.information.subscribe((snapshot) => {
      untrack(() => {
        vitals = snapshot.vitals;
      });
    }),
  );
</script>

<section
  class="vital-bar-panel vital-bar-{kind}"
  class:is-unknown={!reading.known}
  class:is-critical={critical}
  data-panel-id={panelId}
  data-workspace-owned="true"
  aria-label="{reading.label} bar"
>
  <div
    class="vital-bar-track"
    role="progressbar"
    aria-label={reading.label}
    aria-valuemin="0"
    aria-valuemax={reading.known ? reading.max : 100}
    aria-valuenow={reading.known ? reading.current : undefined}
    aria-valuetext={reading.text}
  >
    <div
      class="vital-bar-fill"
      style:transform={`scaleX(${reading.percent / 100})`}
      style:background-color={reading.color}
    ></div>
    <div class="vital-bar-text">
      <span class="vital-bar-name">{reading.label}</span>
      <span class="vital-bar-value">{reading.text}</span>
      <span class="vital-bar-percent">{reading.known ? `${reading.percent}%` : ""}</span>
    </div>
  </div>
</section>
