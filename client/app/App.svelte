<script lang="ts">
  import Newspaper from "@lucide/svelte/icons/newspaper";
  import Settings from "@lucide/svelte/icons/settings";
  import { untrack } from "svelte";
  import { fetchRuntimeClientVersion, type ShellBootstrap } from "./bootstrap-transaction.ts";
  import type { Session, SessionConnectionSnapshot } from "../runtime/session.ts";
  import type { ConnectionHealthSnapshot } from "../runtime/connection-health.ts";
  import type { TransportEndpoint, TransportName } from "../transport/types.ts";
  import WorkspaceHost from "../workspace/WorkspaceHost.svelte";
  import AudioControls from "./AudioControls.svelte";
  import AnnouncementsOverlay from "./AnnouncementsOverlay.svelte";
  import BroadcastOverlay from "./BroadcastOverlay.svelte";
  import GiphyOverlay from "./GiphyOverlay.svelte";
  import LinuxRescueOverlay from "./LinuxRescueOverlay.svelte";
  import NotificationsMenu from "./NotificationsMenu.svelte";
  import ServerWindowHost from "./ServerWindowHost.svelte";
  import SettingsDialog from "./SettingsDialog.svelte";
  import SnoopOverlay from "./SnoopOverlay.svelte";
  import TutorialOverlay from "./TutorialOverlay.svelte";
  import VisualEffectsLayer from "./VisualEffectsLayer.svelte";
  import { loadClientSettings, saveLastLoginHost } from "./client-settings.ts";
  // @ts-expect-error Legacy UI module has no declaration file.
  import { gameTitle } from "../../public/js/brand.js";
  // @ts-expect-error Legacy UI module has no declaration file.
  import { formatUpdateMessage } from "../../public/js/desktop-integration.js";
  // @ts-expect-error Legacy UI module has no declaration file.
  import { applyTheme, BUILTIN_THEMES, DEFAULT_THEME_KEY } from "../../public/js/theme-manager.js";
  // @ts-expect-error Retained background data has no declaration file.
  import { applyBackground } from "../../public/js/background-manager.js";

  type UpdateStatus = {
    state: string;
    version?: string;
    percent?: number;
    message?: string;
  };

  type DesktopApi = {
    getInfo(): Promise<{ updateStatus?: UpdateStatus; version?: string }>;
    checkForUpdates(): Promise<unknown> | unknown;
    installUpdate(): Promise<unknown> | unknown;
    onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  };

  let {
    endpoint,
    session,
    shell,
  }: { endpoint: TransportEndpoint; session: Session; shell: ShellBootstrap } = $props();

  let snapshot = $state<SessionConnectionSnapshot>(untrack(() => session.getConnectionSnapshot()));
  let host = $state(untrack(() => endpoint.host));
  let port = $state(untrack(() => endpoint.port));
  let protocol = $state<TransportName>(untrack(() => endpoint.protocol));
  let now = $state(Date.now());
  let workspaceToolbar = $state<HTMLElement>();
  let workspaceHost = $state<{
    navigateTerminalLine(lineId: number): boolean;
    draftTerminalCommand(command: string): boolean;
    removeTerminalViewForTest(): Promise<void>;
    restoreTerminalViewForTest(): Promise<void>;
  }>();
  let updateStatus = $state<UpdateStatus | null>(null);
  let clientVersion = $state<string | null>(untrack(() => shell.clientVersion));
  let settingsOpen = $state(false);
  let settingsButton = $state<HTMLButtonElement>();
  let settingsDialog = $state<{ close(): void }>();
  let announcementsOpen = $state(false);
  let announcementsButton = $state<HTMLButtonElement>();
  let interactionSnapshot = $state(untrack(() => session.interactions.getSnapshot()));
  let visualSnapshot = $state(untrack(() => session.visualEffects.getSnapshot()));
  let themeKey = $state(untrack(() => session.configuration.getSnapshot().themeKey));
  let health = $state<ConnectionHealthSnapshot>(
    untrack(() => session.connectionHealth.getSnapshot()),
  );
  let rfc2549Enabled = $state(false);
  let debugGmcp = $state(untrack(() => loadClientSettings(localStorage).settings.gmcpDebugEnabled));
  let rfc2549QosOverride = $state<string | null>(null);
  let manualRedMarks = $state<Array<{ ts: string; type: string; detail: unknown }>>([]);

  export const removeTerminalViewForTest = (): Promise<void> =>
    workspaceHost?.removeTerminalViewForTest() ?? Promise.resolve();
  export const restoreTerminalViewForTest = (): Promise<void> =>
    workspaceHost?.restoreTerminalViewForTest() ?? Promise.resolve();

  const redEventTypes = new Set([
    "force-reconnect",
    "send-error",
    "message-handler-error",
    "ws-send-error",
    "ws-gmcp-send-error",
  ]);
  const recentRfcEvents = $derived(health.transport.events.slice(-8));
  const rfcRedMarks = $derived(
    recentRfcEvents.filter(({ type }) => redEventTypes.has(type)).length + manualRedMarks.length,
  );
  const rfcQos = $derived.by(() => {
    if (rfc2549QosOverride) return rfc2549QosOverride;
    if (!health.inputs.connected || health.transport.stalledAt || rfcRedMarks > 0) return "Coach";
    if (health.transport.bufferedAmount > 65_536) return "Business";
    if (health.transport.recentCommandCount >= 3) return "First";
    return "Concorde";
  });
  const incomingVisualMotion = $derived(
    !shell.zorkOnly &&
      !visualSnapshot.reducedMotion &&
      visualSnapshot.enabled &&
      visualSnapshot.preferences.incomingDamage &&
      visualSnapshot.activeCues.some(({ slot }) => slot === "incoming"),
  );
  const outgoingVisualMotion = $derived(
    !shell.zorkOnly &&
      !visualSnapshot.reducedMotion &&
      visualSnapshot.enabled &&
      visualSnapshot.preferences.outgoingDamage &&
      visualSnapshot.activeCues.some(({ slot }) => slot === "outgoing"),
  );

  const secondsUntilRetry = $derived(
    snapshot.reconnect?.nextAttemptAt
      ? Math.max(0, Math.ceil((snapshot.reconnect.nextAttemptAt - now) / 1000))
      : 0,
  );
  const connectionStatus = $derived.by(() => {
    if (snapshot.state === "connecting") return "Connecting";
    if (snapshot.state === "connected") return "Connected";
    if (snapshot.reconnect?.status === "scheduled") return "Disconnected. Retry scheduled.";
    return "Disconnected";
  });

  function applyClientSettings(): void {
    const settings = loadClientSettings(localStorage).settings;
    debugGmcp = settings.gmcpDebugEnabled;
    const customTheme = settings.customThemes[themeKey];
    applyTheme(customTheme ?? BUILTIN_THEMES[themeKey] ?? BUILTIN_THEMES[DEFAULT_THEME_KEY]);
    applyBackground(settings.background);
    document.documentElement.style.setProperty(
      "--df-side-rail-opacity",
      `${settings.sideRailOpacity}%`,
    );
    document.documentElement.style.setProperty(
      "--df-terminal-background-alpha",
      String(settings.terminalBackgroundOpacity / 100),
    );
    if (settings.terminalFontFamily)
      document.documentElement.style.setProperty(
        "--df-terminal-font-family",
        settings.terminalFontFamily,
      );
    else document.documentElement.style.removeProperty("--df-terminal-font-family");
    if (settings.terminalFontSize)
      document.documentElement.style.setProperty(
        "--df-terminal-font-size",
        `${settings.terminalFontSize}px`,
      );
    else document.documentElement.style.removeProperty("--df-terminal-font-size");
  }

  $effect(() => {
    applyClientSettings();
    document.title = gameTitle(shell.gameName);
  });

  $effect(() => {
    window.addEventListener("darkflow:client-settings-changed", applyClientSettings);
    return () =>
      window.removeEventListener("darkflow:client-settings-changed", applyClientSettings);
  });

  $effect(() => session.configuration.subscribe((next) => (themeKey = next.themeKey)));
  $effect(() => session.connectionHealth.subscribe((next) => (health = next)));
  $effect(() => session.interactions.subscribe((next) => (interactionSnapshot = next)));
  $effect(() => session.visualEffects.subscribe((next) => (visualSnapshot = next)));
  $effect(() => session.visualEffects.configure(loadClientSettings(localStorage).settings));

  $effect(() => {
    const truthy = (value: string | null): boolean =>
      value !== null && ["", "1", "true", "yes", "on"].includes(value.trim().toLowerCase());
    const params = new URLSearchParams(location.search);
    try {
      rfc2549Enabled = params.has("rfc2549")
        ? truthy(params.get("rfc2549"))
        : truthy(localStorage.getItem("darkflow-rfc2549"));
    } catch {
      rfc2549Enabled = params.has("rfc2549") && truthy(params.get("rfc2549"));
    }

    const api = {
      enable: () => setRfc2549Enabled(true),
      disable: () => setRfc2549Enabled(false),
      toggle: () => setRfc2549Enabled(!rfc2549Enabled),
      snapshot: () => ({
        enabled: rfc2549Enabled,
        qos: rfcQos,
        route: rfcRoute(),
        bytes: {
          sent: health.transport.bytesSent,
          received: health.transport.bytesReceived,
          total: health.transport.bytesSent + health.transport.bytesReceived,
        },
        redMarks: rfcRedMarks,
        pulseRate: rfcPulse(),
        socket: health.transport,
      }),
      setQoS: (className: string) => {
        rfc2549QosOverride = className.trim() || null;
      },
      markRed: (reason?: string) => {
        manualRedMarks = [
          ...manualRedMarks,
          {
            ts: new Date().toISOString(),
            type: "manual-red",
            detail: { reason: reason || "manual mark" },
          },
        ].slice(-20);
      },
    };
    const target = window as typeof window & { rfc2549Debug?: typeof api };
    target.rfc2549Debug = api;
    return () => {
      if (target.rfc2549Debug === api) delete target.rfc2549Debug;
    };
  });

  $effect(() => {
    session.setConnectionEndpoint(endpoint);
    const unsubscribe = session.subscribeConnection((next) => {
      // The subscription delivers the current snapshot synchronously, so this
      // callback runs inside the effect. Reading snapshot here would make the
      // effect depend on the state it writes and loop until Svelte aborts it.
      const previous = untrack(() => snapshot);
      if (next.state === "connected" && previous.state !== "connected") {
        saveLastLoginHost(localStorage, next.endpoint.host);
      }
      snapshot = next;
    });
    if (shell.shouldAutoConnect) session.connect();
    return unsubscribe;
  });

  $effect(() => {
    session.setConnectionEndpoint(readConnectionEndpoint());
    if (!host.trim() && snapshot.reconnect?.status === "scheduled") session.disconnect();
  });

  $effect(() => {
    if (snapshot.reconnect?.status !== "scheduled") return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(timer);
  });

  $effect(() => {
    const desktop = (window as typeof window & { darkflowDesktop?: DesktopApi }).darkflowDesktop;
    if (desktop) {
      let disposed = false;
      const render = (status: UpdateStatus) => {
        if (!disposed) updateStatus = status;
      };
      const unsubscribe = desktop.onUpdateStatus(render);
      void desktop
        .getInfo()
        .then((info) => {
          if (info.version) clientVersion = info.version;
          if (info.updateStatus) render(info.updateStatus);
        })
        .catch(() => {});
      return () => {
        disposed = true;
        unsubscribe();
      };
    }

    let disposed = false;
    const fetchVersion = async () => {
      const version = await fetchRuntimeClientVersion();
      if (!disposed && version) {
        if (clientVersion && clientVersion !== "unknown" && clientVersion !== version)
          updateStatus = { state: "browser-update" };
        clientVersion = version;
      }
    };
    if (clientVersion === "unknown") void fetchVersion();
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible") void fetchVersion();
      },
      5 * 60 * 1000,
    );
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  });

  function readConnectionEndpoint(): TransportEndpoint {
    return {
      host: host.trim(),
      port: port.trim() || "4242",
      protocol,
    };
  }

  function connect(event?: SubmitEvent): void {
    event?.preventDefault();
    const next = readConnectionEndpoint();
    session.setConnectionEndpoint(next);
    persistProtocol(protocol);
    if (snapshot.reconnect?.status === "scheduled") session.retryConnection();
    else session.connect();
  }

  function persistProtocol(value: TransportName): void {
    try {
      localStorage.setItem("darkflow-protocol", value);
    } catch {
      // Private browsing and quota failures leave the current selection usable.
    }
  }

  const updateDisplay = $derived(
    updateStatus?.state === "browser-update"
      ? { message: "A new client version is available.", action: "Refresh to update" }
      : updateStatus
        ? formatUpdateMessage(updateStatus)
        : null,
  );

  function runUpdateAction(): void {
    const desktop = (window as typeof window & { darkflowDesktop?: DesktopApi }).darkflowDesktop;
    const operation = desktop
      ? ["downloaded", "manual"].includes(updateStatus?.state ?? "")
        ? desktop.installUpdate()
        : desktop.checkForUpdates()
      : location.reload();
    Promise.resolve(operation).catch(() => {});
  }

  function setRfc2549Enabled(enabled: boolean): void {
    rfc2549Enabled = enabled;
    try {
      if (enabled) localStorage.setItem("darkflow-rfc2549", "1");
      else localStorage.removeItem("darkflow-rfc2549");
    } catch {
      // The URL opt-in remains usable when storage is unavailable.
    }
  }

  function formatBytes(value: number): string {
    if (value < 1_024) return `${value} B`;
    if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
    return `${(value / 1_048_576).toFixed(1)} MB`;
  }

  function rfcRoute(): string {
    const { protocol, host, port } = health.endpoint;
    return `${protocol}${protocol.startsWith("telnet") ? " bridge" : " direct"} to ${host}:${port}`;
  }

  function rfcPulse(): string {
    if (recentRfcEvents.length < 2) return "idle";
    const first = Date.parse(recentRfcEvents[0]?.ts ?? "");
    const last = Date.parse(recentRfcEvents.at(-1)?.ts ?? "");
    return Number.isFinite(first) && Number.isFinite(last) && last > first
      ? `${(recentRfcEvents.length / ((last - first) / 60_000)).toFixed(1)}/min`
      : `${recentRfcEvents.length} events`;
  }

  function activateNotification(id: number): boolean {
    const lineId = session.notifications.activate(id);
    if (lineId !== null && workspaceHost?.navigateTerminalLine(lineId)) return true;
    session.notifications.markExpired(id);
    return false;
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (rfc2549Enabled && event.key === "Escape") setRfc2549Enabled(false);
  }}
