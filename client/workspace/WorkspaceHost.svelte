<script lang="ts">
  import LayoutPanelLeft from "@lucide/svelte/icons/layout-panel-left";
  import PanelLeftClose from "@lucide/svelte/icons/panel-left-close";
  import PanelLeftOpen from "@lucide/svelte/icons/panel-left-open";
  import PanelRightClose from "@lucide/svelte/icons/panel-right-close";
  import PanelRightOpen from "@lucide/svelte/icons/panel-right-open";
  import { onMount, tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { InteractionWindow } from "../gmcp/contracts/interactions.ts";
  import type { CharacterProfileId } from "../model/ids";
  import type { InformationPanelId } from "../runtime/information.ts";
  import type { Session } from "../runtime/session.ts";
  import type { WorldPanelId } from "../runtime/world.ts";
  import { createWorkspace, type WorkspaceInspector } from "./dockview-workspace";
  import { LifecycleDiagnostics } from "./lifecycle-diagnostics";
  import { RAIL_DRAG_TYPE, Scrollview } from "./scrollview";
  import "./dockview-theme.css";
  import ChatPanel from "./ChatPanel.svelte";
  import InformationPanel from "./InformationPanel.svelte";
  import ConnectionHealthPanel from "./ConnectionHealthPanel.svelte";
  import CombatPanel from "./CombatPanel.svelte";
  import CommandBoardPanel from "./CommandBoardPanel.svelte";
  import BuffBarPanel from "./BuffBarPanel.svelte";
  import GuildBarPanel from "./GuildBarPanel.svelte";
  import VitalBarPanel from "./VitalBarPanel.svelte";
  import DpsPanel from "./DpsPanel.svelte";
  import FishingPanel from "./FishingPanel.svelte";
  import IdePanel from "./IdePanel.svelte";
  import MapPanel from "./MapPanel.svelte";
  import RoomImagePanel from "./RoomImagePanel.svelte";
  import RoomPanel from "./RoomPanel.svelte";
  import RoomPlaylistPanel from "./RoomPlaylistPanel.svelte";
  import GmcpDebugPanel from "./GmcpDebugPanel.svelte";
  import {
    loadCharacterWorkspace,
    saveCharacterWorkspace,
    type LegacyWorkspaceLayout,
  } from "./persistence";
  import TerminalPanel from "./TerminalPanel.svelte";
  import ServerWindowPanel from "./ServerWindowPanel.svelte";
  import { focusTerminalIsland } from "./terminal-island";
  // @ts-expect-error Retained zoom helper is JavaScript without declarations.
  import { normalizeMapZoom } from "../../public/js/map-zoom.js";
  import type {
    CompositeWorkspaceSnapshot,
    PanelPlacement,
    PersistedWorkspaceSnapshot,
    Workspace,
    WorkspacePanelSpec,
    WorkspaceRendererRegistry,
  } from "./workspace";

  const SHARED_VIDEO_GEOMETRY_KEY = "darkwind-shared-video-window-geometry";

  let {
    characterProfileId,
    presentationAllowed,
    debugGmcp,
    session,
    workspaceToolbar,
  }: {
    characterProfileId: CharacterProfileId;
    presentationAllowed: boolean;
    debugGmcp: boolean;
    session: Session;
    workspaceToolbar?: HTMLElement | undefined;
  } = $props();

  const terminal: WorkspacePanelSpec = {
    id: "terminal",
    kind: "terminal",
    title: "Terminal",
    state: {},
    // The >=940px rail-collapse breakpoint (260+260+420) already floors the
    // terminal at 420px wide on desktop; a hard width constraint would only
    // overflow narrower zones, so enforce the height minimum here.
    minSize: { height: 260 },
  };
  const informationPanelLabels: readonly [InformationPanelId, string][] = [
    ["avatar", "Avatar"],
    ["status", "Status"],
    ["vitals", "Vitals"],
    ["guildVitals", "Guild vitals"],
    ["xpmon", "XP monitor"],
    ["omens", "Omens"],
    ["sky", "Sky"],
    ["stats", "Stats"],
    ["buffs", "Buffs"],
    ["worth", "Worth"],
    ["group", "Group"],
    ["inventory", "Inventory"],
    ["quests", "Quests"],
    ["achievements", "Achievements"],
    ["cyberware", "Cyberware"],
    ["connection-health", "Connection health"],
  ];
  const informationPanels: readonly (WorkspacePanelSpec & { id: InformationPanelId })[] =
    informationPanelLabels.map(([id, title]) => ({
      id,
      kind: id,
      title,
      state: {},
      minSize: { width: 200, height: 80 },
      placement: { kind: "grid", direction: "right", referencePanelId: terminal.id },
    }));
  const worldPanels: readonly (WorkspacePanelSpec & { id: WorldPanelId })[] = [
    {
      id: "room",
      kind: "room",
      title: "Room",
      state: {},
    },
    {
      id: "map",
      kind: "map",
      title: "Map",
      state: { mapZoom: 1 },
      placement: { kind: "grid", direction: "right", referencePanelId: terminal.id },
    },
    {
      id: "roomImage",
      kind: "roomImage",
      title: "Room Image",
      state: {},
      placement: { kind: "grid", direction: "right", referencePanelId: terminal.id },
    },
    {
      id: "roomPlaylist",
      kind: "roomPlaylist",
      title: "Jukebox",
      state: {},
      placement: { kind: "grid", direction: "right", referencePanelId: terminal.id },
    },
  ];
  const areaMap: WorkspacePanelSpec & { id: WorldPanelId } = {
    id: "areaMap",
    kind: "areaMap",
    title: "Area Map",
    state: { mapZoom: 1 },
    placement: { kind: "floating", bounds: { left: 40, top: 40, width: 520, height: 420 } },
  };
  // The Scene: the player's figure in the current room, and the duel when a
  // fight is on. It keeps the "enemy" id the server-side tutorial and saved
  // layouts already know.
  const combatPanel: WorkspacePanelSpec = {
    id: "enemy",
    kind: "enemy",
    title: "Scene",
    state: {},
  };
  const chatPanel: WorkspacePanelSpec = {
    id: "chat",
    kind: "chat",
    title: "Chat",
    state: {},
  };
  const gmcpDebugPanel: WorkspacePanelSpec = {
    id: "gmcp-debug",
    kind: "gmcp-debug",
    title: "GMCP Debug",
    state: {},
  };
  const dpsPanel: WorkspacePanelSpec = {
    id: "dps",
    kind: "dps",
    title: "DPS Meter",
    state: {},
    minSize: { width: 200, height: 120 },
  };
  const commandBoardPanel: WorkspacePanelSpec = {
    id: "commandBoard",
    kind: "commandBoard",
    title: "Command Board",
    state: {},
    minSize: { width: 220, height: 100 },
  };
  // Single-bar vital readouts: floating, resizable copies of the HP and SP
  // rows of the Vitals panel, for players who want a big bar of their own
  // wherever they like. The ids are the ones vital-bar.ts knows.
  // Guild Resource slots show a meter from Darkwind.GuildVitals by position
  // (or a pinned id), so the menu never lists resources by guild.
  const vitalBarPanels: readonly WorkspacePanelSpec[] = [
    { id: "hpBar", kind: "hpBar", title: "HP Bar", state: {}, minSize: { width: 120, height: 40 } },
    { id: "spBar", kind: "spBar", title: "SP Bar", state: {}, minSize: { width: 120, height: 40 } },
    ...[1, 2, 3].map((slot): WorkspacePanelSpec => ({
      id: `guildBar${slot}`,
      kind: "guildBar",
      title: `Guild Resource ${slot}`,
      state: {},
      minSize: { width: 120, height: 40 },
    })),
    {
      id: "buffBar",
      kind: "buffBar",
      title: "Buff Bar",
      state: {},
      minSize: { width: 120, height: 40 },
    },
  ];

  type PanelMenuGroupName = "Character" | "Progress" | "Social" | "System" | "World";
  type PanelMenuItem = {
    group: PanelMenuGroupName;
    kind:
      | "information"
      | "world"
      | "chat"
      | "dps"
      | "scene"
      | "commandBoard"
      | "vitalBar"
      | "gmcp-debug";
    panel: WorkspacePanelSpec;
  };
  const informationPanelGroups: Record<InformationPanelId, PanelMenuGroupName> = {
    achievements: "Progress",
    avatar: "Character",
    buffs: "Character",
    "connection-health": "System",
    cyberware: "Character",
    group: "Social",
    guildVitals: "Character",
    inventory: "Character",
    omens: "World",
    quests: "Progress",
    rfc2549: "System",
    sky: "World",
    stats: "Character",
    status: "Character",
    vitals: "Character",
    worth: "Character",
    xpmon: "Progress",
  };
  const panelMenuItems = $derived<readonly PanelMenuItem[]>([
    ...informationPanels.map((panel): PanelMenuItem => ({
      group: informationPanelGroups[panel.id],
      kind: "information",
      panel,
    })),
    ...worldPanels.map((panel): PanelMenuItem => ({ group: "World", kind: "world", panel })),
    { group: "World", kind: "scene", panel: combatPanel },
    { group: "Social", kind: "chat", panel: chatPanel },
    { group: "Character", kind: "dps", panel: dpsPanel },
    ...vitalBarPanels.map((panel): PanelMenuItem => ({
      group: "Character",
      kind: "vitalBar",
      panel,
    })),
    { group: "System", kind: "commandBoard", panel: commandBoardPanel },
    ...(debugGmcp
      ? [{ group: "System" as const, kind: "gmcp-debug" as const, panel: gmcpDebugPanel }]
      : []),
  ]);
  const panelMenuGroups = $derived(
    (["Character", "Progress", "Social", "System", "World"] as const).map((title) => ({
      title,
      items: panelMenuItems
        .filter(({ group }) => group === title)
        .sort((left, right) => left.panel.title.localeCompare(right.panel.title)),
    })),
  );

  // Legacy "classic hybrid" default: terminal center, two ordered rails. Each
  // rail is its own Scrollview root, so cards size to their content under one
  // scrollbar instead of competing for a fixed grid extent.
  // Cyberware and Connection health stay launcher-only (available, not default).
  const leftRailOrder: readonly InformationPanelId[] = [
    "avatar",
    "status",
    "vitals",
    "guildVitals",
    "sky",
    "omens",
    "buffs",
    "worth",
    "xpmon",
    "stats",
  ];
  type DefaultRailPanelId = InformationPanelId | "room";
  type RailPanelId = DefaultRailPanelId | "map" | "roomImage" | "roomPlaylist";
  type RailSide = "left" | "right";
  const optionalRailPanelIds: readonly RailPanelId[] = ["map", "roomImage", "roomPlaylist"];
  const rightRailOrder: readonly DefaultRailPanelId[] = [
    "room",
    "group",
    "inventory",
    "quests",
    "achievements",
  ];

  function railPanelSpec(id: RailPanelId, state?: Record<string, unknown>): WorkspacePanelSpec {
    const panel = [...informationPanels, ...worldPanels].find(({ id: panelId }) => panelId === id);
    return panel
      ? { ...panel, state: state ?? panel.state }
      : { id, kind: id, title: id, state: {} };
  }

  function railEligible(id: string): id is RailPanelId {
    return (
      leftRailOrder.includes(id as InformationPanelId) ||
      rightRailOrder.includes(id as DefaultRailPanelId) ||
      optionalRailPanelIds.includes(id as RailPanelId)
    );
  }

  /**
   * Compact and mobile zones have no rails, so rail panels route to the Dockview
   * grid instead. Without this a panel opened from the mobile sheet lands in a
   * hidden rail: present in the DOM, but invisible and unclickable.
   */
  let railsEnabled = $state(true);

  /** Which rail a panel belongs to by configuration, open or not. */
  function railHomeFor(id: string): Scrollview | undefined {
    if (!railsEnabled) return undefined;
    if (leftRailOrder.includes(id as InformationPanelId)) return leftRail;
    if (rightRailOrder.includes(id as DefaultRailPanelId)) return rightRail;
    return undefined;
  }

  /** Which rail currently holds a panel. A floated-out card has no rail. */
  function railFor(id: string): Scrollview | undefined {
    if (!railsEnabled) return undefined;
    if (leftRail?.hasPanel(id)) return leftRail;
    if (rightRail?.hasPanel(id)) return rightRail;
    return undefined;
  }

  /**
   * Resolve a panel to whichever root owns it, so the launcher and the
   * visibility sync do not have to branch on rail membership. A panel that is
   * open somewhere resolves to that root; one that is closed resolves to the
   * root it would open into.
   */
  function ownerOf(
    id: string,
  ):
    Pick<Workspace, "addOrUpdatePanel" | "getPanelState" | "hasPanel" | "removePanel"> | undefined {
    return railFor(id) ?? (workspace?.hasPanel(id) ? workspace : (railHomeFor(id) ?? workspace));
  }

  const RAIL_FLOAT_BOUNDS = { left: 40, top: 40, width: 320, height: 240 };

  /**
   * Version 1 snapshots predate the separate rail roots, so move their default
   * rail panels out of the Dockview grid during migration. Version 2 ownership
   * is authoritative: a rail-capable panel may remain docked in the center.
   */
  function migrateVersionOneRailPanels(ws: Workspace & WorkspaceInspector): void {
    for (const id of [...leftRailOrder, ...rightRailOrder]) {
      if (!ws.hasPanel(id) || ws.inspectPanel(id)?.floating) continue;
      void ws.removePanel(id);
      railHomeFor(id)?.addOrUpdatePanel(railPanelSpec(id as RailPanelId));
    }
  }

  /** The frozen rail membership, used for a fresh layout and for version 1 payloads. */
  function fillRailsWithDefaults(): void {
    for (const [order, rail] of [
      [leftRailOrder, leftRail],
      [rightRailOrder, rightRail],
    ] as const) {
      if (!rail) continue;
      for (const id of order) {
        if (!rail.hasPanel(id)) rail.addOrUpdatePanel(railPanelSpec(id));
      }
    }
  }

  /** Fresh classic-hybrid layout: terminal center plus the two frozen rails. */
  function applyDefaultLayout(ws: Workspace & WorkspaceInspector): void {
    ws.addOrUpdatePanel(terminal);
    fillRailsWithDefaults();
    ws.activatePanel(terminal.id);
  }

  function applyLegacyLayout(
    ws: Workspace & WorkspaceInspector,
    legacy: LegacyWorkspaceLayout,
  ): boolean {
    const stablePanels = [...informationPanels, ...worldPanels, chatPanel];
    const terminalLayout = legacy.panels.find(({ id }) => id === terminal.id);
    const deferredFloats: Array<{
      panel: LegacyWorkspaceLayout["panels"][number];
      spec: WorkspacePanelSpec;
    }> = [];
    const floatingPlacement = (bounds: LegacyWorkspaceLayout["panels"][number]["bounds"]) => {
      const hostBounds = host.getBoundingClientRect();
      return {
        kind: "floating" as const,
        bounds: {
          ...bounds,
          left: bounds.left - hostBounds.left - host.clientLeft,
          top: bounds.top - hostBounds.top - host.clientTop,
        },
      };
    };

    ws.addOrUpdatePanel(terminal);
    if (terminalLayout?.dock === "float") {
      deferredFloats.push({ panel: terminalLayout, spec: terminal });
    }

    let converted = 1;
    for (const panel of legacy.panels
      .filter(({ id }) => id !== terminal.id)
      .sort((left, right) => left.order - right.order)) {
      const spec = stablePanels.find(({ id }) => id === panel.id);
      if (!spec) continue;
      const next = { ...spec, state: { ...spec.state, ...panel.state } };
      const rail =
        panel.dock === "left" ? leftRail : panel.dock === "right" ? rightRail : undefined;
      if (rail && railEligible(panel.id)) {
        rail.addOrUpdatePanel(next);
        rail.setCollapsed(panel.id, panel.collapsed);
      } else if (panel.dock === "float") {
        deferredFloats.push({ panel, spec: next });
      } else {
        ws.addOrUpdatePanel({
          ...next,
          placement: { kind: "grid", direction: panel.dock, referencePanelId: terminal.id },
        });
        ws.setPanelCollapsed(panel.id, panel.collapsed);
      }
      converted += 1;
    }
    ws.activatePanel(terminal.id);
    leftRailVisible = legacy.railVisibility.left;
    rightRailVisible = legacy.railVisibility.right;
    leftRail?.setInert(!leftRailVisible);
    rightRail?.setInert(!rightRailVisible);
    requestAnimationFrame(() => {
      const boundsById: Record<
        string,
        { left: number; top: number; width: number; height: number }
      > = {};
      for (const { panel, spec } of deferredFloats) {
        const placement = floatingPlacement(panel.bounds);
        ws.addOrUpdatePanel({ ...spec, placement });
        boundsById[panel.id] = placement.bounds;
      }
      ws.setFloatingPanelBounds(boundsById);
      for (const { panel } of deferredFloats) {
        ws.setPanelCollapsed(panel.id, panel.collapsed);
      }
      syncVisiblePanels();
      requestAnimationFrame(() => requestSave?.());
    });
    return converted > 1 || terminalLayout !== undefined;
  }

  let removeTerminalViewForTestImpl = (): Promise<void> => Promise.resolve();
  let restoreTerminalViewForTestImpl = (): Promise<void> => Promise.resolve();
  export const removeTerminalViewForTest = (): Promise<void> => removeTerminalViewForTestImpl();
  export const restoreTerminalViewForTest = (): Promise<void> => restoreTerminalViewForTestImpl();

  let host: HTMLElement;
  let shell: HTMLElement;
  let workspaceControlsEl: HTMLElement | undefined = $state();
  let workspaceStatusEl: HTMLElement | undefined = $state();
  let leftRailHost: HTMLElement;
  let rightRailHost: HTMLElement;
  let leftRail: Scrollview | undefined;
  let rightRail: Scrollview | undefined;
  let leftRailVisible = $state(true);
  let rightRailVisible = $state(true);
  let workspace: (Workspace & WorkspaceInspector) | undefined;
  /** Set once the save pipeline exists; rail edits are not Dockview layout events. */
  let requestSave: (() => void) | undefined;
  let movePanel:
    | ((
        id: RailPanelId,
        destination: RailSide | "float",
        index?: number,
        floatBounds?: typeof RAIL_FLOAT_BOUNDS,
      ) => void)
    | undefined;
  let cancelActiveDrag: (() => void) | undefined;
  let activeTransfers: ReadonlySet<string> | undefined;
  let terminalLineNavigator: ((lineId: number) => boolean) | undefined;
  let status = $state("Loading workspace...");
  let openInformationPanelIds = $state<string[]>([]);
  let openWorldPanelIds = $state<string[]>([]);
  let sheetOpen = $state(false);
  let sheetCloseButton: HTMLButtonElement | undefined;
  let sheetTrigger: HTMLButtonElement | undefined;
  let combatPanelOpen = $state(false);
  let chatPanelOpen = $state(false);
  let dpsPanelOpen = $state(false);
  let commandBoardOpen = $state(false);
  let openVitalBarIds = $state<string[]>([]);
  let gmcpDebugOpen = $state(false);
  let launcherOpen = $state(false);
  let mobilePresentation = $state(false);

  function toggleRail(side: RailSide): void {
    if (!railsEnabled) return;
    const rail = side === "left" ? leftRail : rightRail;
    if (!rail) return;
    const visible = side === "left" ? leftRailVisible : rightRailVisible;
    rail.setInert(visible);
    if (side === "left") leftRailVisible = !visible;
    else rightRailVisible = !visible;
    requestSave?.();
  }

  function togglePanels(): void {
    if (mobilePresentation) openSheet();
    else launcherOpen = !launcherOpen;
  }

  function handleLauncherFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !(event.currentTarget as HTMLElement).contains(next)) {
      launcherOpen = false;
    }
  }

  function syncVisiblePanels(): void {
    if (activeTransfers?.size) return;
    const visible = informationPanels.filter((panel) => ownerOf(panel.id)?.hasPanel(panel.id));
    openInformationPanelIds = visible.map((panel) => panel.id);
    session.information.setVisiblePanels(visible.map((panel) => panel.id));
    const visibleWorldPanels = [...worldPanels, areaMap].filter((panel) =>
      ownerOf(panel.id)?.hasPanel(panel.id),
    );
    openWorldPanelIds = visibleWorldPanels.map((panel) => panel.id);
    combatPanelOpen = workspace?.hasPanel(combatPanel.id) ?? false;
    // The Scene paints the room's image behind its figures, so while it is
    // open the room and its art are wanted just as they are for Room Image.
    const worldSubscriptions = visibleWorldPanels.map((panel) => panel.id);
    if (combatPanelOpen && !worldSubscriptions.includes("roomImage")) {
      worldSubscriptions.push("roomImage");
    }
    session.world.setVisiblePanels(worldSubscriptions);
    chatPanelOpen = workspace?.hasPanel(chatPanel.id) ?? false;
    dpsPanelOpen = workspace?.hasPanel(dpsPanel.id) ?? false;
    commandBoardOpen = workspace?.hasPanel(commandBoardPanel.id) ?? false;
    openVitalBarIds = vitalBarPanels
      .filter((panel) => workspace?.hasPanel(panel.id) ?? false)
      .map((panel) => panel.id);
  }

  function vitalBarOpen(panel: WorkspacePanelSpec): boolean {
    return openVitalBarIds.includes(panel.id);
  }

  // Vital bars float by default, stacked at the bottom-left where the eye
  // rests near the command line; a rails-off layout splits them under the
  // terminal instead so they stay reachable on a small screen.
  async function toggleVitalBarPanel(panel: WorkspacePanelSpec, activate = true): Promise<void> {
    if (!workspace) return;
    if (workspace.hasPanel(panel.id)) await workspace.removePanel(panel.id);
    else {
      const index = vitalBarPanels.findIndex((candidate) => candidate.id === panel.id);
      const width = Math.min(280, Math.max(160, host.clientWidth - 16));
      const height = 64;
      const terminalInfo = workspace.inspectPanel(terminal.id);
      workspace.addOrUpdatePanel({
        ...panel,
        placement:
          railsEnabled || !terminalInfo || terminalInfo.floating
            ? {
                kind: "floating",
                bounds: {
                  left: 12,
                  top: Math.max(0, host.clientHeight - (height + 12) * (index + 1) - 8),
                  width,
                  height,
                },
              }
            : { kind: "grid", direction: "below", referencePanelId: terminal.id },
      });
      if (activate) workspace.activatePanel(panel.id);
    }
    syncVisiblePanels();
  }

  function informationPanelOpen(panel: WorkspacePanelSpec): boolean {
    return openInformationPanelIds.includes(panel.id);
  }

  async function toggleInformationPanel(panel: WorkspacePanelSpec, activate = true): Promise<void> {
    if (activeTransfers?.has(panel.id)) return;
    const owner = ownerOf(panel.id);
    if (!owner) return;
    if (owner.hasPanel(panel.id)) {
      await owner.removePanel(panel.id);
    } else {
      owner.addOrUpdatePanel(panel);
      // A rail card is always in view; only the Dockview grid has hidden tabs.
      if (activate && !railFor(panel.id)) workspace?.activatePanel(panel.id);
    }
    if (railHomeFor(panel.id)) requestSave?.();
    syncVisiblePanels();
  }

  function worldPanelOpen(panel: WorkspacePanelSpec): boolean {
    return openWorldPanelIds.includes(panel.id);
  }

  async function toggleWorldPanel(panel: WorkspacePanelSpec, activate = true): Promise<void> {
    if (activeTransfers?.has(panel.id)) return;
    const owner = ownerOf(panel.id);
    if (!owner) return;
    const wasRail = railFor(panel.id);
    if (owner.hasPanel(panel.id)) {
      await owner.removePanel(panel.id);
    } else {
      owner.addOrUpdatePanel(panel);
      if (activate && !railFor(panel.id)) workspace?.activatePanel(panel.id);
    }
    if (wasRail || railHomeFor(panel.id)) requestSave?.();
    syncVisiblePanels();
  }

  async function toggleChatPanel(activate = true): Promise<void> {
    if (!workspace) return;
    if (workspace.hasPanel(chatPanel.id)) await workspace.removePanel(chatPanel.id);
    else {
      const width = Math.min(750, Math.max(320, host.clientWidth - 16));
      const height = Math.min(370, Math.max(180, host.clientHeight - 16));
      workspace.addOrUpdatePanel({
        ...chatPanel,
        placement: railsEnabled
          ? {
              kind: "floating",
              bounds: {
                left: Math.max(0, host.clientWidth - width - 8),
                top: Math.max(0, host.clientHeight - height - 8),
                width,
                height,
              },
            }
          : { kind: "grid", direction: "right", referencePanelId: terminal.id },
      });
      if (activate) workspace.activatePanel(chatPanel.id);
    }
    syncVisiblePanels();
  }

  async function toggleDpsPanel(activate = true): Promise<void> {
    if (!workspace) return;
    if (workspace.hasPanel(dpsPanel.id)) await workspace.removePanel(dpsPanel.id);
    else {
      const width = Math.min(340, Math.max(240, host.clientWidth - 16));
      const height = Math.min(520, Math.max(200, host.clientHeight - 16));
      workspace.addOrUpdatePanel({
        ...dpsPanel,
        placement: railsEnabled
          ? {
              kind: "floating",
              bounds: {
                left: Math.max(0, host.clientWidth - width - 8),
                top: Math.max(0, host.clientHeight - height - 8),
                width,
                height,
              },
            }
          : { kind: "grid", direction: "right", referencePanelId: terminal.id },
      });
      if (activate) workspace.activatePanel(dpsPanel.id);
    }
    syncVisiblePanels();
  }

  // The Command Board sits under the terminal, where the buttons are within
  // reach of the command line; a floated terminal gets a floating board.
  async function toggleCommandBoardPanel(activate = true): Promise<void> {
    if (!workspace) return;
    if (workspace.hasPanel(commandBoardPanel.id)) await workspace.removePanel(commandBoardPanel.id);
    else {
      const terminalInfo = workspace.inspectPanel(terminal.id);
      const width = Math.min(520, Math.max(260, host.clientWidth - 16));
      const height = Math.min(220, Math.max(120, host.clientHeight - 16));
      workspace.addOrUpdatePanel({
        ...commandBoardPanel,
        placement:
          terminalInfo && !terminalInfo.floating
            ? { kind: "grid", direction: "below", referencePanelId: terminal.id }
            : {
                kind: "floating",
                bounds: {
                  left: Math.max(0, Math.round((host.clientWidth - width) / 2)),
                  top: Math.max(0, host.clientHeight - height - 8),
                  width,
                  height,
                },
              },
      });
      if (activate) workspace.activatePanel(commandBoardPanel.id);
    }
    syncVisiblePanels();
  }

  // Where the Scene opens. Under Room Image when that panel is in the grid,
  // so it never lands on top of the terminal; otherwise to the right of the
  // terminal. A floating anchor is never used: Dockview cannot split a
  // floating group, so a panel placed against one becomes a tab inside that
  // window instead, which is how the panel used to end up hiding a floated
  // terminal.
  function scenePlacement(target: Workspace & WorkspaceInspector): PanelPlacement {
    const roomImage = target.inspectPanel("roomImage");
    if (roomImage && !roomImage.floating) {
      return { kind: "grid", direction: "below", referencePanelId: "roomImage" };
    }
    const terminalInfo = target.inspectPanel(terminal.id);
    if (terminalInfo && !terminalInfo.floating) {
      return { kind: "grid", direction: "right", referencePanelId: terminal.id };
    }
    return { kind: "grid", direction: "right" };
  }

  async function toggleScenePanel(activate = true): Promise<void> {
    if (!workspace) return;
    // Closing goes through the panel's close guard so a fight in progress is
    // handed back to text, the same as the tab's close button.
    if (workspace.hasPanel(combatPanel.id)) await workspace.requestClosePanel(combatPanel.id);
    else {
      workspace.addOrUpdatePanel({ ...combatPanel, placement: scenePlacement(workspace) });
      if (activate) workspace.activatePanel(combatPanel.id);
    }
    syncVisiblePanels();
  }

  async function toggleGmcpDebugPanel(activate = true): Promise<void> {
    if (!workspace || (!debugGmcp && !workspace.hasPanel(gmcpDebugPanel.id))) return;
    if (workspace.hasPanel(gmcpDebugPanel.id)) await workspace.removePanel(gmcpDebugPanel.id);
    else {
      // The layout subscription may publish synchronously, so mark this
      // transient before adding it to keep the saved workspace untouched.
      gmcpDebugOpen = true;
      workspace.addOrUpdatePanel({
        ...gmcpDebugPanel,
        placement:
          innerWidth < 940
            ? { kind: "grid", direction: "right", referencePanelId: terminal.id }
            : { kind: "floating", bounds: { left: 40, top: 40, width: 520, height: 320 } },
      });
      if (activate) workspace.activatePanel(gmcpDebugPanel.id);
    }
    gmcpDebugOpen = workspace.hasPanel(gmcpDebugPanel.id);
  }

  $effect(() => {
    const enabled = debugGmcp;
    if (!workspace || enabled === workspace.hasPanel(gmcpDebugPanel.id)) return;
    void toggleGmcpDebugPanel();
  });

  function panelMenuItemOpen(item: PanelMenuItem): boolean {
    if (item.kind === "information") return informationPanelOpen(item.panel);
    if (item.kind === "world") return worldPanelOpen(item.panel);
    if (item.kind === "gmcp-debug") return gmcpDebugOpen;
    if (item.kind === "dps") return dpsPanelOpen;
    if (item.kind === "scene") return combatPanelOpen;
    if (item.kind === "commandBoard") return commandBoardOpen;
    if (item.kind === "vitalBar") return vitalBarOpen(item.panel);
    return chatPanelOpen;
  }

  function togglePanelMenuItem(item: PanelMenuItem): void {
    if (item.kind === "information") void toggleInformationPanel(item.panel, false);
    else if (item.kind === "world") void toggleWorldPanel(item.panel, false);
    else if (item.kind === "gmcp-debug") void toggleGmcpDebugPanel(false);
    else if (item.kind === "dps") void toggleDpsPanel(false);
    else if (item.kind === "scene") void toggleScenePanel(false);
    else if (item.kind === "commandBoard") void toggleCommandBoardPanel(false);
    else if (item.kind === "vitalBar") void toggleVitalBarPanel(item.panel, false);
    else void toggleChatPanel(false);
  }

  function focusTerminal(): void {
    workspace?.activatePanel(terminal.id);
    focusTerminalIsland(terminal.id);
  }

  function registerTerminalLineNavigator(navigate: (lineId: number) => boolean): () => void {
    terminalLineNavigator = navigate;
    return () => {
      if (terminalLineNavigator === navigate) terminalLineNavigator = undefined;
    };
  }

  export function navigateTerminalLine(lineId: number): boolean {
    if (!workspace || !terminalLineNavigator) return false;
    workspace.activatePanel(terminal.id);
    if (!terminalLineNavigator(lineId)) return false;
    focusTerminalIsland(terminal.id);
    return true;
  }

  export function draftTerminalCommand(command: string): boolean {
    const input = host.querySelector<HTMLInputElement>('[data-tutorial-target="command-input"]');
    if (!input) return false;
    input.value = command;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    return true;
  }

  function openSheet(): void {
    sheetOpen = true;
    void tick().then(() => sheetCloseButton?.focus());
  }

  function closeSheet(returnFocus = true): void {
    if (!sheetOpen) return;
    sheetOpen = false;
    if (returnFocus) queueMicrotask(() => sheetTrigger?.focus());
  }

  /** Sheet panel selection reveals the workspace behind it rather than covering it. */
  function selectPanel(activate: () => void): void {
    closeSheet(false);
    activate();
  }

  function handleSheetBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) closeSheet();
  }

  function serverPanelPlacement(
    window: InteractionWindow,
  ): NonNullable<WorkspacePanelSpec["placement"]> {
    if (window.sourceId !== window.id) {
      try {
        const geometry = JSON.parse(
          localStorage.getItem(SHARED_VIDEO_GEOMETRY_KEY) ?? "null",
        ) as Record<string, unknown> | null;
        const x = Number(geometry?.x);
        const y = Number(geometry?.y);
        const width = Number(geometry?.w);
        const height = Number(geometry?.h);
        if ([x, y, width, height].every(Number.isFinite)) {
          return {
            kind: "floating",
            bounds: {
              left: Math.max(0, Math.min(x, Math.max(0, innerWidth - 80))),
              top: Math.max(0, Math.min(y, Math.max(0, innerHeight - 80))),
              width: Math.max(260, Math.min(width, Math.max(260, innerWidth - 24))),
              height: Math.max(180, Math.min(height, Math.max(180, innerHeight - 80))),
            },
          };
        }
      } catch {
        // Ignore missing or corrupt legacy geometry.
      }
    }
    if (window.dock === "float") {
      const width = window.defaultFloatW ?? 420;
      const height = window.defaultFloatH ?? 320;
      const rawLeft = window.defaultFloatX ?? 40;
      const rawTop = window.defaultFloatY ?? 40;
      return {
        kind: "floating",
        bounds: {
          left: rawLeft < 0 ? Math.max(0, innerWidth + rawLeft - width) : rawLeft,
          top: rawTop < 0 ? Math.max(0, innerHeight + rawTop - height) : rawTop,
          width,
          height,
        },
      };
    }
    return {
      kind: "grid",
      direction: window.dock === "left" ? "left" : window.dock === "bottom" ? "below" : "right",
      referencePanelId: terminal.id,
    };
  }

  $effect(() => {
    // Portal Panels button + status paragraph up to the App shell's toolbar
    // slot so they sit on the header row instead of in their own strip. The slot
    // is dedicated to these two nodes; replacing its children also removes stale
    // portal nodes left by a WorkspaceHost refresh.
    if (!workspaceToolbar || !workspaceControlsEl || !workspaceStatusEl) return;
    const toolbar = workspaceToolbar;
    const controls = workspaceControlsEl;
    const statusElement = workspaceStatusEl;
    toolbar.replaceChildren(controls, statusElement);
    return () => {
      if (controls.parentElement === toolbar) controls.remove();
      if (statusElement.parentElement === toolbar) statusElement.remove();
    };
  });

  onMount(() => {
    // Lifecycle-only correlation; never rendered directly.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const serverPanelIds = new Map<string, string>();
    let ideCloseGuard = (): boolean => true;
    const registerIdeCloseGuard = (guard: () => boolean): (() => void) => {
      ideCloseGuard = guard;
      return () => {
        if (ideCloseGuard === guard) ideCloseGuard = () => true;
      };
    };
    const canCloseServerPanel = (panelId: string): boolean => {
      const entry = [...serverPanelIds].find(([, currentPanelId]) => currentPanelId === panelId);
      const window = entry ? session.interactions.getSnapshot().windows[entry[0]] : undefined;
      return !!window && window.closable !== false && window.closable !== 0;
    };
    const rendererRegistry: WorkspaceRendererRegistry = {
      terminal: {
        component: TerminalPanel,
        componentProps: { registerLineNavigator: registerTerminalLineNavigator },
        floatable: true,
        preserveDomWhenHidden: true,
        session,
      },
      "server-window": {
        canClose: canCloseServerPanel,
        component: ServerWindowPanel,
        session,
        showCloseButton: canCloseServerPanel,
      },
      enemy: {
        canClose: () => {
          combatPanelOpen = false;
          // Mid-fight this hands the encounter back to text; between fights
          // there is no encounter and it is a no-op.
          session.combat.dismissEncounter();
          return true;
        },
        component: CombatPanel,
        session,
      },
      fishing: { canClose: () => true, component: FishingPanel, session },
      ide: {
        canClose: () => ideCloseGuard(),
        component: IdePanel,
        componentProps: {
          focusFallback: focusTerminal,
          registerCloseGuard: registerIdeCloseGuard,
        },
        preserveDomWhenHidden: true,
        session,
      },
      map: {
        canClose: () => true,
        collapsible: true,
        component: MapPanel,
        floatable: true,
        session,
      },
      areaMap: { canClose: () => true, component: MapPanel, session },
      room: {
        canClose: () => true,
        collapsible: true,
        component: RoomPanel,
        floatable: true,
        session,
      },
      roomImage: {
        canClose: () => true,
        collapsible: true,
        component: RoomImagePanel,
        floatable: true,
        session,
      },
      roomPlaylist: {
        canClose: () => true,
        collapsible: true,
        component: RoomPlaylistPanel,
        floatable: true,
        preserveDomWhenHidden: true,
        session,
      },
      chat: {
        canClose: () => true,
        collapsible: true,
        component: ChatPanel,
        floatable: true,
        preserveDomWhenHidden: true,
        session,
      },
      "gmcp-debug": {
        canClose: () => true,
        collapsible: true,
        component: GmcpDebugPanel,
        floatable: true,
        session,
      },
      commandBoard: {
        canClose: () => true,
        collapsible: true,
        component: CommandBoardPanel,
        floatable: true,
        session,
      },
      hpBar: { canClose: () => true, component: VitalBarPanel, floatable: true, session },
      spBar: { canClose: () => true, component: VitalBarPanel, floatable: true, session },
      guildBar: { canClose: () => true, component: GuildBarPanel, floatable: true, session },
      buffBar: { canClose: () => true, component: BuffBarPanel, floatable: true, session },
      dps: {
        canClose: () => true,
        collapsible: true,
        component: DpsPanel,
        floatable: true,
        session,
      },
      ...Object.fromEntries(
        informationPanels.map((panel) => [
          panel.kind,
          {
            canClose: () => true,
            collapsible: true,
            component: panel.id === "connection-health" ? ConnectionHealthPanel : InformationPanel,
            floatable: true,
            session,
          },
        ]),
      ),
    };
    const registry = { ...rendererRegistry };
    const diagnostics = new LifecycleDiagnostics();
    const currentWorkspace = createWorkspace(host, registry, diagnostics);
    workspace = currentWorkspace;
    const transferring = new SvelteSet<string>();
    activeTransfers = transferring;
    let transferBusy = false;
    let reconcileResponsive = () => {};
    let disposed = false;
    let draggedPanelId: RailPanelId | undefined;
    let cancelPendingSave = () => {};
    // Grid-host DnD: accept a rail card dropped anywhere in the Dockview host
    // and promote it to a floating pane. The rail's own drop handler covers
    // rail-to-rail moves; this covers rail-to-grid drags without relying on
    // `dragend`'s dropEffect (Dockview HTML5 targets set dropEffect="move"
    // even when they refuse the drop, so that signal is unreliable).
    const onRailDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(RAIL_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    };
    const onRailDrop = (event: DragEvent) => {
      const id = event.dataTransfer?.getData(RAIL_DRAG_TYPE);
      if (!id || !railEligible(id) || !railFor(id)) return;
      event.preventDefault();
      const hostBounds =
        host.querySelector<HTMLElement>(".dv-floating-overlay-host")?.getBoundingClientRect() ??
        host.getBoundingClientRect();
      movePanel?.(id, "float", undefined, {
        ...RAIL_FLOAT_BOUNDS,
        left: event.clientX - hostBounds.left,
        top: event.clientY - hostBounds.top,
      });
    };
    host.addEventListener("dragover", onRailDragOver);
    host.addEventListener("drop", onRailDrop);

    /**
     * Dockview uses PointerEvents for its drag (dndStrategy: "pointer"), so
     * HTML5 dragover/drop never fire on the rails during a floating-panel
     * drag. Watch pointer input at document level: while a Dockview overlay is
     * being dragged and the pointer is inside a rail, show that rail's drop
     * indicator; on pointerup, dock the floated panel back into the rail at
     * the pointer-derived index.
     */
    const railAt = (x: number, y: number): Scrollview | undefined => {
      if (!railsEnabled) return undefined;
      const el = document.elementFromPoint(x, y);
      const railEl = el?.closest("[data-rail]") as HTMLElement | null;
      if (railEl?.dataset.rail === "left") return leftRail;
      if (railEl?.dataset.rail === "right") return rightRail;
      return undefined;
    };
    const onDocPointerMove = (event: PointerEvent) => {
      if (!draggedPanelId) return;
      const rail = railAt(event.clientX, event.clientY);
      for (const other of [leftRail, rightRail]) {
        if (other && other !== rail) other.clearDropIndicator();
      }
      rail?.markDropIndicatorAt(event.clientY);
    };
    const onDocPointerUp = (event: PointerEvent) => {
      const id = draggedPanelId;
      draggedPanelId = undefined;
      cancelActiveDrag = undefined;
      leftRail?.clearDropIndicator();
      rightRail?.clearDropIndicator();
      if (!id) return;
      const rail = railAt(event.clientX, event.clientY);
      if (!rail) return;
      const index = rail.dropIndexAt(event.clientY);
      movePanel?.(id, rail === leftRail ? "left" : "right", index);
    };
    const cancelPanelDrag = () => {
      draggedPanelId = undefined;
      cancelActiveDrag = undefined;
      leftRail?.clearDropIndicator();
      rightRail?.clearDropIndicator();
    };
    const unsubscribePanelDrag = currentWorkspace.subscribePanelDrag((event) => {
      draggedPanelId = railEligible(event.panelId) ? event.panelId : undefined;
      cancelActiveDrag = event.cancel;
    });
    document.addEventListener("pointermove", onDocPointerMove);
    window.addEventListener("pointerup", onDocPointerUp);
    window.addEventListener("pointercancel", cancelPanelDrag);
    // One diagnostics instance across all three roots keeps the exactly-once
    // disposal accounting whole.
    const railCallbacksFor = (self: () => Scrollview | undefined) => ({
      onAcceptForeign: (id: string, index: number) => {
        const receiver = self();
        const source = railFor(id);
        if (!receiver || !source || source === receiver || !railEligible(id)) return;
        movePanel?.(id, receiver === leftRail ? "left" : "right", index);
      },
      onChange: () => {
        syncVisiblePanels();
        requestSave?.();
      },
      onFloat: (id: string) => {
        if (railEligible(id)) movePanel?.(id, "float");
      },
      requestClose: (id: string) => currentWorkspace.requestClosePanel(id),
    });
    leftRail = new Scrollview(
      leftRailHost,
      registry,
      diagnostics,
      railCallbacksFor(() => leftRail),
    );
    rightRail = new Scrollview(
      rightRailHost,
      registry,
      diagnostics,
      railCallbacksFor(() => rightRail),
    );

    movePanel = (id, destination, index, floatBounds = RAIL_FLOAT_BOUNDS) => {
      if (transferBusy) return;
      launcherOpen = false;
      const sourceRail = railFor(id);
      const source = sourceRail ?? (currentWorkspace.hasPanel(id) ? currentWorkspace : undefined);
      const receiver =
        destination === "left" ? leftRail : destination === "right" ? rightRail : currentWorkspace;
      if (!source || !receiver || source === receiver) return;
      const state = source.getPanelState(id) ?? railPanelSpec(id).state;
      const sourceIndex = sourceRail?.indexOf(id) ?? -1;
      const sourceCollapsed = sourceRail?.collapsedIds().includes(id) ?? false;
      const sourceSnapshot = sourceRail ? undefined : currentWorkspace.save();
      transferBusy = true;
      transferring.add(id);
      cancelPendingSave();
      void source
        .removePanel(id)
        .then(() => {
          if (disposed) return;
          if (destination === "float") {
            currentWorkspace.addOrUpdatePanel({
              ...railPanelSpec(id, state),
              placement: { kind: "floating", bounds: floatBounds },
            });
            currentWorkspace.activatePanel(id);
          } else {
            receiver.addOrUpdatePanel(railPanelSpec(id, state), index);
            (receiver as Scrollview).setCollapsed(id, false);
            (receiver as Scrollview).scrollCardIntoView(id);
            (receiver as Scrollview).focusPanel(id);
          }
        })
        .catch(async () => {
          if (disposed) return;
          if (receiver.hasPanel(id)) await receiver.removePanel(id);
          if (disposed) return;
          if (sourceRail) {
            sourceRail.addOrUpdatePanel(railPanelSpec(id, state), sourceIndex);
            sourceRail.setCollapsed(id, sourceCollapsed);
          } else if (sourceSnapshot) {
            currentWorkspace.restore(sourceSnapshot, [railPanelSpec(id, state)]);
          }
          status = `${railPanelSpec(id).title} could not be moved.`;
        })
        .finally(() => {
          transferring.delete(id);
          transferBusy = false;
          if (disposed) return;
          syncVisiblePanels();
          requestSave?.();
          reconcileResponsive();
        });
    };

    /** Dockview tree plus each rail's ordered ids. Rails are not Dockview panels. */
    const composeSnapshot = (): CompositeWorkspaceSnapshot => ({
      version: 2,
      layout: {
        collapsed: {
          left: leftRail?.collapsedIds() ?? [],
          right: rightRail?.collapsedIds() ?? [],
        },
        dockview: currentWorkspace.save().layout,
        ...(railFor("map")
          ? { mapZoom: normalizeMapZoom(railFor("map")?.getPanelState("map")?.mapZoom) }
          : {}),
        railVisibility: { left: leftRailVisible, right: rightRailVisible },
        scrollviews: { left: leftRail?.ids() ?? [], right: rightRail?.ids() ?? [] },
      },
    });

    /**
     * Apply a persisted snapshot. A version 1 payload predates the rails, so its
     * rail membership is whatever `fillRailsWithDefaults` rebuilds.
     */
    const restoreSnapshot = (next: PersistedWorkspaceSnapshot): boolean => {
      const panels = [
        terminal,
        ...informationPanels,
        ...worldPanels,
        chatPanel,
        dpsPanel,
        combatPanel,
        commandBoardPanel,
        ...vitalBarPanels,
      ];
      if (next.version === 1) {
        if (!currentWorkspace.restore(next, panels)) return false;
        migrateVersionOneRailPanels(currentWorkspace);
        fillRailsWithDefaults();
        return true;
      }
      if (
        !["left", "right"].every(
          (side) =>
            Array.isArray(next.layout.scrollviews[side]) &&
            Array.isArray(next.layout.collapsed[side]),
        )
      ) {
        return false;
      }
      if (!currentWorkspace.restore({ version: 1, layout: next.layout.dockview }, panels)) {
        return false;
      }
      if (next.layout.railVisibility) {
        leftRailVisible = next.layout.railVisibility.left;
        rightRailVisible = next.layout.railVisibility.right;
        leftRail?.setInert(!leftRailVisible);
        rightRail?.setInert(!rightRailVisible);
      }
      for (const [side, rail] of [
        ["left", leftRail],
        ["right", rightRail],
      ] as const) {
        const order = next.layout.scrollviews[side];
        const collapsed = next.layout.collapsed[side];
        if (!rail || !order || !collapsed) continue;
        for (const id of order) {
          if (
            !currentWorkspace.hasPanel(id) &&
            [...informationPanels, ...worldPanels].some((panel) => panel.id === id)
          ) {
            const state =
              id === "map" ? { mapZoom: normalizeMapZoom(next.layout.mapZoom) } : undefined;
            rail.addOrUpdatePanel(railPanelSpec(id as RailPanelId, state));
          }
        }
        // Anything absent from the saved order was closed or floated out.
        for (const id of rail.ids()) {
          if (!order.includes(id)) void rail.removePanel(id);
        }
        for (const id of order) rail.setCollapsed(id, collapsed.includes(id));
      }
      return true;
    };

    const loaded = loadCharacterWorkspace(localStorage, characterProfileId);
    const snapshot = loaded.success ? loaded.snapshot : null;
    const legacy = loaded.success && loaded.snapshot === null ? loaded.legacy : null;
    const loadMessage = !loaded.success
      ? loaded.message
      : loaded.snapshot === null
        ? loaded.message
        : "";
    const restored = snapshot !== null && restoreSnapshot(snapshot);
    const convertedLegacy =
      !restored && legacy !== null && applyLegacyLayout(currentWorkspace, legacy);
    if (!restored) {
      if (!convertedLegacy) applyDefaultLayout(currentWorkspace);
      status = convertedLegacy
        ? "Legacy workspace converted."
        : snapshot === null
          ? loadMessage
          : "Saved workspace could not be restored; using the default layout.";
    } else if (currentWorkspace.hasPanel(terminal.id)) {
      status = "Workspace restored";
    } else {
      // A restored layout without the terminal island is repaired in place; the
      // rest of the user's saved arrangement stays usable.
      currentWorkspace.addOrUpdatePanel(terminal);
      status = "Restored workspace was missing the terminal; it has been re-added.";
    }
    syncVisiblePanels();
    if (debugGmcp) {
      void toggleGmcpDebugPanel();
    }

    let pending: CompositeWorkspaceSnapshot | undefined;
    let timer: number | undefined;
    // Responsive presentation: below 940px the fixed 260px rails cannot coexist
    // with a >=420px terminal, so leaving the desktop zone captures the desktop
    // layout, suppresses writes, and presents a terminal-centric view. Returning
    // restores the captured layout. Reload in a narrow zone loads the last
    // persisted desktop layout. Rigorous stored-byte isolation lands in PR4.
    let responsiveZone: "desktop" | "compact" | "mobile" = "desktop";
    let capturedDesktop: CompositeWorkspaceSnapshot | undefined;
    let suppressPersistence = false;
    let fishingPanelOpen = false;
    let areaMapPanelOpen = false;
    let interactionSnapshot = session.interactions.getSnapshot();
    let ideSnapshot = session.ide.getSnapshot();
    let worldSnapshot = session.world.getSnapshot();
    let combatSnapshot = session.combat.getSnapshot();
    let seenCombatEncounter = "";
    let seenBrowseOpenVersion = 0;
    let seenPlaylistOpenVersion = 0;
    let dismissedFishingEnd: typeof interactionSnapshot.fishing.end = null;
    let idePanelOpen = false;
    let seenIdeOpenVersion = 0;
    const hasTransientPanels = () =>
      serverPanelIds.size > 0 ||
      fishingPanelOpen ||
      areaMapPanelOpen ||
      idePanelOpen ||
      gmcpDebugOpen;
    const flush = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      if (!pending) return;
      const result = saveCharacterWorkspace(localStorage, characterProfileId, pending);
      pending = undefined;
      status = result.success ? "Workspace saved" : result.message;
    };
    const scheduleSave = (next: CompositeWorkspaceSnapshot) => {
      pending = next;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(flush, 75);
    };
    cancelPendingSave = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    };
    requestSave = () => {
      if (suppressPersistence || hasTransientPanels() || transferring.size > 0) {
        cancelPendingSave();
        return;
      }
      scheduleSave(composeSnapshot());
    };
    removeTerminalViewForTestImpl = async () => {
      suppressPersistence = true;
      cancelPendingSave();
      await currentWorkspace.removePanel(terminal.id);
      await tick();
      cancelPendingSave();
    };
    restoreTerminalViewForTestImpl = async () => {
      currentWorkspace.addOrUpdatePanel(terminal);
      currentWorkspace.activatePanel(terminal.id);
      await tick();
      cancelPendingSave();
      suppressPersistence = false;
    };
    const resetWorkspace = async (): Promise<void> => {
      if (transferBusy) return;
      if (idePanelOpen && !(await currentWorkspace.requestClosePanel("ide"))) return;
      if (ideSnapshot.document) session.ide.close();
      idePanelOpen = false;
      cancelPendingSave();
      const transientPanelIds = [...serverPanelIds.values()];
      const hadFishingPanel = fishingPanelOpen;
      const hadAreaMapPanel = areaMapPanelOpen;
      const hadCombatPanel = currentWorkspace.hasPanel(combatPanel.id);
      if (hadCombatPanel) {
        combatPanelOpen = false;
        session.combat.dismissEncounter();
      }
      for (const windowId of serverPanelIds.keys()) session.interactions.closeWindow(windowId);
      if (interactionSnapshot.fishing.open) {
        session.interactions.cancelFishing(interactionSnapshot.fishing.open.session);
      }
      await Promise.all([
        ...transientPanelIds.map((panelId) => currentWorkspace.removePanel(panelId)),
        ...(hadFishingPanel ? [currentWorkspace.removePanel("fishing")] : []),
        ...(hadAreaMapPanel ? [currentWorkspace.removePanel(areaMap.id)] : []),
        ...(hadCombatPanel ? [currentWorkspace.removePanel(combatPanel.id)] : []),
      ]);
      serverPanelIds.clear();
      fishingPanelOpen = false;
      areaMapPanelOpen = false;
      await Promise.all(
        [leftRail, rightRail].flatMap((rail) =>
          (rail?.ids() ?? []).map((panelId) => rail!.removePanel(panelId)),
        ),
      );
      await currentWorkspace.removePanel(terminal.id);
      await Promise.all(informationPanels.map((panel) => currentWorkspace.removePanel(panel.id)));
      await Promise.all(worldPanels.map((panel) => currentWorkspace.removePanel(panel.id)));
      await currentWorkspace.removePanel(chatPanel.id);
      applyDefaultLayout(currentWorkspace);
      syncVisiblePanels();
      const resetSnapshot = composeSnapshot();
      if (!railsEnabled) {
        capturedDesktop = resetSnapshot;
        await presentTerminalCentric();
        syncVisiblePanels();
      }
      const result = saveCharacterWorkspace(localStorage, characterProfileId, resetSnapshot);
      status = result.success ? "Workspace reset" : result.message;
      focusTerminal();
    };
    const syncInteractionPanels = (next: typeof interactionSnapshot) => {
      interactionSnapshot = next;
      const desiredWindows = Object.values(next.windows).filter(
        (window) => window.type === "panel",
      );
      const desiredIds = new Set(desiredWindows.map(({ id }) => id));

      for (const [windowId, panelId] of [...serverPanelIds]) {
        if (desiredIds.has(windowId)) continue;
        serverPanelIds.delete(windowId);
        void currentWorkspace.removePanel(panelId);
      }
      for (const window of desiredWindows) {
        const panelId = serverPanelIds.get(window.id) ?? `server-window-${window.id}`;
        const exists = currentWorkspace.hasPanel(panelId);
        serverPanelIds.set(window.id, panelId);
        currentWorkspace.addOrUpdatePanel({
          id: panelId,
          kind: "server-window",
          title: window.title || window.sourceId,
          state: { windowId: window.id },
          ...(!exists ? { placement: serverPanelPlacement(window) } : {}),
        });
      }

      if (next.fishing.open || !next.fishing.end) dismissedFishingEnd = null;
      const shouldShowFishing = Boolean(
        next.fishing.open || (next.fishing.end && next.fishing.end !== dismissedFishingEnd),
      );
      if (shouldShowFishing) {
        const exists = currentWorkspace.hasPanel("fishing");
        fishingPanelOpen = true;
        currentWorkspace.addOrUpdatePanel({
          id: "fishing",
          kind: "fishing",
          title: "Fishing",
          state: {},
          ...(!exists
            ? {
                placement: {
                  kind: "floating" as const,
                  bounds: { left: 40, top: 40, width: 420, height: 500 },
                },
              }
            : {}),
        });
      } else if (fishingPanelOpen) {
        fishingPanelOpen = false;
        void currentWorkspace.removePanel("fishing");
      }

      if (hasTransientPanels()) cancelPendingSave();
    };
    const syncWorldPanels = (next: typeof worldSnapshot) => {
      worldSnapshot = next;
      let visibilityChanged = false;
      if (next.browseOpenVersion > seenBrowseOpenVersion) {
        seenBrowseOpenVersion = next.browseOpenVersion;
        const exists = currentWorkspace.hasPanel(areaMap.id);
        visibilityChanged = !exists;
        areaMapPanelOpen = true;
        if (!exists) currentWorkspace.addOrUpdatePanel(areaMap);
        currentWorkspace.activatePanel(areaMap.id);
      } else if (areaMapPanelOpen && !next.browseSource.isActive()) {
        areaMapPanelOpen = false;
        visibilityChanged = true;
        void currentWorkspace.removePanel(areaMap.id);
      }
      if (next.playlistOpenVersion > seenPlaylistOpenVersion) {
        const playlistPanel = worldPanels.find((panel) => panel.id === "roomPlaylist");
        if (playlistPanel && !transferring.has(playlistPanel.id)) {
          seenPlaylistOpenVersion = next.playlistOpenVersion;
          const owner = ownerOf(playlistPanel.id);
          const exists = owner?.hasPanel(playlistPanel.id) ?? false;
          visibilityChanged ||= !exists;
          if (!exists) owner?.addOrUpdatePanel(playlistPanel);
          const rail = railFor(playlistPanel.id);
          if (rail) {
            rail.setCollapsed(playlistPanel.id, false);
            rail.scrollCardIntoView(playlistPanel.id);
          } else {
            currentWorkspace.activatePanel(playlistPanel.id);
          }
        }
      }
      if (hasTransientPanels()) cancelPendingSave();
      if (visibilityChanged) syncVisiblePanels();
    };
    const syncIdePanel = (next: typeof ideSnapshot) => {
      ideSnapshot = next;
      if (next.document) {
        const exists = currentWorkspace.hasPanel("ide");
        idePanelOpen = true;
        currentWorkspace.addOrUpdatePanel({
          id: "ide",
          kind: "ide",
          title: next.document.title || next.document.path || "IDE",
          state: {},
          ...(!exists
            ? {
                placement: {
                  kind: "floating" as const,
                  bounds: {
                    left: Math.max(20, (innerWidth - Math.min(900, innerWidth - 40)) / 2),
                    top: Math.max(12, (innerHeight - Math.min(620, innerHeight - 80)) / 2),
                    width: Math.min(900, innerWidth - 40),
                    height: Math.min(620, innerHeight - 80),
                  },
                },
              }
            : {}),
        });
        if (next.openVersion > seenIdeOpenVersion) {
          seenIdeOpenVersion = next.openVersion;
          currentWorkspace.activatePanel("ide");
        }
      } else if (idePanelOpen) {
        idePanelOpen = false;
        void currentWorkspace.removePanel("ide");
      }
      if (hasTransientPanels()) cancelPendingSave();
    };
    const combatPlacement = (): PanelPlacement => scenePlacement(currentWorkspace);
    // A Scene panel that shares a group with the terminal would only cover it
    // when activated, so a new fight moves it out instead.
    const combatPanelCoversTerminal = (): boolean => {
      const enemy = currentWorkspace.inspectPanel(combatPanel.id);
      const terminalInfo = currentWorkspace.inspectPanel(terminal.id);
      return (
        !!enemy &&
        !!terminalInfo &&
        enemy.groupId !== null &&
        enemy.groupId === terminalInfo.groupId
      );
    };
    const syncCombatPanel = (next: typeof combatSnapshot) => {
      combatSnapshot = next;
      if (presentationAllowed && next.shouldPresent) {
        const exists = currentWorkspace.hasPanel(combatPanel.id);
        const encounter = `${next.model.epoch}\u0000${next.model.encounterId}`;
        const reveal = encounter !== seenCombatEncounter;
        seenCombatEncounter = encounter;
        if (reveal) {
          const focused = document.activeElement;
          if (exists && !combatPanelCoversTerminal())
            currentWorkspace.activatePanel(combatPanel.id);
          else currentWorkspace.addOrUpdatePanel({ ...combatPanel, placement: combatPlacement() });
          const restoreFocus = () => {
            if (focused instanceof HTMLElement && focused.isConnected) {
              focused.focus({ preventScroll: true });
            }
          };
          restoreFocus();
          queueMicrotask(restoreFocus);
          requestAnimationFrame(restoreFocus);
        }
        combatPanelOpen = true;
      }
      // When the fight ends the Scene stays: its stage returns to the room
      // with the player alone, and the next fight pops the opponent back in.
      if (!next.model.active || !next.model.visualEnabled) seenCombatEncounter = "";
      if (hasTransientPanels()) cancelPendingSave();
    };
    const unsubscribe = currentWorkspace.subscribeLayout((next) => {
      window.dispatchEvent(new Event("darkflow:workspace-layout-changed"));
      for (const [windowId, panelId] of serverPanelIds) {
        if (!currentWorkspace.hasPanel(panelId) && interactionSnapshot.windows[windowId]) {
          session.interactions.closeWindow(windowId);
        }
      }
      if (fishingPanelOpen && !currentWorkspace.hasPanel("fishing")) {
        fishingPanelOpen = false;
        if (!interactionSnapshot.fishing.open) {
          dismissedFishingEnd = interactionSnapshot.fishing.end;
        }
      }
      if (areaMapPanelOpen && !currentWorkspace.hasPanel(areaMap.id)) {
        areaMapPanelOpen = false;
      }
      if (idePanelOpen && !currentWorkspace.hasPanel("ide")) {
        idePanelOpen = false;
        session.ide.close();
      }
      if (gmcpDebugOpen && !currentWorkspace.hasPanel(gmcpDebugPanel.id)) {
        gmcpDebugOpen = false;
      }
      if (transferring.size > 0) {
        cancelPendingSave();
        return;
      }
      if (suppressPersistence || hasTransientPanels() || transferring.size > 0) cancelPendingSave();
      else scheduleSave(composeSnapshot());
      syncVisiblePanels();
    });
    const unsubscribeInteractions = session.interactions.subscribe(syncInteractionPanels);
    const unsubscribeIde = session.ide.subscribe(syncIdePanel);
    const unsubscribeWorld = session.world.subscribe(syncWorldPanels);
    const unsubscribeCombat = session.combat.subscribe(syncCombatPanel);
    const saveMapPanelState = (event: Event) => {
      const detail = (event as CustomEvent<{ mapZoom?: unknown; panelId?: unknown }>).detail;
      const panel = [...worldPanels, areaMap].find(({ id }) => id === detail?.panelId);
      if (!panel || transferring.has(panel.id)) return;
      const owner = ownerOf(panel.id);
      if (!owner?.hasPanel(panel.id)) return;
      owner.addOrUpdatePanel({
        id: panel.id,
        kind: panel.kind,
        title: panel.title,
        state: { ...owner.getPanelState(panel.id), mapZoom: normalizeMapZoom(detail.mapZoom) },
      });
      if (panel.id === "map") requestSave?.();
    };
    const zoneForWidth = (width: number): typeof responsiveZone =>
      width <= 700 ? "mobile" : width < 940 ? "compact" : "desktop";
    const presentTerminalCentric = async (): Promise<void> => {
      // Empty the rails so the terminal reclaims the width, then make the roots
      // inert so they cannot intercept touch input. Emptying matters as much as
      // hiding: a card left mounted in a hidden rail would double-mount its
      // panel when the sheet opens the same id into the grid.
      railsEnabled = false;
      for (const rail of [leftRail, rightRail]) {
        await Promise.all((rail?.ids() ?? []).map((id) => rail!.removePanel(id)));
        if (disposed) return;
        rail?.setInert(true);
      }
    };
    const applyResponsiveZone = async (): Promise<void> => {
      if (disposed || transferBusy) return;
      const next = zoneForWidth(window.innerWidth);
      mobilePresentation = next === "mobile";
      if (next === responsiveZone) return;
      const leavingDesktop = responsiveZone === "desktop" && next !== "desktop";
      const enteringDesktop = responsiveZone !== "desktop" && next === "desktop";
      responsiveZone = next;
      if (leavingDesktop) {
        capturedDesktop = composeSnapshot();
        suppressPersistence = true;
        cancelPendingSave();
        await presentTerminalCentric();
        if (disposed) return;
        syncVisiblePanels();
      } else if (enteringDesktop) {
        railsEnabled = true;
        leftRail?.setInert(!leftRailVisible);
        rightRail?.setInert(!rightRailVisible);
        if (capturedDesktop) {
          const restoredRailIds = Object.values(capturedDesktop.layout.scrollviews).flat();
          await Promise.all(
            restoredRailIds.map((id) =>
              currentWorkspace.hasPanel(id) ? currentWorkspace.removePanel(id) : Promise.resolve(),
            ),
          );
          if (disposed) return;
          restoreSnapshot(capturedDesktop);
          capturedDesktop = undefined;
        }
        suppressPersistence = false;
        syncVisiblePanels();
      }
      // compact <-> mobile keeps the same terminal-centric presentation.
    };
    let responsiveTransition = Promise.resolve();
    const onResize = () => {
      responsiveTransition = responsiveTransition.then(applyResponsiveZone);
    };
    reconcileResponsive = onResize;
    const flushOnLeave = () => flush();
    const pausePersistenceForImport = () => {
      flush();
      suppressPersistence = true;
      cancelPendingSave();
    };
    const resumePersistenceAfterImport = () => {
      suppressPersistence = false;
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", flushOnLeave);
    window.addEventListener("pagehide", flushOnLeave);
    window.addEventListener("darkflow:settings-import-start", pausePersistenceForImport);
    window.addEventListener("darkflow:settings-import-abort", resumePersistenceAfterImport);
    window.addEventListener("darkflow:reset-workspace", resetWorkspace);
    shell.addEventListener("darkflow:map-panel-state", saveMapPanelState);
    onResize();

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", flushOnLeave);
      window.removeEventListener("pagehide", flushOnLeave);
      window.removeEventListener("darkflow:settings-import-start", pausePersistenceForImport);
      window.removeEventListener("darkflow:settings-import-abort", resumePersistenceAfterImport);
      window.removeEventListener("darkflow:reset-workspace", resetWorkspace);
      shell.removeEventListener("darkflow:map-panel-state", saveMapPanelState);
      unsubscribeWorld();
      unsubscribeCombat();
      unsubscribeIde();
      unsubscribeInteractions();
      unsubscribe();
      session.information.setVisiblePanels([]);
      session.world.setVisiblePanels([]);
      flush();
      host.removeEventListener("dragover", onRailDragOver);
      host.removeEventListener("drop", onRailDrop);
      document.removeEventListener("pointermove", onDocPointerMove);
      window.removeEventListener("pointerup", onDocPointerUp);
      window.removeEventListener("pointercancel", cancelPanelDrag);
      unsubscribePanelDrag();
      movePanel = undefined;
      activeTransfers = undefined;
      reconcileResponsive = () => {};
      cancelActiveDrag = undefined;
      removeTerminalViewForTestImpl = () => Promise.resolve();
      restoreTerminalViewForTestImpl = () => Promise.resolve();
      workspace = undefined;
      const rails = [leftRail, rightRail];
      leftRail = undefined;
      rightRail = undefined;
      for (const rail of rails) void rail?.dispose();
      void currentWorkspace.dispose();
    };
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key !== "Escape") return;
    cancelActiveDrag?.();
    cancelActiveDrag = undefined;
    if (sheetOpen) closeSheet();
    if (launcherOpen) launcherOpen = false;
  }}
