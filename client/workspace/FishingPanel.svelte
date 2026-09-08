<script lang="ts">
  import { untrack } from "svelte";
  import type { Readable } from "svelte/store";
  import type { DarkwindFishingFight, InteractionFishing } from "../gmcp/contracts/interactions.ts";
  import type { FishingAutoSnapshot } from "../runtime/fishing-auto.ts";
  import type { Session } from "../runtime/session.ts";
  import type { PanelState } from "./workspace.ts";
  // @ts-expect-error The shared deterministic fishing core has no declaration file.
  import { castPowerAt, computeAccuracy, createFightSim } from "../../public/js/fishing-core.mjs";

  type Phase =
    | "idle"
    | "nobait"
    | "ready"
    | "casting"
    | "waiting"
    | "bite"
    | "hooking"
    | "fight"
    | "resolving"
    | "caught"
    | "escaped";

  interface FightState {
    fishPos: number;
    barPos: number;
    tension: number;
    tensionPeak: number;
    progress: number;
    running: boolean;
    elapsedMs: number;
    overlapMs: number;
  }

  interface FightSim {
    step(dtMs: number, held: boolean): "caught" | "snap" | "slack" | null;
    getState(): FightState;
  }

  const RARITY_COLORS: Readonly<Record<string, string>> = {
    common: "var(--df-text)",
    uncommon: "#4caf50",
    rare: "#42a5f5",
    epic: "#ab47bc",
    legendary: "#ffb300",
  };
  const ESCAPE_TEXT: Readonly<Record<string, string>> = {
    snap: "SNAP! The line breaks and whips back over your head.",
    slack: "The line goes slack... the fish wriggles free.",
    timeout: "Too slow! The fish makes off with your bait.",
    implausible: "The fish slips away in a blur.",
  };
  const FISH_SILHOUETTE =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 40"><path fill="currentColor" opacity=".55" d="M8 20c8-10 20-14 30-10l10-8v10c4 2 7 5 8 8-1 3-4 6-8 8v10l-10-8c-10 4-22 0-30-10z"/><circle cx="42" cy="17" r="2" fill="#111"/></svg>',
    );
  const REEL_LOOP_ID = "fishing-reel";

  let { panelId, session }: { panelId: string; state: Readable<PanelState>; session?: Session } =
    $props();

  const resolvedSession = untrack(() => session);
  if (!resolvedSession) throw new Error("Fishing requires a session");
  const activeSession: Session = resolvedSession;
  const instructionsId = `fishing-instructions-${activeSession.sessionId}`;

  const initialFishing = activeSession.interactions.getSnapshot().fishing;
  let fishing = $state<InteractionFishing>(initialFishing);
  let phase = $state<Phase>("idle");
  let castPower = $state(0);
  let bitePercent = $state(100);
  let fightState = $state<FightState | null>(null);
  let held = $state(false);
  let castControl = $state<HTMLButtonElement>();
  let gameControl = $state<HTMLButtonElement>();
  // The Auto-Angler's view of the run. Its casts and hooks arrive as actions
  // the stage mirrors, so an automated cast charges the same meter a manual
  // one does.
  let auto = $state<FishingAutoSnapshot>(activeSession.fishingAuto.getSnapshot());
  let seenAutoActionSeq = activeSession.fishingAuto.getSnapshot().action?.seq ?? 0;
  const autoHaltVisible = $derived(
    !auto.enabled &&
      auto.haltReason !== "" &&
      (phase === "idle" || phase === "nobait" || phase === "caught" || phase === "escaped"),
  );

  let lastOpen: typeof initialFishing.open = null;
  let lastBite: typeof initialFishing.bite = null;
  let lastFight: typeof initialFishing.fight = null;
  let lastCaught: typeof initialFishing.caught = null;
  let lastEscaped: typeof initialFishing.escaped = null;
  let lastEnd: typeof initialFishing.end = null;
  let sim: FightSim | null = null;
  let resultReported = false;
  let rafId = 0;
  let lastFrame = 0;
  let castStartedAt = 0;
  let biteEndsAt = 0;
  let castPointerId: number | null = null;
  let fightPointerId: number | null = null;
  let reelActive = false;
  let tensionWarned = false;

  const open = $derived(fishing.open);
  const caught = $derived(fishing.caught);
  const sceneUrl = $derived(typeof open?.sceneArtUrl === "string" ? open.sceneArtUrl : "");
  const fightArt = $derived(
    typeof fishing.fight?.fish.artUrl === "string" ? fishing.fight.fish.artUrl : FISH_SILHOUETTE,
  );
  const trophyArt = $derived(
    typeof caught?.fish.artUrl === "string"
      ? caught.fish.artUrl
      : caught
        ? (fishing.art[caught.fish.id] ?? FISH_SILHOUETTE)
        : FISH_SILHOUETTE,
  );
  const rarityColor = $derived(
    caught ? (RARITY_COLORS[caught.fish.rarity] ?? RARITY_COLORS.common) : RARITY_COLORS.common,
  );
  const rewardText = $derived.by(() => {
    if (!caught) return "";
    const parts: string[] = [];
    if (caught.rewards.skillup)
      parts.push(`Your fishing skill rises to ${caught.rewards.newSkill}!`);
    if (caught.rewards.reagent) {
      parts.push(`+${caught.rewards.reagent.amount} ${caught.rewards.reagent.name}`);
    }
    return parts.join(" ");
  });

  function releasePointer(element: HTMLElement | undefined, pointerId: number | null): void {
    if (!element || pointerId === null || !element.hasPointerCapture(pointerId)) return;
    element.releasePointerCapture(pointerId);
  }

  function stopLoop(): void {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function stopMotion(): void {
    stopLoop();
    releasePointer(castControl, castPointerId);
    releasePointer(gameControl, fightPointerId);
    castPointerId = null;
    fightPointerId = null;
    held = false;
  }

  function stopReel(): void {
    if (!reelActive) return;
    reelActive = false;
    activeSession.audio.stopLocal("fishing", REEL_LOOP_ID);
  }

  function sendResult(outcome: "caught" | "snap" | "slack"): void {
    if (!open || !sim || resultReported) return;
    resultReported = true;
    const state = sim.getState();
    activeSession.interactions.reportFishingResult({
      session: open.session,
      outcome,
      fightMs: Math.round(state.elapsedMs),
      accuracy: Math.round(computeAccuracy(state) * 1_000) / 1_000,
      tensionPeak: Math.round(state.tensionPeak),
    });
    activeSession.fishingAuto.notifyFightEnd();
    releaseFight();
    phase = "resolving";
  }

  function tick(now: number): void {
    rafId = 0;
    const dt = Math.min(100, now - lastFrame);
    lastFrame = now;

    if (phase === "casting") {
      castPower = castPowerAt(now - castStartedAt);
    } else if (phase === "bite") {
      const windowMs = fishing.bite?.windowMs ?? 0;
      bitePercent = windowMs > 0 ? Math.max(0, ((biteEndsAt - now) / windowMs) * 100) : 0;
      if (bitePercent <= 0) return;
    } else if (phase === "fight" && sim) {
      // The Auto-Angler's one delegation point. Guarded so that with the
      // addon off this costs a boolean test and never allocates a state.
      const effectiveHeld = auto.enabled
        ? activeSession.fishingAuto.resolveHeld(held, sim.getState(), dt)
        : held;
      const outcome = sim.step(dt, effectiveHeld);
      fightState = sim.getState();
      if (fightState.tension > 85 && !tensionWarned) {
        tensionWarned = true;
        activeSession.audio.playLocal("fishing", "tension");
      } else if (fightState.tension < 70 && tensionWarned) {
        tensionWarned = false;
      }
      if (outcome) {
        sendResult(outcome);
        return;
      }
    } else {
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function startLoop(): void {
    if (rafId) return;
    lastFrame = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function beginFight(next: DarkwindFishingFight): void {
    stopMotion();
    sim = createFightSim(next.params, next.seed) as FightSim;
    fightState = sim.getState();
    resultReported = false;
    tensionWarned = false;
    phase = "fight";
    reelActive = activeSession.audio.loopLocal("fishing", "reel", REEL_LOOP_ID, 0.6);
    startLoop();
  }

  function reconcile(next: InteractionFishing): void {
    fishing = next;

    if (next.open !== lastOpen) {
      lastOpen = next.open;
      stopMotion();
      stopReel();
      tensionWarned = false;
      sim = null;
      fightState = null;
      phase = next.open ? (next.open.baited ? "ready" : "nobait") : "idle";
    }
    if (next.bite && next.bite !== lastBite) {
      lastBite = next.bite;
      stopMotion();
      activeSession.audio.playLocal("fishing", "splash");
      phase = "bite";
      bitePercent = 100;
      biteEndsAt = performance.now() + next.bite.windowMs;
      startLoop();
    }
    if (next.fight && next.fight !== lastFight) {
      lastFight = next.fight;
      beginFight(next.fight);
    }
    if (next.caught && next.caught !== lastCaught) {
      lastCaught = next.caught;
      stopMotion();
      stopReel();
      activeSession.audio.playLocal("fishing", "catch");
      if (next.caught.fish.pristine) activeSession.audio.playLocal("fishing", "pristine");
      phase = "caught";
    }
    if (next.escaped && next.escaped !== lastEscaped) {
      lastEscaped = next.escaped;
      stopMotion();
      stopReel();
      activeSession.audio.playLocal("fishing", next.escaped.reason === "snap" ? "snap" : "slack");
      phase = "escaped";
    }
    if (next.end && next.end !== lastEnd) {
      lastEnd = next.end;
      stopMotion();
      stopReel();
      tensionWarned = false;
      phase = "idle";
    }
  }

  // Mirrors what the Auto-Angler did to the session on the stage: charge the
  // meter when it begins a cast, settle into waiting when the cast goes out,
  // and into hooking when it hooks.
  function reconcileAuto(next: FishingAutoSnapshot): void {
    auto = next;
    const action = next.action;
    if (!action || action.seq === seenAutoActionSeq) return;
    seenAutoActionSeq = action.seq;
    if (action.kind === "cast-begin") {
      if (phase !== "ready") return;
      castPower = 0;
      castStartedAt = performance.now();
      phase = "casting";
      startLoop();
    } else if (action.kind === "cast") {
      stopLoop();
      if (action.power !== null) castPower = action.power;
      phase = "waiting";
      activeSession.audio.playLocal("fishing", "cast");
    } else if (action.kind === "cast-abandoned") {
      if (phase !== "casting") return;
      stopLoop();
      phase = "ready";
    } else if (action.kind === "hook") {
      stopLoop();
      phase = "hooking";
      activeSession.audio.playLocal("fishing", "hook");
    }
  }

  // A deliberate press on the stage is the player taking over. Releases and
  // auto-repeat keys do not count: a release only matters after a press, and
  // that press already handed control back.
  function takeOver(): void {
    activeSession.fishingAuto.notifyManualInput();
  }

  function beginCast(event?: PointerEvent): void {
    if (phase !== "ready") return;
    if (event && (!event.isPrimary || event.button !== 0)) return;
    if (event) takeOver();
    event?.preventDefault();
    castPointerId = event?.pointerId ?? null;
    if (event && castControl) castControl.setPointerCapture(event.pointerId);
    castPower = 0;
    castStartedAt = performance.now();
    phase = "casting";
    startLoop();
  }

  function finishCast(event?: PointerEvent): void {
    if (event && castPointerId !== null && event.pointerId !== castPointerId) return;
    event?.preventDefault();
    if (phase !== "casting" || !open) {
      releasePointer(castControl, castPointerId);
      castPointerId = null;
      return;
    }
    stopLoop();
    releasePointer(castControl, castPointerId);
    castPointerId = null;
    const power = castPowerAt(performance.now() - castStartedAt);
    castPower = power;
    const sent = activeSession.interactions.castFishing(open.session, power);
    phase = sent ? "waiting" : "ready";
    if (sent) activeSession.audio.playLocal("fishing", "cast");
  }

  function handleCastKeyDown(event: KeyboardEvent): void {
    if (!event.repeat && (event.code === "Space" || event.code === "Enter")) {
      event.preventDefault();
      event.stopPropagation();
      takeOver();
      beginCast();
    }
  }

  function handleCastKeyUp(event: KeyboardEvent): void {
    if (event.code === "Space" || event.code === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      finishCast();
    }
  }

  function hook(): void {
    if (phase !== "bite" || bitePercent <= 0 || !open) return;
    stopLoop();
    if (activeSession.interactions.hookFishing(open.session)) {
      activeSession.audio.playLocal("fishing", "hook");
      phase = "hooking";
    } else startLoop();
  }

  function handleGamePointerDown(event: PointerEvent): void {
    takeOver();
    if (phase === "bite") {
      event.preventDefault();
      hook();
    } else if (phase === "fight" && event.isPrimary && event.button === 0) {
      event.preventDefault();
      fightPointerId = event.pointerId;
      gameControl?.setPointerCapture(event.pointerId);
      held = true;
    }
  }

  function releaseFight(event?: PointerEvent): void {
    if (event && fightPointerId !== null && event.pointerId !== fightPointerId) return;
    releasePointer(gameControl, fightPointerId);
    fightPointerId = null;
    held = false;
  }

  function handleGameKeyDown(event: KeyboardEvent): void {
    if (event.code !== "Space") return;
    event.preventDefault();
    if (event.repeat) return;
    takeOver();
    if (phase === "bite") hook();
    else if (phase === "fight") held = true;
  }

  function stopFishing(): void {
    // Closing is the player taking over, and reports as such rather than as
    // the session ending.
    takeOver();
    if (open) activeSession.interactions.cancelFishing(open.session);
  }

  $effect(() => {
    const unsubscribe = activeSession.interactions.subscribe((snapshot) => {
      untrack(() => reconcile(snapshot.fishing));
    });
    const unsubscribeAuto = activeSession.fishingAuto.subscribe((snapshot) => {
      untrack(() => reconcileAuto(snapshot));
    });
    const unsubscribeConnection = activeSession.subscribeConnection((snapshot) => {
      if (snapshot.state === "connected") return;
      stopMotion();
      stopReel();
      tensionWarned = false;
      sim = null;
      resultReported = true;
    });
    return () => {
      unsubscribe();
      unsubscribeAuto();
      unsubscribeConnection();
      stopMotion();
      stopReel();
      tensionWarned = false;
      const current = activeSession.interactions.getSnapshot().fishing.open;
      if (current) activeSession.interactions.cancelFishing(current.session);
    };
  });
</script>

<section class="fishing-body" data-panel-id={panelId} data-workspace-owned="true">
  <div
    class:fish-running={fightState?.running}
    class="fishing-stage"
    data-phase={phase}
    data-terrain={open?.terrain ?? ""}
    data-auto={auto.enabled ? "on" : "off"}
  >
    {#if auto.enabled}<div class="fishing-auto-badge" aria-hidden="true">AUTO</div>{/if}
    <button class="fishing-close" type="button" aria-label="Stop fishing" onclick={stopFishing}
      >&#x2715;</button
    >
    {#if sceneUrl}<img class="fishing-scene" src={sceneUrl} alt="" draggable="false" />{/if}
    <div class="fishing-water"></div>

    {#if phase === "bite" || phase === "fight"}
      <button
        bind:this={gameControl}
        class="fishing-stage-control"
        type="button"
        aria-label={phase === "bite" ? "Hook fish" : "Hold to reel; release to lower the bar"}
        aria-describedby={instructionsId}
        aria-keyshortcuts="Space"
        onpointerdown={handleGamePointerDown}
        onpointerup={releaseFight}
        onpointercancel={releaseFight}
        onpointerleave={() => releaseFight()}
        onkeydown={handleGameKeyDown}
        onkeyup={(event) => {
          if (event.code === "Space") releaseFight();
        }}
        onblur={() => releaseFight()}
      ></button>
    {/if}

    {#if phase === "waiting" || phase === "bite"}
      <div class="fishing-bobber"><div class="fishing-bobber-top"></div></div>
    {/if}

    {#if phase === "bite"}
      <div class="fishing-exclaim" aria-hidden="true">!</div>
      <div
        class="fishing-bitebar"
        role="progressbar"
        aria-label="Time to hook"
        aria-valuenow={bitePercent}
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="fishing-bitebar-fill" style:width={`${bitePercent}%`}></div>
      </div>
      <div class="fishing-bitehelp">
        <div class="fishing-bitehelp-kicker">Bite</div>
        <div class="fishing-bitehelp-title">A fish is on the line</div>
        <div class="fishing-bitehelp-action">Tap, click, or press Space before time runs out.</div>
      </div>
    {:else if phase === "waiting"}
      <div class="fishing-waiting">
        <div class="fishing-waiting-kicker">Line cast</div>
        <div class="fishing-waiting-title">Waiting for a bite</div>
        <div class="fishing-waiting-dots" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <div class="fishing-waiting-flavor">Waiting patiently, or at least convincingly.</div>
      </div>
    {:else if phase === "hooking"}
      <div class="fishing-hooking">
        <div class="fishing-hooking-kicker">Fish hooked</div>
        <div class="fishing-hooking-title">Getting it on the line</div>
        <div class="fishing-hooking-dots" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <div class="fishing-hooking-help">Get ready to hold and release when the fight starts.</div>
      </div>
    {:else if phase === "fight" && fightState && fishing.fight}
      <div class="fishing-fightview">
        <div class="fishing-track">
          <div
            class="fishing-fish"
            style:bottom={`${fightState.fishPos}%`}
            style:transform="translateY(50%)"
          >
            <img src={fightArt} alt="" draggable="false" />
          </div>
          <div
            class="fishing-bar"
            style:bottom={`${fightState.barPos}%`}
            style:height={`${fishing.fight.params.barSize}%`}
            style:transform="translateY(50%)"
          ></div>
        </div>
        <div class="fishing-meters">
          <div
            class="fishing-meter fishing-progress"
            role="progressbar"
            aria-label="Catch progress"
            aria-valuenow={fightState.progress}
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="fishing-meter-fill" style:width={`${fightState.progress}%`}></div>
            <span>Catch</span>
          </div>
          <div
            class="fishing-meter fishing-tension"
            role="progressbar"
            aria-label="Line tension"
            aria-valuenow={fightState.tension}
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class:warn={fightState.tension > 60}
              class:hot={fightState.tension > 85}
              class="fishing-meter-fill"
              style:width={`${fightState.tension}%`}
            ></div>
            <span>Tension</span>
          </div>
        </div>
      </div>
    {:else if phase === "caught" && caught}
      <div
        class:pristine={Boolean(caught.fish.pristine)}
        class="fishing-trophy"
        style={`--fishing-rarity: ${rarityColor}`}
      >
        <img class="fishing-trophy-art" src={trophyArt} alt={caught.fish.name} draggable="false" />
        <div class="fishing-trophy-name">{caught.fish.name}</div>
        <div class="fishing-trophy-details">
          {[
            caught.fish.rarity.toUpperCase(),
            caught.fish.sizeCm ? `${caught.fish.sizeCm} cm` : "",
            caught.fish.weightKg ? `${caught.fish.weightKg} kg` : "",
            `quality ${caught.fish.quality}`,
            caught.fish.pristine ? "PRISTINE" : "",
          ]
            .filter(Boolean)
            .join(" | ")}
        </div>
        {#if rewardText}<div class="fishing-trophy-status">{rewardText}</div>{/if}
      </div>
    {/if}

    <div id={instructionsId} class="fishing-message" aria-live="polite">
      {#if phase === "idle"}
        {fishing.end?.message ?? 'Find some water, then type "fish" to open a session.'}
      {:else if phase === "nobait"}
        Your hook is bare. Use "bait hook" first, then "fish" again.
      {:else if phase === "ready"}
        Hold the button to charge your cast; release to let fly.
      {:else if phase === "waiting"}
        Your line is in the {open?.terrain ?? "water"}. Watch for the bite.
      {:else if phase === "bite"}
        A fish is biting. Hook it before time runs out.
      {:else if phase === "hooking"}
        Hook set. Getting the fish on the line...
      {:else if phase === "fight"}
        Hold anywhere or press Space to raise the green bar. Release to let it fall.
      {:else if phase === "resolving"}
        Waiting for the catch result...
      {:else if phase === "escaped"}
        {ESCAPE_TEXT[fishing.escaped?.reason ?? "slack"] ?? ESCAPE_TEXT.slack}
      {/if}
      {#if autoHaltVisible}
        Auto-Angler stopped: {auto.haltReason}
      {/if}
    </div>

    {#if phase === "ready" || phase === "casting"}
      <div class="fishing-powerwrap">
        <div
          class="fishing-power"
          role="meter"
          aria-label="Cast power"
          aria-valuenow={castPower}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            class:hot={castPower > 70}
            class="fishing-power-fill"
            style:height={`${castPower}%`}
          ></div>
        </div>
        <button
          bind:this={castControl}
          class="fishing-cast-btn"
          type="button"
          onpointerdown={beginCast}
          onpointerup={finishCast}
          onpointercancel={finishCast}
          onkeydown={handleCastKeyDown}
          onkeyup={handleCastKeyUp}>Hold to Cast</button
        >
      </div>
    {/if}

    <div class="fishing-status" aria-live="polite">
      {#if auto.enabled}
        {auto.summary}
      {:else if phase === "bite"}
        Tap anywhere in the fishing pane, click, or press Space now.
      {:else if phase === "fight"}
        Keep the green bar over the fish. Ease off when tension gets hot.
      {:else if phase === "hooking"}
        The fight will begin as soon as the fish pulls.
      {:else if phase === "escaped"}
        Re-bait your hook to try again.
      {/if}
    </div>
  </div>
  <div class="fishing-auto-strip">
    <button
      class="fishing-auto-toggle"
      type="button"
      aria-pressed={auto.enabled}
      title="Let the Auto-Angler play the mini-game. Any press on the stage hands control back."
      onclick={() => activeSession.fishingAuto.toggle()}
    >
      Auto: {auto.enabled ? "ON" : "OFF"}
    </button>
    <span class="fishing-auto-summary">
      {#if auto.enabled}
        {auto.summary}
      {:else if auto.haltReason}
        Stopped: {auto.haltReason}
      {:else}
        Plays the mini-game for you. Type /autofish for status.
      {/if}
    </span>
  </div>
</section>

<style>
  .fishing-stage-control {
    position: absolute;
    inset: 0;
    z-index: 6;
    border: 0;
    background: transparent;
    cursor: pointer;
    touch-action: none;
  }

  .fishing-stage-control:focus-visible {
    outline: 2px solid var(--df-accent);
    outline-offset: -3px;
  }
</style>
