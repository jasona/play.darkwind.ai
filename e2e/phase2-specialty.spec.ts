import { expect, test, type Locator, type Page } from "@playwright/test";
import { TransportFixtureOwner, type TransportEndpoint } from "./fixtures/transport-fixtures";

let fixtures: TransportFixtureOwner;

test.beforeAll(async () => {
  fixtures = await TransportFixtureOwner.start();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function connect(page: Page): Promise<TransportEndpoint> {
  const endpoint = fixtures.endpoints.ws;
  await page.goto("/phase2/");
  await page.getByLabel("Host").fill("127.0.0.1");
  await page.getByLabel("Port").fill(String(endpoint.port));
  await page.getByLabel("Connection protocol").selectOption("ws");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Connected");
  return endpoint;
}

function framesSince(endpoint: TransportEndpoint, start: number, packageName: string): string[] {
  return endpoint.gmcpMessages
    .slice(start)
    .filter((frame) => frame === packageName || frame.startsWith(`${packageName} `));
}

async function expectFrame(
  endpoint: TransportEndpoint,
  start: number,
  expected: string,
  timeout = 5_000,
): Promise<void> {
  await expect.poll(() => endpoint.gmcpMessages.slice(start), { timeout }).toContain(expected);
}

function panelDragHandle(page: Page, panelId: string): Locator {
  return page.locator(`[data-panel-drag-handle][data-panel-id="${panelId}"]`);
}

async function dockPanelAsTab(page: Page, panelId: string, targetPanelId: string): Promise<void> {
  // Use the visible label rect, not the drag handle rect. Vendor CSS gives
  // `.dv-tab .dv-default-tab { width: 100% }` inside a `.dv-tab` that has
  // `flex-shrink: 0` but no explicit width -- both resolve to 0. The label
  // stays visible via `overflow: visible`, so it is the only reliable
  // click target across browsers; Firefox and WebKit dispatch pointerdown to
  // whatever their hit-test returns, and a 0-width parent is not it.
  const source = await panelDragHandle(page, panelId)
    .locator(".dv-default-tab-content")
    .boundingBox();
  const target = await panelDragHandle(page, targetPanelId)
    .locator(".dv-default-tab-content")
    .boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
}

function combatState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    epoch: "combat-a",
    encounter_id: "encounter-a",
    seq: 1,
    visual_enabled: 1,
    effective: 1,
    active: 1,
    current_actor_id: "self",
    current_target_id: "drake",
    actors: [
      { id: "self", name: "Acer", role: "self" },
      { id: "drake", name: "an ash drake", role: "target" },
    ],
    outcome: "",
    summary: "Combat begins.",
    ...overrides,
  };
}

function combatEvent(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    seq,
    kind: "attack",
    perspective: "outgoing",
    actor_id: "self",
    target_id: "drake",
    result: "hit",
    damage: seq,
    summary: `Hit ${seq}.`,
    ...overrides,
  };
}

function tutorialState(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    epoch: "tutorial-a",
    seq,
    tutorial_version: 2,
    status: "active",
    awaiting_continue: 0,
    chapter: { id: "orientation", index: 1, total: 5, title: "Orientation" },
    step: {
      id: "look",
      index: 1,
      total: 21,
      title: "Look around",
      task: "Read the room description.",
      hint: "Type look.",
      help: "help look",
      example_command: "look",
      target: "command-input",
    },
    route: {
      place: "Square",
      text: "Head north.",
      directions: ["north"],
    },
    actions: ["directions", "hint", "skip"],
    reason: "progress",
    hint_visible: 0,
    ...overrides,
  };
}

function streetState(overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: 1,
    maintenance_version: 3,
    cortex_version: "3.1",
    firmware_version: "Ronin-sama",
    grade: "ghost",
    active: true,
    guild_level: 16,
    guild_level_max: 16,
    cortex_rank: 42,
    cortex_rank_max: 200,
    guild_xp: 1930,
    guild_xp_needed: 7000,
    cortex_effect: "105%",
    edge: 5,
    edge_max: 10,
    heat: 2,
    heat_max: 10,
    heat_percent: 20,
    heat_band: "Clean",
    thermal_lockout: false,
    biological: { current: 920, max: 1000, percent: 92 },
    strain: {
      used: 32,
      total: 36,
      free: 4,
      percent: 88,
      breakdown: {
        base: 20,
        level: 8,
        source_total: 8,
        total: 36,
        sources: { street_samurai: 8 },
      },
    },
    target_locks: [{ name: "Test target", remaining: 21 }],
    target_lock_summary: "Test target",
    alerts: [
      {
        severity: "warning",
        marker: "!",
        code: "strain_high",
        message: "Strain is high.",
      },
    ],
    monitor_flags: { OC: 1, OD: false },
    active_firmware: ["Overclock"],
    automation_remaining: 120,
    processes: [
      {
        id: "targeting_suite",
        name: "Photon Targeting",
        grade: "military",
        family: "optical",
        load: 2,
        durability: 170,
        integrity: 100,
        fragmentation: 12,
        effectiveness: 100,
        alerts: [],
        patches: [],
        vulnerabilities: [],
        faults: [],
        state: "TARGET LOCK",
        state_severity: "healthy",
      },
    ],
    updated_at: 1785180000,
    ...overrides,
  };
}