/>

<section
  bind:this={shell}
  class="workspace-shell"
  aria-label="Workspace"
  data-testid="phase2-workspace"
>
  <div
    bind:this={workspaceControlsEl}
    class="workspace-controls"
    aria-label="Panels"
    data-tutorial-target="panels-menu"
  >
    {#if railsEnabled}
      <button
        type="button"
        class="toolbar-icon-btn"
        class:active={leftRailVisible}
        title="Left sidebar"
        aria-label="Toggle left sidebar"
        aria-controls="phase2-left-rail"
        aria-pressed={leftRailVisible}
        onclick={() => toggleRail("left")}
      >
        {#if leftRailVisible}<PanelLeftClose size={16} />{:else}<PanelLeftOpen size={16} />{/if}
      </button>
      <button
        type="button"
        class="toolbar-icon-btn"
        class:active={rightRailVisible}
        title="Right sidebar"
        aria-label="Toggle right sidebar"
        aria-controls="phase2-right-rail"
        aria-pressed={rightRailVisible}
        onclick={() => toggleRail("right")}
      >
        {#if rightRailVisible}<PanelRightClose size={16} />{:else}<PanelRightOpen size={16} />{/if}
      </button>
    {/if}
    <div class="df-panels-menu" onfocusout={handleLauncherFocusOut}>
      <button
        bind:this={sheetTrigger}
        type="button"
        class="df-panels-menu-trigger toolbar-icon-btn"
        class:active={launcherOpen}
        title="Panels"
        aria-label="Panels"
        aria-controls={mobilePresentation ? "phase2-mobile-panels" : undefined}
        aria-haspopup={mobilePresentation ? "dialog" : "true"}
        aria-expanded={mobilePresentation ? sheetOpen : launcherOpen}
        onclick={togglePanels}><LayoutPanelLeft size={16} /></button
      >
      {#if launcherOpen}
        <div class="df-panels-menu-list" aria-label="Panels">
          <div class="df-panels-menu-groups">
            {#each panelMenuGroups as group (group.title)}
              <fieldset class="df-panels-menu-group">
                <legend>{group.title}</legend>
                {#each group.items as item (item.panel.id)}
                  <label
                    onpointerdown={(event) => {
                      event.currentTarget.control?.focus();
                      event.preventDefault();
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={panelMenuItemOpen(item)}
                      onchange={() => togglePanelMenuItem(item)}
                    />
                    {item.panel.title}
                  </label>
                {/each}
              </fieldset>
            {/each}
          </div>
        </div>
      {/if}
    </div>
    {#if combatPanelOpen}
      <button type="button" onclick={() => workspace?.activatePanel(combatPanel.id)}>Scene</button>
    {/if}
  </div>
  <p bind:this={workspaceStatusEl} class="workspace-status" data-testid="workspace-status">
    {status}
  </p>
  <div class="workspace-rails">
    <div
      bind:this={leftRailHost}
      id="phase2-left-rail"
      class="workspace-rail"
      data-rail="left"
    ></div>
    <div
      bind:this={host}
      id="phase2-workspace-host"
      class="workspace-host df-workspace"
      data-testid="workspace-host"
    ></div>
    <div
      bind:this={rightRailHost}
      id="phase2-right-rail"
      class="workspace-rail"
      data-rail="right"
    ></div>
  </div>
</section>

<div
  class:open={sheetOpen}
  class="mobile-sheet-overlay"
  role="presentation"
  inert={!sheetOpen}
  onclick={handleSheetBackdrop}
>
  <div
    id="phase2-mobile-panels"
    class="mobile-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="mobile-sheet-title"
  >
    <div class="mobile-sheet-header">
      <h2 id="mobile-sheet-title">Panels</h2>
      <button bind:this={sheetCloseButton} type="button" onclick={() => closeSheet()}
        >Close panels</button
      >
    </div>
    <div class="mobile-panel-tabs" aria-label="Open panels">
      <button type="button" onclick={() => selectPanel(focusTerminal)}>Terminal</button>
      {#each informationPanels as panel (panel.id)}
        <button
          type="button"
          aria-pressed={informationPanelOpen(panel)}
          onclick={() => selectPanel(() => void toggleInformationPanel(panel))}
        >
          {informationPanelOpen(panel) ? `Close ${panel.title}` : `Open ${panel.title}`}
        </button>
      {/each}
      {#each worldPanels as panel (panel.id)}
        <button
          type="button"
          aria-pressed={worldPanelOpen(panel)}
          onclick={() => selectPanel(() => void toggleWorldPanel(panel))}
        >
          {worldPanelOpen(panel) ? `Close ${panel.title}` : `Open ${panel.title}`}
        </button>
      {/each}
      {#if debugGmcp}
        <button
          type="button"
          aria-pressed={gmcpDebugOpen}
          onclick={() => selectPanel(() => void toggleGmcpDebugPanel())}
          >{gmcpDebugOpen ? "Close GMCP Debug" : "Open GMCP Debug"}</button
        >
      {/if}
      <button
        type="button"
        aria-pressed={chatPanelOpen}
        onclick={() => selectPanel(() => void toggleChatPanel())}
      >
        {chatPanelOpen ? "Close Chat" : "Open Chat"}
      </button>
      <button
        type="button"
        aria-pressed={dpsPanelOpen}
        onclick={() => selectPanel(() => void toggleDpsPanel())}
      >
        {dpsPanelOpen ? "Close DPS Meter" : "Open DPS Meter"}
      </button>
      <button
        type="button"
        aria-pressed={commandBoardOpen}
        onclick={() => selectPanel(() => void toggleCommandBoardPanel())}
      >
        {commandBoardOpen ? "Close Command Board" : "Open Command Board"}
      </button>
      {#each vitalBarPanels as panel (panel.id)}
        <button
          type="button"
          aria-pressed={vitalBarOpen(panel)}
          onclick={() => selectPanel(() => void toggleVitalBarPanel(panel))}
        >
          {vitalBarOpen(panel) ? `Close ${panel.title}` : `Open ${panel.title}`}
        </button>
      {/each}
      <button
        type="button"
        aria-pressed={combatPanelOpen}
        onclick={() => selectPanel(() => void toggleScenePanel())}
      >
        {combatPanelOpen ? "Close Scene" : "Open Scene"}
      </button>
    </div>
  </div>
</div>

<style>
  .workspace-shell {
    /*
     * `.workspace-controls` and `.workspace-status` used to sit above the rails
     * in a 3-row grid; they are portalled up to the App header now, so a flex
     * column with `.workspace-rails { flex: 1 }` keeps the rails filling
     * remaining height regardless of how many portal-eligible siblings exist
     * (only the mobile-only launcher trigger remains).
     */
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    flex: 1;
    min-height: 0;
    margin-top: 0;
  }
  .workspace-shell .workspace-rails {
    flex: 1;
  }

  .workspace-controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    min-width: 0;
  }

  /* Compact launcher: a single "Panels" button that opens a checklist menu,
     instead of a wall of per-panel toggles. */
  .df-panels-menu {
    position: relative;
  }

  .df-panels-menu-list {
    position: absolute;
    /*
     * Higher than `.rfc2549-debug-panel` (z-index 9200 in legacy main.css) so
     * the launcher menu can be interacted with even when RFC 2549 debug is on
     * -- portalling Panels into the header put the dropdown over the same
     * bottom-right region the debug panel occupies.
     */
    z-index: 9500;
    top: calc(100% + 0.25rem);
    left: auto;
    right: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    align-items: stretch;
    width: max-content;
    max-height: min(60vh, 30rem);
    padding: 0.375rem;
    overflow-y: auto;
    border: 1px solid var(--border-color, #30363d);
    border-radius: 0.5rem;
    background: var(--df-panel, #161b22);
    box-shadow: 0 12px 30px rgb(0 0 0 / 45%);
  }

  .df-panels-menu-groups {
    width: min(30rem, calc(100vw - 1rem));
    columns: 2;
    column-gap: 0.75rem;
  }

  .df-panels-menu-group {
    break-inside: avoid;
    padding: 0;
    margin: 0 0 0.5rem;
    border: 0;
  }

  .df-panels-menu-group legend {
    width: 100%;
    padding: 0.25rem 0.5rem;
    color: var(--df-accent-strong, #7ee7df);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .df-panels-menu-list label {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.25rem 0.5rem;
    white-space: nowrap;
    border-radius: 4px;
    cursor: pointer;
  }

  .df-panels-menu-list label:hover {
    background: var(--df-btn-secondary, rgb(255 255 255 / 6%));
  }

  .workspace-status {
    color: var(--df-muted, #8b949e);
  }

  .workspace-rails {
    display: flex;
    gap: 0.75rem;
    min-height: 0;
  }

  .workspace-rail {
    flex: 0 0 260px;
    min-height: 0;
    border: 1px solid var(--border-color, #30363d);
    border-radius: 0.5rem;
    background: color-mix(
      in srgb,
      var(--df-panel, #161b22) var(--df-side-rail-opacity, 82%),
      transparent
    );
  }

  .workspace-host {
    flex: 1;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--border-color, #30363d);
    border-radius: 0.5rem;
  }

  :global(.df-rail-card[data-panel-id="map"] .df-rail-card-body),
  :global(.df-rail-card[data-panel-id="roomImage"] .df-rail-card-body) {
    height: 220px;
  }

  :global(.df-rail-card[data-panel-id="roomPlaylist"] .df-rail-card-body) {
    min-height: 420px;
  }

  :global(.df-rail-card[data-panel-id="roomPlaylist"] .room-playlist-player) {
    height: 202px;
    min-height: 202px;
    aspect-ratio: auto;
  }

  :global(.df-rail-card[data-panel-id="roomPlaylist"] .room-playlist-panel) {
    padding: 0.5rem;
    overflow: visible;
  }

  :global(.df-rail-card[data-panel-id="roomPlaylist"] .room-playlist-volume) {
    width: 100%;
    margin-left: 0;
  }

  .mobile-sheet-overlay {
    display: none;
  }

  @media (max-width: 700px) {
    .mobile-sheet-overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: end;
      background: rgb(0 0 0 / 55%);
      opacity: 0;
      pointer-events: none;
      transition: opacity 160ms ease;
      visibility: hidden;
    }

    .mobile-sheet-overlay.open {
      opacity: 1;
      pointer-events: auto;
      visibility: visible;
    }

    .mobile-sheet {
      display: grid;
      width: 100%;
      max-height: 78dvh;
      padding-bottom: env(safe-area-inset-bottom);
      overflow-y: auto;
      overscroll-behavior: contain;
      border-top: 1px solid var(--border-color, #30363d);
      background: var(--df-bg, #0d1117);
      box-shadow: 0 -12px 30px rgb(0 0 0 / 45%);
      transform: translateY(100%);
      transition: transform 160ms ease;
    }

    .mobile-sheet-overlay.open .mobile-sheet {
      transform: translateY(0);
    }

    .mobile-sheet-header,
    .mobile-panel-tabs {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      padding: 0.75rem 1rem;
    }

    .mobile-sheet-header {
      justify-content: space-between;
      border-bottom: 1px solid var(--border-color, #30363d);
    }

    .mobile-sheet-header h2 {
      margin: 0;
      font-size: 1rem;
    }

    .mobile-panel-tabs {
      overflow-x: auto;
      border-bottom: 1px solid var(--border-color, #30363d);
    }

    .mobile-panel-tabs button {
      flex: 0 0 auto;
    }
  }

  :is(button):focus-visible {
    outline: 2px solid var(--df-accent-blue, #58a6ff);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .mobile-sheet-overlay,
    .mobile-sheet {
      transition: none;
    }
  }
</style>