/>

<main
  class:dw-visual-impact-shake={incomingVisualMotion}
  class:dw-visual-attack-lunge={outgoingVisualMotion}
  data-testid="phase2-shell"
  data-session-id={session.sessionId}
  tabindex="-1"
>
  <div class="workspace-background" aria-hidden="true"></div>
  <header class="app-chrome">
    <h1 class="toolbar-brand">
      <img src="/assets/brand/darkflow-icon-64.png" alt="" aria-hidden="true" />
      <span>{gameTitle(shell.gameName)}</span>
    </h1>

    <form class="connection-form" aria-label="Connection" onsubmit={connect}>
      {#if !shell.zorkOnly}
        <input
          id="host"
          aria-label="Host"
          placeholder="Host"
          bind:value={host}
          autocomplete="url"
        />
        <span class="connection-separator" aria-hidden="true">:</span>
        <input
          id="port"
          aria-label="Port"
          type="number"
          inputmode="numeric"
          min="1"
          max="65535"
          value={port}
          oninput={(event) => (port = event.currentTarget.value)}
        />
        <select
          id="protocol-select"
          aria-label="Connection protocol"
          bind:value={protocol}
          onchange={(event) => persistProtocol(event.currentTarget.value as TransportName)}
        >
          <option value="wss">wss</option>
          <option value="ws">ws</option>
          <option value="telnets">telnets</option>
          <option value="telnet">telnet</option>
        </select>
      {:else}
        <p>Darkwind connection</p>
      {/if}

      <button
        type="submit"
        hidden
        disabled={snapshot.state !== "disconnected" || (!shell.zorkOnly && !host.trim())}
        >Connect</button
      >
      <button
        id="connect-btn"
        class:connected={snapshot.state === "connected"}
        class:connecting={snapshot.state === "connecting"}
        class:retrying={snapshot.reconnect?.status === "scheduled"}
        class:disconnected={snapshot.state === "disconnected" &&
          snapshot.reconnect?.status !== "scheduled"}
        type="button"
        disabled={!shell.zorkOnly && snapshot.state === "disconnected" && !host.trim()}
        title={snapshot.state === "connecting"
          ? "Cancel connection attempt"
          : snapshot.reconnect?.status === "scheduled"
            ? "Cancel automatic retry"
            : undefined}
        onclick={() =>
          snapshot.state === "disconnected" && snapshot.reconnect?.status !== "scheduled"
            ? connect()
            : session.disconnect()}
      >
        {snapshot.state === "connected"
          ? "Disconnect"
          : snapshot.state === "connecting"
            ? "Connecting"
            : snapshot.reconnect?.status === "scheduled"
              ? `Retrying in ${secondsUntilRetry}s`
              : "Connect"}
      </button>
    </form>

    <p data-testid="connection-status" role="status" aria-live="polite" class="app-chrome-status">
      {connectionStatus}
    </p>

    <div class="app-actions">
      <AudioControls {session} />
      <NotificationsMenu {session} onactivate={activateNotification} />
      <button
        bind:this={announcementsButton}
        class="toolbar-icon-btn"
        type="button"
        title="Announcements"
        aria-label="Announcements"
        onclick={() => (announcementsOpen = true)}
      >
        <Newspaper size={16} />
        {#if interactionSnapshot.announcements.unreadCount > 0}
          <span class="toolbar-count-badge" aria-label="Unread announcements">
            {interactionSnapshot.announcements.unreadCount}
          </span>
        {/if}
      </button>
      <span class="toolbar-separator"></span>
      <div class="app-workspace-slot" bind:this={workspaceToolbar}></div>
      <span class="toolbar-separator"></span>
      <button
        bind:this={settingsButton}
        class="toolbar-icon-btn"
        type="button"
        title="Settings"
        aria-label="Settings"
        aria-expanded={settingsOpen}
        onclick={() => (settingsOpen ? settingsDialog?.close() : (settingsOpen = true))}
      >
        <Settings size={16} />
      </button>
    </div>
  </header>

  <WorkspaceHost
    bind:this={workspaceHost}
    characterProfileId={session.characterProfileId}
    presentationAllowed={!shell.zorkOnly}
    {debugGmcp}
    {session}
    {workspaceToolbar}
  />
</main>

<SettingsDialog
  bind:this={settingsDialog}
  {clientVersion}
  open={settingsOpen}
  {session}
  onclose={() => {
    settingsOpen = false;
    queueMicrotask(() => settingsButton?.focus());
  }}
/>

<ServerWindowHost {session} />
<SnoopOverlay {session} />
<AnnouncementsOverlay
  open={announcementsOpen}
  {session}
  onclose={() => {
    announcementsOpen = false;
    queueMicrotask(() => announcementsButton?.focus());
  }}
/>
<GiphyOverlay {session} />
<BroadcastOverlay {session} />
<LinuxRescueOverlay {session} />
{#if !shell.zorkOnly}
  <TutorialOverlay
    tutorial={session.tutorial}
    onExampleCommand={(command) => workspaceHost?.draftTerminalCommand(command)}
  />
  <VisualEffectsLayer {session} />
{/if}

{#if rfc2549Enabled}
  <section
    class="rfc2549-debug-panel"
    aria-label="RFC 2549 debug panel"
    data-qos={rfcQos.toLowerCase()}
  >
    <div class="rfc2549-header">
      <div>
        <span class="rfc2549-kicker">RFC 2549</span>
        <h2>Avian QoS</h2>
      </div>
      <button
        type="button"
        class="rfc2549-close"
        title="Disable RFC 2549 debug"
        onclick={() => setRfc2549Enabled(false)}>×</button
      >
    </div>
    <div class="rfc2549-body">
      {#each [["QoS class", rfcQos], ["Route", rfcRoute()], ["Frequent flyer miles", formatBytes(health.transport.bytesSent + health.transport.bytesReceived)], ["Carrier queue", String(recentRfcEvents.length)], ["RED-marked packets", String(rfcRedMarks)], ["Pulse rate", rfcPulse()]] as [label, value] (label)}
        <div class="rfc2549-row"><span>{label}</span><strong>{value}</strong></div>
      {/each}
      <ol class="rfc2549-events">
        {#each recentRfcEvents as event (event)}
          <li><span>{new Date(event.ts).toLocaleTimeString()}</span>{event.type}</li>
        {:else}
          <li><span>--:--:--</span>carrier queue idle</li>
        {/each}
      </ol>
      <div class="rfc2549-footnote">RFC 2549 debug visualization only. Transport is unchanged.</div>
    </div>
  </section>
{/if}

{#if updateDisplay}
  <aside class="update-banner" data-testid="update-banner" aria-live="polite">
    <span>{updateDisplay.message}</span>
    {#if updateDisplay.action}
      <button type="button" onclick={runUpdateAction}>{updateDisplay.action}</button>
    {/if}
  </aside>
{/if}

<style>
  main {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    min-height: 100dvh;
    padding: 0;
    background: var(--df-bg, #0d1117);
    color: var(--df-text, #c9d1d9);
    position: relative;
    isolation: isolate;
  }
  .workspace-background {
    position: absolute;
    z-index: 0;
    inset: 0;
    pointer-events: none;
    background-image:
      linear-gradient(
        rgb(0 0 0 / var(--df-background-dim, 0)),
        rgb(0 0 0 / var(--df-background-dim, 0))
      ),
      var(--df-background-image, none);
    background-position: center, var(--df-background-position);
    background-repeat: no-repeat, repeat-x;
    background-size:
      100% 100%,
      auto 100%;
  }
  .app-chrome,
  :global(.workspace-shell) {
    position: relative;
    z-index: 1;
  }

  .app-chrome {
    z-index: 2;
    display: flex;
    gap: 8px;
    align-items: center;
    /* Wide screens use one stable row; narrower screens move the intact
       connection form to a deliberate second row below. */
    flex-wrap: nowrap;
    height: 42px;
    min-height: 42px;
    min-width: 0;
    padding: 0 10px;
    border-bottom: 1px solid var(--df-border, #30363d);
    margin-bottom: 0;
    background:
      linear-gradient(90deg, rgb(66 214 201 / 8%), transparent 34%), var(--df-panel, #161b22);
  }

  .app-chrome .toolbar-brand {
    margin: 0 6px 0 0;
  }

  .app-actions {
    display: flex;
    flex: 0 0 auto;
    gap: 3px;
    margin-left: auto;
    align-items: center;
  }

  /* Keep the workspace toolbar compact enough to fit on one desktop row. */
  .app-chrome-status,
  .app-workspace-slot {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 12px;
    color: var(--df-muted, #8b949e);
  }
  .app-workspace-slot {
    flex: 0 0 auto;
    min-width: 0;
    overflow: visible;
  }
  .app-chrome-status {
    position: absolute;
    width: 1px;
    height: 1px;
    min-width: 0;
    max-width: none;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  /*
   * Svelte prunes CSS whose left-hand match doesn't appear in this component's
   * template; the portalled children arrive at runtime, so the whole rule must
   * be `:global` -- otherwise Svelte strips it and the paragraph inflates back
   * to full row width, pushing the actions block onto its own line.
   */
  :global(.app-workspace-slot > *) {
    margin: 0;
    flex: 0 0 auto;
    width: auto;
  }
  /* Keep workspace save/recovery announcements available to assistive tech. */
  :global(.app-workspace-slot .workspace-status) {
    position: absolute;
    width: 1px;
    height: 1px;
    min-width: 0;
    max-width: none;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .app-actions button {
    position: relative;
  }

  h1,
  p {
    margin: 0;
  }

  .connection-form {
    display: flex;
    align-items: center;
  }

  .connection-form {
    flex: 0 0 auto;
    flex-wrap: nowrap;
    gap: 2px;
  }

  .connection-form input,
  .connection-form select {
    height: 26px;
    min-height: 0;
    padding: 3px 6px;
    border: 1px solid var(--df-border, #30363d);
    border-radius: 4px;
    background: var(--df-bg, #0d1117);
    color: var(--df-text, #c9d1d9);
    font-family: inherit;
    font-size: 12px;
  }

  .connection-form #host {
    width: 130px;
  }

  .connection-form #port {
    width: 64px;
    appearance: textfield;
  }

  .connection-form #port::-webkit-inner-spin-button,
  .connection-form #port::-webkit-outer-spin-button {
    margin: 0;
    appearance: none;
  }

  .connection-form button,
  .app-chrome :global(.toolbar-icon-btn) {
    min-height: 0;
  }

  #connect-btn {
    width: 112px;
    margin-left: 4px;
  }

  #connect-btn.disconnected {
    background: var(--df-ok, #3fb950);
    border-color: var(--df-ok, #3fb950);
  }

  #connect-btn.disconnected:hover {
    background: color-mix(in srgb, var(--df-ok, #3fb950) 82%, white);
  }

  #connect-btn.connected {
    background: linear-gradient(
      90deg,
      var(--df-accent-strong, #7ee7df),
      var(--df-text-strong, #f0f6fc) 78%
    );
    border-color: var(--df-accent-strong, #7ee7df);
    color: var(--df-bg, #0d1117);
  }

  #connect-btn.connecting {
    background: linear-gradient(90deg, #4b5563 0 35%, #d1d5db 50%, #4b5563 65% 100%);
    background-size: 200% 100%;
    border-color: #8b949e;
    opacity: 1;
    animation: connection-sweep 1.1s linear infinite;
  }

  #connect-btn.retrying {
    background: linear-gradient(90deg, #4b5563 0 35%, #d1d5db 50%, #4b5563 65% 100%);
    background-size: 200% 100%;
    border-color: #8b949e;
    animation: connection-sweep 1.1s linear infinite reverse;
  }

  @keyframes connection-sweep {
    from {
      background-position: 100% 0;
    }
    to {
      background-position: 0 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    #connect-btn.connecting,
    #connect-btn.retrying {
      animation: none;
    }
  }

  .connection-separator {
    color: var(--df-muted, #484f58);
  }

  /*
   * At mobile widths the toolbar can't fit; stack the three sections instead.
   * `.app-actions` stays right-aligned so its overlay-anchored expanded panel
   * (audio widget) has room to open to the left inside the viewport.
   */
  @media (max-width: 700px) {
    /*
     * Mobile viewports cannot fit the desktop single-row toolbar; allow
     * wrapping and split into two rows: [logo + title + actions] on row 1,
     * connection form on row 2. Desktop stays `nowrap` so layout is stable
     * for Dockview.
     */
    .app-chrome {
      flex-wrap: wrap;
      height: auto;
      padding: 6px 8px;
    }
    .app-chrome .connection-form {
      flex: 1 0 100%;
      flex-wrap: nowrap;
      order: 2;
    }
    .app-actions {
      flex-shrink: 0;
    }
    /*
     * The audio widget expanded panel is anchored to `#audio-widget-root` and
     * opens leftward via `right: -36; width: 300`, so the widget needs enough
     * space to its left inside the viewport. Reorder it to the end of the
     * actions row so it sits against the right edge on mobile.
     */
    /*
     * Svelte scopes `.app-actions`; audio-widget-root and its expanded panel
     * live in AudioControls, a different scope. Use :global so the reorder
     * and expanded-panel alignment actually reach them.
     */
    .app-actions :global(#audio-widget-root) {
      order: 99;
    }
    /*
     * Legacy CSS anchors the expanded panel with `right: -36px`, tuned to a
     * layout where the widget sat further from the viewport's right edge.
     * On the reordered mobile row the widget is now against the right edge,
     * so anchor the panel to `right: 0` -- it opens fully leftward inside
     * the viewport without spilling off the right.
     */
    .app-actions :global(.sound-widget-expanded) {
      right: 0;
    }

    .connection-form #host {
      width: 100px;
    }
  }

  input,
  select,
  button {
    min-height: 2.5rem;
  }

  :is(input, select, button):focus-visible {
    outline: 2px solid var(--df-accent-blue, #58a6ff);
    outline-offset: 2px;
  }

  .update-banner {
    position: fixed;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 1001;
    display: flex;
    gap: 0.75rem;
    align-items: center;
    max-width: calc(100vw - 1.5rem);
    padding: 0.75rem 1rem;
    border: 1px solid var(--df-warn, #d9931f);
    border-radius: 0.5rem;
    background: var(--df-panel, #161b22);
  }

  @media (max-width: 420px) {
    .update-banner {
      align-items: stretch;
      flex-direction: column;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
    }
  }
</style>