async function disposeSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as {
        __darkflowPhase1Runtime: { session: { dispose(): void } };
      }
    ).__darkflowPhase1Runtime.session.dispose();
  });
}

test("Combat and Tutorial preserve fallback, exact directions, focus, and readiness", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const endpoint = fixtures.endpoints.ws;
  const tutorialHandshakeStart = endpoint.gmcpMessages.length;
  await connect(page);
  const output = page.getByLabel("Terminal output");
  const commandInput = page.getByLabel("Command input", { exact: true });

  await expect
    .poll(() => framesSince(endpoint, tutorialHandshakeStart, "Darkwind.Tutorial.Resync"))
    .toContain('Darkwind.Tutorial.Resync {"epoch":"","seq":0,"reason":"tutorial-connected"}');

  endpoint.sendText("Acer strikes an ash drake for 12 damage.\n");
  await expect(output).toContainText("Acer strikes an ash drake for 12 damage.");
  await commandInput.focus();
  const combatStart = endpoint.gmcpMessages.length;
  endpoint.sendGmcp("Char.Vitals", { hp: 91, maxhp: 100 });
  endpoint.sendGmcp("Darkwind.Char.Avatar", {
    url: "/assets/brand/darkflow-icon-64.png",
    name: "Acer",
  });
  endpoint.sendGmcp("Char.Enemy", {
    enemy_name: "an ash drake",
    enemy_curhp: 40,
    enemy_maxhp: 50,
    enemy_image: "/assets/brand/darkflow-icon-64.png",
  });
  endpoint.sendGmcp("Darkwind.Combat.State", combatState());

  const combat = page.getByRole("region", { name: "Visual combat" });
  await expect(combat).toBeVisible();
  await expect(page.locator(".combat-panel")).toHaveCount(1);
  await expect(combat).toContainText("Acer");
  await expect(combat).toContainText("an ash drake");
  await expect(combat.getByRole("progressbar", { name: "Acer health" })).toHaveAttribute(
    "aria-valuenow",
    "91",
  );
  await expect(combat.getByRole("progressbar", { name: "an ash drake health" })).toHaveAttribute(
    "aria-valuenow",
    "40",
  );
  await expect(combat).toHaveClass(/combat-visual-reduced/);
  await expect(commandInput).toBeFocused();
  if ((page.viewportSize()?.width ?? 0) > 700) {
    await expect(output).toBeVisible();
    await expect(commandInput).toBeVisible();
    const combatFrame = page
      .locator('[data-floating-drag-handle][data-panel-id="enemy"]')
      .locator("..");
    await expect(combatFrame).toBeVisible();
    await expect.poll(() => combatFrame.boundingBox()).toMatchObject({ width: 580, height: 465 });
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __darkflowPhase1Runtime: {
                session: { combat: { getSnapshot(): { presentationReady: boolean } } };
              };
            }
          ).__darkflowPhase1Runtime.session.combat.getSnapshot().presentationReady,
      ),
    )
    .toBe(true);
  await expect
    .poll(() => framesSince(endpoint, combatStart, "Darkwind.Combat.Resync"))
    .toContain("Darkwind.Combat.Resync");
  const combatFrames = endpoint.gmcpMessages.slice(combatStart);
  const combatReadyIndex = combatFrames.findIndex(
    (frame) =>
      frame.startsWith("Darkwind.Client.Subscriptions ") && frame.includes('"combatPane":true'),
  );
  expect(combatReadyIndex).toBeGreaterThanOrEqual(0);
  expect(combatFrames.indexOf("Darkwind.Combat.Resync")).toBeGreaterThan(combatReadyIndex);

  const combatRecoveryStart = endpoint.gmcpMessages.length;
  endpoint.sendGmcp("Darkwind.Session.Recovered", { mode: "linkdead" });
  await expectFrame(endpoint, combatRecoveryStart, "Darkwind.Combat.Resync");
  const combatRecoveryFrames = endpoint.gmcpMessages.slice(combatRecoveryStart);
  const combatRecoveryReadyIndex = combatRecoveryFrames.findIndex(
    (frame) =>
      frame.startsWith("Darkwind.Client.Subscriptions ") &&
      frame.includes('"reason":"combat-session-recovered"') &&
      frame.includes('"combatPane":true'),
  );
  expect(combatRecoveryReadyIndex).toBeGreaterThanOrEqual(0);
  expect(combatRecoveryFrames.indexOf("Darkwind.Combat.Resync")).toBeGreaterThan(
    combatRecoveryReadyIndex,
  );

  endpoint.sendGmcp("Darkwind.Combat.Events", {
    epoch: "combat-a",
    encounter_id: "encounter-a",
    first_seq: 2,
    last_seq: 3,
    events: [combatEvent(3), combatEvent(2)],
    overflow: { omitted: 0, hits: 0, damage: 0 },
  });
  await expect(combat.locator(".combat-current-event")).toContainText("Hit 2.", {
    timeout: 1_000,
  });
  await expect(combat.locator(".combat-current-event")).toContainText("Hit 3.", {
    timeout: 2_000,
  });
  await page.waitForTimeout(500);
  const stableCombat = await combat.textContent();
  endpoint.sendGmcp("Darkwind.Combat.Event", {
    epoch: "old-combat",
    encounter_id: "encounter-a",
    ...combatEvent(4),
  });
  await page.waitForTimeout(100);
  expect(await combat.textContent()).toBe(stableCombat);

  let activeEncounter = "encounter-a";
  let nextCombatSeq = 4;
  if ((page.viewportSize()?.width ?? 0) > 700) {
    await dockPanelAsTab(page, "enemy", "terminal");
    const hiddenStart = endpoint.gmcpMessages.length;
    await page.locator('[data-panel-drag-handle][data-panel-id="terminal"]').first().click();
    await expect(combat).toHaveCount(0);
    await expect
      .poll(() =>
        framesSince(endpoint, hiddenStart, "Darkwind.Client.Subscriptions").some(
          (frame) =>
            frame.includes('"reason":"combat-render-unavailable"') &&
            frame.includes('"combatPane":false'),
        ),
      )
      .toBe(true);

    await page.getByRole("button", { name: "Scene", exact: true }).click();
    await expect(combat).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __darkflowPhase1Runtime: {
                  session: { combat: { getSnapshot(): { presentationReady: boolean } } };
                };
              }
            ).__darkflowPhase1Runtime.session.combat.getSnapshot().presentationReady,
        ),
      )
      .toBe(true);

    await page.locator('[data-panel-drag-handle][data-panel-id="terminal"]').first().click();
    await expect(combat).toHaveCount(0);
    activeEncounter = "encounter-b";
    endpoint.sendGmcp(
      "Darkwind.Combat.State",
      combatState({
        encounter_id: activeEncounter,
        seq: nextCombatSeq++,
        summary: "A hidden new fight.",
      }),
    );
    await expect(combat).toBeVisible();

    // With visual combat off the Scene stays open but stops presenting the
    // fight: the opponent leaves the stage and the room scene takes over.
    endpoint.sendGmcp(
      "Darkwind.Combat.State",
      combatState({ encounter_id: activeEncounter, seq: nextCombatSeq++, visual_enabled: 0 }),
    );
    await expect(combat).toHaveClass(/combat-scene-idle/);
    await expect(combat.locator(".combat-token-hud-target")).toHaveCount(0);
    endpoint.sendGmcp(
      "Darkwind.Combat.State",
      combatState({ encounter_id: activeEncounter, seq: nextCombatSeq++, visual_enabled: 1 }),
    );
    await expect(combat).toBeVisible();
    await expect(combat).not.toHaveClass(/combat-scene-idle/);
    await expect(combat.locator(".combat-token-hud-target")).toHaveCount(1);
  }

  const combatCloseStart = endpoint.gmcpMessages.length;
  if ((page.viewportSize()?.width ?? 0) <= 700) {
    await page.getByRole("button", { name: "Panels", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Panels" })
      .getByRole("button", { name: "Close Scene", exact: true })
      .click();
  } else {
    await page.getByRole("button", { name: "Close Scene", exact: true }).click();
  }
  await expect(combat).toHaveCount(0);
  await expect
    .poll(() =>
      framesSince(endpoint, combatCloseStart, "Darkwind.Client.Subscriptions").some(
        (frame) =>
          frame.includes('"reason":"combat-dismissed"') && frame.includes('"combatPane":false'),
      ),
    )
    .toBe(true);
  endpoint.sendGmcp(
    "Darkwind.Combat.State",
    combatState({ encounter_id: activeEncounter, seq: nextCombatSeq++ }),
  );
  await expect(combat).toHaveCount(0);
  await commandInput.focus();
  const nextEncounter = activeEncounter === "encounter-a" ? "encounter-b" : "encounter-c";
  endpoint.sendGmcp(
    "Darkwind.Combat.State",
    combatState({ encounter_id: nextEncounter, seq: nextCombatSeq++, summary: "A new fight." }),
  );
  await expect(combat).toBeVisible();
  await expect(commandInput).toBeFocused();
  endpoint.sendGmcp(
    "Darkwind.Combat.State",
    combatState({
      encounter_id: nextEncounter,
      seq: nextCombatSeq,
      active: 0,
      outcome: "victory",
      summary: "Victory.",
    }),
  );
  // The Scene persists past the end of the fight; only the opponent goes.
  await expect(combat).toHaveClass(/combat-scene-idle/);
  await expect(combat.locator(".combat-token-hud-target")).toHaveCount(0);
  await expect(combat.locator(".combat-outcome")).toContainText("Victory.");
  await expect(output).toContainText("Acer strikes an ash drake for 12 damage.");

  const tutorialStart = endpoint.gmcpMessages.length;
  endpoint.sendGmcp("Darkwind.Tutorial.State", tutorialState(4));
  const tutorial = page.getByRole("complementary", { name: "Darkwind basics" });
  await expect(tutorial).toBeVisible();
  await expect(tutorial).toContainText("Look around");
  await expect(page.locator(".tutorial-target-halo")).toBeVisible();

  const commandCount = endpoint.commands.length;
  await tutorial.getByRole("button", { name: "Put look in the command line" }).click();
  await expect(commandInput).toHaveValue("look");
  await expect(commandInput).toBeFocused();
  expect(endpoint.commands).toHaveLength(commandCount);

  await tutorial.getByRole("button", { name: "Show directions" }).click();
  await expectFrame(
    endpoint,
    tutorialStart,
    'Darkwind.Tutorial.Action {"action":"directions","epoch":"tutorial-a","seq":4,"step_id":"look"}',
  );
  endpoint.sendGmcp("Darkwind.Tutorial.State", tutorialState(5, { reason: "directions" }));
  await expect(tutorial.locator(".tutorial-route")).toContainText("Head north.");

  await tutorial.getByRole("button", { name: "Show hint" }).click();
  await expectFrame(
    endpoint,
    tutorialStart,
    'Darkwind.Tutorial.Action {"action":"hint","epoch":"tutorial-a","seq":5,"step_id":"look"}',
  );
  endpoint.sendGmcp(
    "Darkwind.Tutorial.State",
    tutorialState(10_001, { reason: "hint", hint_visible: 1 }),
  );
  await expect(tutorial.locator(".tutorial-hint")).toContainText("Hint: Type look.");

  await tutorial.getByRole("button", { name: "Skip tutorial", exact: true }).click();
  await expect(tutorial).toContainText("Skip the guided tutorial?");
  expect(framesSince(endpoint, tutorialStart, "Darkwind.Tutorial.Action")).not.toContain(
    'Darkwind.Tutorial.Action {"action":"skip","epoch":"tutorial-a","seq":10001,"step_id":"look"}',
  );
  await tutorial.getByRole("button", { name: "Skip tutorial", exact: true }).click();
  await expectFrame(
    endpoint,
    tutorialStart,
    'Darkwind.Tutorial.Action {"action":"skip","epoch":"tutorial-a","seq":10001,"step_id":"look"}',
  );
  endpoint.sendGmcp(
    "Darkwind.Tutorial.State",
    tutorialState(10_002, {
      status: "skipped",
      awaiting_continue: 0,
      actions: [],
      reason: "skipped",
    }),
  );
  await expect(tutorial).toHaveCount(0);

  endpoint.sendGmcp("Darkwind.Tutorial.Control", {
    visible: 0,
    reason: "screenreader",
  });
  await expect(tutorial).toHaveCount(0);
  expect(
    framesSince(endpoint, tutorialStart, "Darkwind.Client.Subscriptions").some((frame) =>
      frame.includes('"tutorialPane":false'),
    ),
  ).toBe(false);
  endpoint.sendGmcp("Darkwind.Tutorial.State", tutorialState(10_003));
  await expect(tutorial).toBeVisible();

  const tutorialRecoveryStart = endpoint.gmcpMessages.length;
  endpoint.sendGmcp("Darkwind.Session.Recovered", { mode: "linkdead" });
  await expectFrame(
    endpoint,
    tutorialRecoveryStart,
    'Darkwind.Tutorial.Resync {"epoch":"tutorial-a","seq":10003,"reason":"tutorial-session-recovered"}',
  );
  const tutorialRecoveryFrames = endpoint.gmcpMessages.slice(tutorialRecoveryStart);
  const tutorialRecoveryReadyIndex = tutorialRecoveryFrames.findIndex(
    (frame) =>
      frame.startsWith("Darkwind.Client.Subscriptions ") &&
      frame.includes('"reason":"tutorial-session-recovered"') &&
      frame.includes('"tutorialPane":true'),
  );
  expect(tutorialRecoveryReadyIndex).toBeGreaterThanOrEqual(0);
  expect(
    tutorialRecoveryFrames.indexOf(
      'Darkwind.Tutorial.Resync {"epoch":"tutorial-a","seq":10003,"reason":"tutorial-session-recovered"}',
    ),
  ).toBeGreaterThan(tutorialRecoveryReadyIndex);

  endpoint.sendGmcp(
    "Darkwind.Tutorial.State",
    tutorialState(10_004, {
      step: {
        id: "restart",
        index: 2,
        total: 21,
        title: "Restart",
        task: "Restart the tutorial.",
        hint: "",
        help: "",
        example_command: "",
        target: "panels-menu",
      },
      route: null,
      actions: ["restart"],
    }),
  );
  await tutorial.getByRole("button", { name: "Restart tutorial" }).click();
  await expectFrame(
    endpoint,
    tutorialStart,
    'Darkwind.Tutorial.Resync {"epoch":"tutorial-a","seq":10004,"reason":"action-timeout"}',
    7_000,
  );
  await expect(tutorial.getByRole("button", { name: "Restart tutorial" })).toBeEnabled();

  endpoint.sendGmcp(
    "Darkwind.Tutorial.State",
    tutorialState(10_005, { status: "finished", actions: ["restart"] }),
  );
  await expect(tutorial).toHaveCount(0);
  expect(
    framesSince(endpoint, tutorialStart, "Darkwind.Client.Subscriptions").some((frame) =>
      frame.includes('"tutorialPane":false'),
    ),
  ).toBe(false);
  for (const expected of [
    'Darkwind.Tutorial.Action {"action":"directions","epoch":"tutorial-a","seq":4,"step_id":"look"}',
    'Darkwind.Tutorial.Action {"action":"hint","epoch":"tutorial-a","seq":5,"step_id":"look"}',
    'Darkwind.Tutorial.Action {"action":"skip","epoch":"tutorial-a","seq":10001,"step_id":"look"}',
    'Darkwind.Tutorial.Resync {"epoch":"tutorial-a","seq":10003,"reason":"tutorial-session-recovered"}',
    'Darkwind.Tutorial.Action {"action":"restart","epoch":"tutorial-a","seq":10004,"step_id":"restart"}',
    'Darkwind.Tutorial.Resync {"epoch":"tutorial-a","seq":10004,"reason":"action-timeout"}',
  ]) {
    expect(
      endpoint.gmcpMessages.slice(tutorialStart).filter((frame) => frame === expected),
    ).toHaveLength(1);
  }

  await disposeSession(page);
  await expect(page.getByTestId("phase2-shell")).toHaveCount(0);
  await expect.poll(() => endpoint.activeSocketCount()).toBe(0);
  const remountStart = endpoint.gmcpMessages.length;
  await connect(page);
  const connectedResync =
    'Darkwind.Tutorial.Resync {"epoch":"","seq":0,"reason":"tutorial-connected"}';
  await expect
    .poll(
      () =>
        framesSince(endpoint, remountStart, "Darkwind.Tutorial.Resync").filter(
          (frame) => frame === connectedResync,
        ).length,
    )
    .toBe(1);
  endpoint.sendGmcp("Darkwind.Tutorial.State", tutorialState(1));
  await expect(page.getByRole("complementary", { name: "Darkwind basics" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("Visual Effects stay cosmetic across settings, motion, recovery, reconnect, and disposal", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const endpoint = await connect(page);
  const root = page.locator("#visual-effects-root");
  const output = page.getByLabel("Terminal output");
  await expect(root).toBeHidden();

  endpoint.sendGmcp("Core.Supports.Add", ["Darkwind.Visual 1"]);
  const settingsStart = endpoint.gmcpMessages.length;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  await settings.getByLabel("Enable visual effects").check();
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await settings
    .getByRole("dialog", { name: "Download changed settings?", exact: true })
    .getByRole("button", { name: "Skip", exact: true })
    .click();
  await expect(settings).toHaveCount(0);
  await expect(root).toBeVisible();
  await expect
    .poll(() => framesSince(endpoint, settingsStart, "Darkwind.Client.Subscriptions"))
    .toEqual(expect.arrayContaining([expect.stringContaining('"visualEffects":true')]));
  expect(await page.evaluate(() => localStorage.getItem("darkwind-client-settings"))).toContain(
    '"visualEffectsEnabled":true',
  );

  endpoint.sendText("Visual effects never replace this terminal line.\n");
  await expect(output).toContainText("Visual effects never replace this terminal line.");
  endpoint.sendGmcp("Darkwind.Visual.State", {
    epoch: "world-a",
    seq: 2,
    reason: "wayshard",
    planet: "markas",
    terrain: ["desert"],
    room_id: "wastes",
    area: "Wastes",
  });
  endpoint.sendGmcp("Char.Vitals", { hp: 40, maxhp: 100 });
  endpoint.sendGmcp("Darkwind.Visual.Events", {
    epoch: "effects-a",
    first_seq: 1,
    last_seq: 3,
    events: [
      { seq: 1, kind: "damage", perspective: "incoming", cue: "impact", intensity: 3 },
      { seq: 2, kind: "damage", perspective: "outgoing", cue: "impact", intensity: 2 },
      {
        seq: 3,
        kind: "spell-cast",
        perspective: "self",
        cue: "cast",
        school: "cold",
        intensity: 3,
      },
    ],
  });
  await expect(root).toHaveClass(/is-planet-markas/);
  await expect(root).toHaveClass(/is-terrain-desert/);
  await expect(root).toHaveClass(/is-low-health/);
  await expect(root).toHaveClass(/is-incoming-damage/);
  await expect(root).toHaveClass(/is-outgoing-damage/);
  await expect(root).toHaveClass(/is-spell-cast/);
  await expect(root).toHaveClass(/is-spell-cold/);
  await expect(root).toHaveClass(/is-reduced-motion/);
  const firstIncoming = await root.locator(".visual-effects-incoming-damage").elementHandle();
  expect(firstIncoming).not.toBeNull();
  endpoint.sendGmcp("Darkwind.Visual.Event", {
    epoch: "effects-a",
    seq: 4,
    kind: "damage",
    perspective: "incoming",
    cue: "impact",
    intensity: 1,
  });
  await page.waitForTimeout(75);
  expect(await firstIncoming!.evaluate((element) => element.isConnected)).toBe(true);

  endpoint.sendGmcp("Darkwind.Visual.State", {
    epoch: "world-a",
    seq: 1,
    reason: "move",
    planet: "tekal",
    terrain: ["city"],
  });
  await expect(root).toHaveClass(/is-planet-markas/);
  await expect(root).not.toHaveClass(/is-planet-tekal/);
  endpoint.sendGmcp("Darkwind.Visual.Preview", { kind: "terrain", value: "arctic" });
  await expect(root).toHaveClass(/is-preview-terrain/);
  await expect(root).toHaveClass(/is-terrain-arctic/);
  endpoint.sendGmcp("Darkwind.Visual.Preview", { kind: "clear" });
  await expect(root).not.toHaveClass(/is-preview-terrain/);

  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await expect
    .poll(() => root.evaluate((element) => getComputedStyle(element).display))
    .toBe("none");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const snapshot = (
          window as unknown as {
            __darkflowPhase1Runtime: {
              session: {
                visualEffects: {
                  getSnapshot(): { activeCues: readonly unknown[]; presentationVisible: boolean };
                };
              };
            };
          }
        ).__darkflowPhase1Runtime.session.visualEffects.getSnapshot();
        return { cueCount: snapshot.activeCues.length, visible: snapshot.presentationVisible };
      }),
    )
    .toEqual({ cueCount: 0, visible: false });
  await expect(page.getByTestId("phase2-shell")).not.toHaveClass(/dw-visual-impact-shake/);
  await expect(page.getByTestId("phase2-shell")).not.toHaveClass(/dw-visual-attack-lunge/);
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "none" });
  await expect(root).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __darkflowPhase1Runtime: {
                session: { visualEffects: { getSnapshot(): { presentationVisible: boolean } } };
              };
            }
          ).__darkflowPhase1Runtime.session.visualEffects.getSnapshot().presentationVisible,
      ),
    )
    .toBe(true);
  await expect(output).toContainText("Visual effects never replace this terminal line.");

  const recoveryStart = endpoint.gmcpMessages.length;
  endpoint.sendGmcp("Darkwind.Session.Recovered", { mode: "linkdead" });
  await expect(root).not.toHaveClass(/is-planet-markas/);
  await expect(root).not.toHaveClass(/is-low-health/);
  await expect
    .poll(() =>
      framesSince(endpoint, recoveryStart, "Darkwind.Client.Subscriptions").some(
        (frame) =>
          frame.includes('"reason":"session-recovered"') && frame.includes('"visualEffects":true'),
      ),
    )
    .toBe(true);

  endpoint.dropConnections();
  await expect(root).not.toHaveClass(/is-planet-markas/);
  const reconnectStart = endpoint.gmcpMessages.length;
  await expect(page.locator("#connect-btn")).toHaveText(/Retrying in \d+s/);
  await expect(page.getByTestId("connection-status")).toHaveText("Connected");
  await expect
    .poll(() =>
      framesSince(endpoint, reconnectStart, "Darkwind.Client.Subscriptions").some(
        (frame) => frame.includes('"reason":"reconnect"') && frame.includes('"visualEffects":true'),
      ),
    )
    .toBe(true);
  endpoint.sendGmcp("Core.Supports.Add", ["Darkwind.Visual 1"]);
  endpoint.sendGmcp("Darkwind.Visual.State", {
    epoch: "world-b",
    seq: 1,
    reason: "move",
    planet: "markas",
    terrain: ["desert"],
  });
  await expect(root).toHaveClass(/is-planet-markas/);
  endpoint.sendGmcp("Darkwind.Visual.Preview", { kind: "planet", value: "tekal" });
  await expect(root).toHaveClass(/is-preview-planet/);

  await disposeSession(page);
  await expect(page.getByTestId("phase2-shell")).toHaveCount(0);
  await expect.poll(() => endpoint.activeSocketCount()).toBe(0);
  await expect(page.locator("#visual-effects-root")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("Street Samurai replaces one literal dashboard without tab reset or late updates", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const endpoint = await connect(page);

  const closeSeamWindow = {
    id: "close-seam",
    type: "panel",
    title: "Close seam",
    closable: 0,
    dock: "right",
    layout: {
      type: "vertical",
      children: [{ type: "paragraph", id: "status", text: "Close policy" }],
    },
  };
  if ((page.viewportSize()?.width ?? 0) > 700) {
    endpoint.sendGmcp("Darkwind.Window.Open", closeSeamWindow);
    const closeSeamPanel = page.locator(
      '.server-window-panel[data-panel-id="server-window-close-seam"]',
    );
    const closeSeamButton = page.getByRole("button", { name: "Close Close seam", exact: true });
    await expect(closeSeamPanel).toBeVisible();
    await expect(closeSeamButton).toHaveCount(0);
    endpoint.sendGmcp("Darkwind.Window.Open", { ...closeSeamWindow, closable: 1 });
    await expect(closeSeamButton).toBeVisible();
    const closeSeamStart = endpoint.gmcpMessages.length;
    await closeSeamButton.click();
    await expect(closeSeamPanel).toHaveCount(0);
    await expect
      .poll(
        () =>
          framesSince(endpoint, closeSeamStart, "Darkwind.Window.Closed").filter(
            (frame) => frame === 'Darkwind.Window.Closed {"id":"close-seam"}',
          ).length,
      )
      .toBe(1);

    endpoint.sendGmcp("Darkwind.Window.Open", { ...closeSeamWindow, closable: 1 });
    await expect(closeSeamPanel).toBeVisible();
    const serverCloseStart = endpoint.gmcpMessages.length;
    endpoint.sendGmcp("Darkwind.Window.Close", { id: "close-seam" });
    await expect(closeSeamPanel).toHaveCount(0);
    expect(framesSince(endpoint, serverCloseStart, "Darkwind.Window.Closed")).toEqual([]);
  }

  endpoint.sendGmcp("Darkwind.Window.Open", {
    id: "street-samurai-dashboard",
    type: "modal",
    title: "Cortex",
    layout: {
      type: "street_samurai_dashboard",
      id: "street-samurai-dashboard-root",
      active_tab: "diagnostics",
      state: streetState(),
    },
  });

  const panel = page.locator(
    '.server-window-panel[data-panel-id="server-modal-street-samurai-dashboard"]',
  );
  const dashboard = panel.getByLabel("Street Samurai Cortex dashboard");
  const diagnostics = dashboard.getByRole("tab", { name: "Diagnostics" });
  const overview = dashboard.getByRole("tab", { name: "Overview" });
  await expect(dashboard).toBeVisible();
  await expect(diagnostics).toHaveAttribute("aria-selected", "true");
  await overview.click();
  await expect(overview).toHaveAttribute("aria-selected", "true");

  endpoint.sendGmcp(
    "Darkwind.StreetSamurai",
    streetState({
      firmware_version: "Ronin II",
      alerts: [
        {
          severity: "danger",
          marker: "!",
          code: "literal",
          message: "<b>Literal alert</b>",
        },
      ],
    }),
  );
  await expect(dashboard).toContainText("RONIN II");
  await expect(dashboard).toContainText("<b>Literal alert</b>");
  await expect(dashboard.locator("b")).toHaveCount(0);
  await expect(overview).toHaveAttribute("aria-selected", "true");
  await overview.press("ArrowRight");
  const implants = dashboard.getByRole("tab", { name: "Implants" });
  await expect(implants).toHaveAttribute("aria-selected", "true");
  await expect(implants).toBeFocused();

  const bounds = await dashboard.boundingBox();
  expect(bounds).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  const closeStart = endpoint.gmcpMessages.length;
  await page.getByRole("button", { name: "Close Cortex", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expectFrame(
    endpoint,
    closeStart,
    'Darkwind.Window.Closed {"id":"street-samurai-dashboard"}',
  );
  endpoint.sendGmcp("Darkwind.StreetSamurai", streetState({ firmware_version: "Late" }));
  await expect(dashboard).toHaveCount(0);

  endpoint.sendGmcp("Darkwind.Window.Open", {
    id: "street-samurai-dashboard",
    type: "modal",
    title: "Cortex",
    layout: {
      type: "street_samurai_dashboard",
      state: streetState({ firmware_version: "Reopened" }),
    },
  });
  await expect(dashboard).toContainText("REOPENED");
  endpoint.dropConnections();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("#connect-btn")).toHaveText(/Retrying in \d+s/);
  await expect(page.getByTestId("connection-status")).toHaveText("Connected");
  endpoint.sendGmcp("Darkwind.StreetSamurai", streetState({ firmware_version: "Late reconnect" }));
  await expect(dashboard).toHaveCount(0);
  await disposeSession(page);
  expect(pageErrors).toEqual([]);
});

test("Zork-only keeps specialty presentation disabled", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    class FixtureSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readonly extensions = "";
      readonly protocol = "";
      binaryType = "arraybuffer";
      bufferedAmount = 0;
      readyState = FixtureSocket.CONNECTING;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      sent: unknown[] = [];

      constructor(readonly url: string | URL) {
        sockets.push(this);
      }

      close(code = 1000, reason = ""): void {
        this.readyState = FixtureSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
      }

      send(data: unknown): void {
        this.sent.push(data);
      }

      open(): void {
        this.readyState = FixtureSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      receive(packageName: string, data: unknown): void {
        const bytes = new TextEncoder().encode(`${packageName} ${JSON.stringify(data)}`);
        this.onmessage?.(new MessageEvent("message", { data: bytes.buffer }));
      }
    }

    const sockets: FixtureSocket[] = [];
    const applicationSockets = () =>
      sockets.filter((socket) => !new URL(String(socket.url)).searchParams.has("token"));
    const latest = () => applicationSockets().at(-1);
    const decode = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
      if (ArrayBuffer.isView(value)) {
        return new TextDecoder().decode(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        );
      }
      return "";
    };
    const control = {
      count: () => applicationSockets().length,
      open: () => latest()?.open(),
      receive: (packageName: string, data: unknown) => latest()?.receive(packageName, data),
      sent: () => latest()?.sent.map(decode) ?? [],
    };
    (
      window as unknown as {
        __specialtySocket: typeof control;
      }
    ).__specialtySocket = control;
    window.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  });

  await page.goto("/phase2/?zork=1");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __specialtySocket: { count(): number };
          }
        ).__specialtySocket.count(),
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    (
      window as unknown as {
        __specialtySocket: { open(): void };
      }
    ).__specialtySocket.open();
  });
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await page.evaluate(
    ({ combat, tutorial, visual }) => {
      const socket = (
        window as unknown as {
          __specialtySocket: {
            receive(packageName: string, data: unknown): void;
          };
        }
      ).__specialtySocket;
      socket.receive("Darkwind.Combat.State", combat);
      socket.receive("Darkwind.Tutorial.State", tutorial);
      socket.receive("Darkwind.Visual.State", visual);
    },
    {
      combat: combatState(),
      tutorial: tutorialState(1),
      visual: {
        epoch: "zork-world",
        seq: 1,
        reason: "move",
        planet: "markas",
        terrain: ["desert"],
      },
    },
  );

  await expect(page.locator(".combat-panel")).toHaveCount(0);
  await expect(page.locator(".tutorial-live")).toHaveCount(0);
  await expect(page.locator("#visual-effects-root")).toHaveCount(0);
  const sent = await page.evaluate(() =>
    (
      window as unknown as {
        __specialtySocket: { sent(): string[] };
      }
    ).__specialtySocket.sent(),
  );
  expect(sent.some((frame) => frame.includes('"combatPane":true'))).toBe(false);
  expect(sent.some((frame) => frame.includes('"tutorialPane":true'))).toBe(false);
  await disposeSession(page);
  expect(pageErrors).toEqual([]);
});
