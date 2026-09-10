import { expect, test, type Page } from "@playwright/test";
import { TransportFixtureOwner } from "./fixtures/transport-fixtures";

let fixtures: TransportFixtureOwner;

test.beforeAll(async () => {
  fixtures = await TransportFixtureOwner.start();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function connect(page: Page): Promise<void> {
  await page.goto("/phase2/");
  await page.getByLabel("Host").fill("127.0.0.1");
  await page.getByLabel("Port").fill(String(fixtures.endpoints.ws.port));
  await page.getByLabel("Connection protocol").selectOption("ws");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Connected");
}

/**
 * Present a panel regardless of zone: default rail panels are already open on
 * desktop, collapsed on mobile, and launcher-only panels (Cyberware) start
 * hidden in both. Idempotent.
 */
async function ensurePanelOpen(page: Page, title: string, id: string): Promise<void> {
  const onMobile = (page.viewportSize()?.width ?? Infinity) <= 700;
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  if (onMobile) {
    const openButton = page.getByRole("button", { name: `Open ${title}`, exact: true });
    if (await openButton.count()) await openButton.click();
    else await page.keyboard.press("Escape");
  } else {
    const checkbox = page.getByRole("checkbox", { name: title, exact: true });
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    await page.keyboard.press("Escape");
  }
  await expect(page.locator(`.information-panel[data-panel-id="${id}"]`)).toHaveCount(1);
}

test("character information panels present, restore, and close from the active controls", async ({
  page,
}) => {
  await connect(page);
  const onMobile = (page.viewportSize()?.width ?? Infinity) <= 700;
  // Omens is a default left-rail panel on desktop; on mobile the sheet selects it.
  await ensurePanelOpen(page, "Omens", "omens");
  await expect(page.locator('.information-panel[data-panel-id="omens"]')).toContainText(
    "Waiting for omens",
  );
  await page.reload();
  await ensurePanelOpen(page, "Omens", "omens");
  await expect(page.locator('.information-panel[data-panel-id="omens"]')).toContainText(
    "Waiting for omens",
  );
  const terminal = page.getByLabel("Terminal output");
  const identity = await terminal.getAttribute("data-terminal-identity");

  await page.getByRole("button", { name: "Panels", exact: true }).click();
  if (onMobile) {
    await page
      .getByRole("dialog", { name: "Panels" })
      .getByRole("button", { name: "Close Omens", exact: true })
      .click();
  } else {
    await page.getByRole("checkbox", { name: "Omens", exact: true }).uncheck();
    await page.keyboard.press("Escape");
  }
  await expect(page.locator('.information-panel[data-panel-id="omens"]')).toHaveCount(0);
  await terminal.click();
  expect(await terminal.getAttribute("data-terminal-identity")).toBe(identity);
});

test("inventory and progress panels open from desktop and mobile controls", async ({ page }) => {
  await connect(page);
  for (const [title, id] of [
    ["Inventory", "inventory"],
    ["Quests", "quests"],
    ["Achievements", "achievements"],
    ["Cyberware", "cyberware"],
  ]) {
    await ensurePanelOpen(page, title, id);
  }
});

test("Guild Vitals accepts LDMud numeric boolean values", async ({ page }) => {
  await connect(page);
  await ensurePanelOpen(page, "Guild vitals", "guildVitals");
  fixtures.endpoints.ws.sendGmcp("Darkwind.GuildVitals", {
    items: [
      { id: "focus", label: "Focus", guild: "Monk", kind: "boolean", on: 1 },
      {
        id: "stances",
        label: "Stances",
        guild: "Monk",
        kind: "flags",
        flags: [{ label: "Crane", on: 0 }],
      },
    ],
  });

  const panel = page.locator('.information-panel[data-panel-id="guildVitals"]');
  await expect(panel).toContainText("Focus");
  await expect(panel).toContainText("Crane");
  await expect(panel).not.toContainText("No guild vitals");
});

test("wire data survives malformed frames and resets across reconnect and disposal", async ({
  page,
}) => {
  await connect(page);
  const endpoint = fixtures.endpoints.ws;
  for (const [title, id] of [
    ["Inventory", "inventory"],
    ["Quests", "quests"],
    ["Achievements", "achievements"],
    ["Cyberware", "cyberware"],
  ] as const) {
    await ensurePanelOpen(page, title, id);
  }

  endpoint.sendGmcp("Char.Items.List", {
    location: "inv",
    items: [
      { id: "sword", name: "a bronze sword (main weapon)", attrib: "l" },
      { id: "cloak", name: "a wool cloak (worn over the shoulders)", attrib: "w" },
    ],
  });
  endpoint.sendGmcp("Darkwind.Quests.List", [
    { id: "herbs", name: "Gather herbs", status: "Started", current: 1, total: 3 },
  ]);
  endpoint.sendGmcp("Darkwind.Achievements.List", {
    summary: {
      unlockedTierCount: 1,
      totalTierCount: 2,
      completedFamilyCount: 0,
      totalFamilyCount: 1,
    },
    families: [{ id: "explorer", name: "Explorer", currentValue: 2, nextTierThreshold: 5 }],
  });
  endpoint.sendGmcp("Darkwind.Cyberware.List", {
    installed: [{ id: "eyes", name: "Targeting Suite", locations: ["left_eye"], strain: 2 }],
    strain: { used: 2, total: 6 },
  });

  const inventory = page.locator('.information-panel[data-panel-id="inventory"]');
  await expect(inventory).toContainText("A bronze sword");
  await inventory.getByRole("button", { name: "Worn" }).click();
  await expect(inventory.locator('.inv-tab-content[data-tab="worn"]')).toHaveClass(/active/);
  await expect(page.locator('.information-panel[data-panel-id="quests"]')).toContainText(
    "Gather herbs",
  );
  await expect(page.locator('.information-panel[data-panel-id="achievements"]')).toContainText(
    "Explorer",
  );

  endpoint.sendGmcp("Char.Items.List", { location: "inv", items: "invalid" });
  endpoint.sendGmcp("Darkwind.Quests.List", { invalid: true });
  await expect(inventory).toContainText("A bronze sword");
  await expect(page.locator('.information-panel[data-panel-id="quests"]')).toContainText(
    "Gather herbs",
  );

  const cyberwareRow = page.getByRole("button", { name: /Targeting Suite/ });
  await cyberwareRow.focus();
  await cyberwareRow.press("Enter");
  await expect
    .poll(() => endpoint.gmcpMessages)
    .toContain('Darkwind.Cyberware.Details {"id":"eyes"}');

  const dialog = page.getByRole("dialog", { name: "Cyberware details" });
  await expect(dialog).toContainText("Querying implant");
  endpoint.sendGmcp("Darkwind.Cyberware.Details", {
    id: "other",
    description: "Wrong implant",
  });
  await expect(dialog).not.toContainText("Wrong implant");
  endpoint.sendGmcp("Darkwind.Cyberware.Details", {
    id: "eyes",
    name: "Targeting Suite",
    description: "Locked on",
    image_pending: 1,
  });
  endpoint.sendGmcp("Darkwind.Cyberware.Image", { id: "eyes", url: "/eyes.png" });
  await expect(dialog).toContainText("Locked on");
  await expect(dialog.getByRole("img", { name: "Targeting Suite" })).toHaveAttribute(
    "src",
    "/eyes.png",
  );

  await dialog.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(cyberwareRow).toBeFocused();

  endpoint.dropConnections();
  await expect(inventory).toContainText("Empty");
  await expect(page.locator('.information-panel[data-panel-id="quests"]')).toContainText(
    "No quest data",
  );
  await expect(page.locator("#connect-btn")).toHaveText(/Retrying in \d+s/);
  await expect(page.getByTestId("connection-status")).toHaveText("Connected");

  endpoint.sendGmcp("Char.Items.List", {
    location: "inv",
    items: [{ id: "needle", name: "a silver needle", attrib: "" }],
  });
  await expect(inventory).toContainText("A silver needle");
  await expect(inventory).not.toContainText("A bronze sword");

  await page.evaluate(() => {
    (
      window as unknown as { __darkflowPhase1Runtime: { session: { dispose(): void } } }
    ).__darkflowPhase1Runtime.session.dispose();
  });
  await expect(page.locator('[data-workspace-owned="true"]')).toHaveCount(0);
  endpoint.sendGmcp("Char.Items.List", {
    location: "inv",
    items: [{ id: "late", name: "late item", attrib: "" }],
  });
  await expect(page.locator('[data-workspace-owned="true"]')).toHaveCount(0);
  await expect.poll(() => endpoint.activeSocketCount()).toBe(0);
});
