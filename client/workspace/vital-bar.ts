import type { CharVitals } from "../gmcp/contracts/char";
import {
  heatVitalBarColor,
  vitalBarColor,
  // @ts-expect-error Shared DOM renderer is legacy-compatible JavaScript without declarations.
} from "../../public/js/core-information-panel-renderers.mjs";

/**
 * The single-bar vital panels (HP Bar, SP Bar): free-floating, resizable
 * copies of one row of the Vitals panel so players can park a big health or
 * spell-point readout wherever they like. This module is the pure part: which
 * fields of Char.Vitals a bar reads and what it shows.
 */
export type VitalBarKind = "hp" | "sp";

export interface VitalReading {
  readonly kind: VitalBarKind;
  readonly label: string;
  /** Whether the server has sent this vital at all. */
  readonly known: boolean;
  readonly current: number;
  readonly max: number;
  /** 0..100, rounded; 0 when unknown or the maximum is not positive. */
  readonly percent: number;
  /** "80 / 100", or "--" when unknown. */
  readonly text: string;
  /** Fill colour from the shared vitals scale. */
  readonly color: string;
}

export const VITAL_BAR_PANEL_IDS = { hp: "hpBar", sp: "spBar" } as const;

const LABELS: Readonly<Record<VitalBarKind, string>> = { hp: "HP", sp: "SP" };

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** The panel kind for a workspace panel id, or null when the id is not a vital bar. */
export function vitalBarKindForPanel(panelId: string): VitalBarKind | null {
  if (panelId === VITAL_BAR_PANEL_IDS.hp) return "hp";
  if (panelId === VITAL_BAR_PANEL_IDS.sp) return "sp";
  return null;
}

/**
 * What one bar shows for the latest Char.Vitals. HP reads hp/maxhp (mhp as
 * the legacy maximum); SP reads sp/maxsp, falling back to the mana and mp
 * spellings some servers use. Missing data reads as unknown rather than zero.
 */
export function vitalReading(
  vitals: CharVitals | null | undefined,
  kind: VitalBarKind,
): VitalReading {
  const source = (vitals && typeof vitals === "object" ? vitals : {}) as Record<string, unknown>;
  const current =
    kind === "hp" ? firstNumber(source, ["hp"]) : firstNumber(source, ["sp", "mana", "mp"]);
  const max =
    kind === "hp"
      ? firstNumber(source, ["maxhp", "mhp"])
      : firstNumber(source, ["maxsp", "maxmana", "mmana", "maxmp", "mmp"]);
  const known = current !== null && max !== null;
  const safeCurrent = known ? Math.max(0, current) : 0;
  const safeMax = known ? Math.max(0, max) : 0;
  const percent =
    known && safeMax > 0
      ? Math.max(0, Math.min(100, Math.round((safeCurrent / safeMax) * 100)))
      : 0;
  return {
    kind,
    label: LABELS[kind],
    known,
    current: safeCurrent,
    max: safeMax,
    percent,
    text: known ? `${safeCurrent} / ${safeMax}` : "--",
    color: String(vitalBarColor(percent)),
  };
}

// ---------------------------------------------------------------------------
// Guild Resource slots
//
// Darkwind.GuildVitals carries whatever the character's guild has (vitae,
// prowess, wrath, heat...) as items with a stable id, a display label, and a
// kind; the meter kinds are bars. The Guild Resource panels show one such
// meter each without the client knowing any guild by name: a slot shows the
// Nth meter of the current snapshot, or the meter a player pinned to it.

export interface GuildMeter {
  readonly id: string;
  readonly label: string;
  readonly guild: string;
  readonly current: number;
  readonly max: number;
  readonly percent: number;
  /** Danger-when-full meters (kind meter_reverse, or v1 kind "warning"). */
  readonly reverse: boolean;
  readonly tip: string;
}

export interface GuildBarReading extends VitalReading {
  /** The meter on show, or null when the snapshot has none for this slot. */
  readonly meter: GuildMeter | null;
  /** The pinned id, or "" for the positional default. */
  readonly pinnedId: string;
  /** True when a pin is set but its meter is not in the snapshot, so the slot fell back. */
  readonly pinMissing: boolean;
  /** The meters a player can pin this slot to. */
  readonly choices: readonly GuildMeter[];
}

export const GUILD_BAR_SLOTS = 3;
export const GUILD_BAR_PANEL_IDS: readonly string[] = Object.freeze(
  Array.from({ length: GUILD_BAR_SLOTS }, (_, index) => `guildBar${index + 1}`),
);

const METER_KINDS = new Set(["meter", "meter_reverse", "warning"]);

/** The 1-based slot for a Guild Resource panel id, or 0 when the id is not one. */
export function guildBarSlotForPanel(panelId: string): number {
  const index = GUILD_BAR_PANEL_IDS.indexOf(panelId);
  return index < 0 ? 0 : index + 1;
}

/** The meter-kind items of a guild vitals snapshot, v2 `items` or v1 `bars`, in order. */
export function guildMeters(guildVitals: unknown): GuildMeter[] {
  const source =
    guildVitals && typeof guildVitals === "object" ? (guildVitals as Record<string, unknown>) : {};
  const list = Array.isArray(source.items)
    ? source.items
    : Array.isArray(source.bars)
      ? source.bars
      : [];
  const meters: GuildMeter[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const kind = typeof item.kind === "string" && item.kind ? item.kind : "meter";
    if (!id || !label || !METER_KINDS.has(kind)) continue;
    const current = Number(item.cur);
    const max = Number(item.max);
    if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) continue;
    const safeCurrent = Math.max(0, current);
    const percent = Math.max(0, Math.min(100, Math.round((safeCurrent / max) * 100)));
    meters.push({
      id,
      label,
      guild: typeof item.guild === "string" ? item.guild : "",
      current: safeCurrent,
      max,
      percent,
      reverse: kind !== "meter",
      tip: typeof item.tip === "string" ? item.tip : "",
    });
  }
  return meters;
}

/** Fill colour for a guild meter: the shared scale, inverted for danger-when-full meters. */
export function guildMeterColor(meter: GuildMeter): string {
  if (meter.id === "street_samurai.heat") return String(heatVitalBarColor(meter.percent));
  if (!meter.reverse) return String(vitalBarColor(meter.percent));
  if (meter.percent > 60) return "#f85149";
  if (meter.percent > 30) return "#d29922";
  return "#3fb950";
}

/**
 * What one Guild Resource slot shows: the pinned meter when present, else the
 * meter at the slot's position (slot 1 is the first meter, and so on).
 */
export function guildBarReading(
  guildVitals: unknown,
  slot: number,
  pinnedId: string | null | undefined,
): GuildBarReading {
  const choices = guildMeters(guildVitals);
  const pin = typeof pinnedId === "string" ? pinnedId.trim() : "";
  const pinned = pin ? (choices.find((meter) => meter.id === pin) ?? null) : null;
  const positional = choices[Math.max(1, Math.trunc(slot)) - 1] ?? null;
  const meter = pinned ?? positional;
  const known = meter !== null;
  return {
    kind: "hp",
    label: meter ? meter.label : `Guild resource ${Math.max(1, Math.trunc(slot))}`,
    known,
    current: meter ? meter.current : 0,
    max: meter ? meter.max : 0,
    percent: meter ? meter.percent : 0,
    text: meter ? `${meter.current} / ${meter.max}` : "--",
    color: meter ? guildMeterColor(meter) : String(vitalBarColor(0)),
    meter,
    pinnedId: pin,
    pinMissing: pin !== "" && pinned === null,
    choices,
  };
}

/** Per-character slot pins, kept as a panel preference beside the layout. */
export interface GuildBarPins {
  readonly [slot: string]: string;
}

export function guildBarStorageKey(characterProfileId: string): string {
  return `darkflow-guild-bars:${characterProfileId}`;
}

export function loadGuildBarPins(
  storage: Pick<Storage, "getItem"> | null | undefined,
  key: string,
): GuildBarPins {
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const pins =
      parsed && typeof parsed === "object" ? (parsed as { pins?: unknown }).pins : undefined;
    if (!pins || typeof pins !== "object") return {};
    const out: Record<string, string> = {};
    for (const [slot, id] of Object.entries(pins as Record<string, unknown>)) {
      if (/^\d+$/.test(slot) && typeof id === "string" && id.trim()) out[slot] = id.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** Writes one slot's pin ("" clears it) and returns the new pin set. */
export function saveGuildBarPin(
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
  key: string,
  slot: number,
  meterId: string,
): GuildBarPins {
  const current: Record<string, string> = { ...loadGuildBarPins(storage, key) };
  const name = String(Math.max(1, Math.trunc(slot)));
  if (meterId.trim()) current[name] = meterId.trim();
  else delete current[name];
  if (storage) {
    try {
      storage.setItem(key, JSON.stringify({ version: 1, pins: current }));
    } catch (error) {
      console.warn("Guild Resource panel could not save its pin", error);
    }
  }
  return current;
}

export interface GuildMeterGroup {
  readonly guild: string;
  readonly meters: readonly GuildMeter[];
}

/** Meters bucketed by guild, in first-seen order, for a grouped dropdown. */
export function guildMeterGroups(meters: readonly GuildMeter[]): readonly GuildMeterGroup[] {
  const groups: { guild: string; meters: GuildMeter[] }[] = [];
  for (const meter of meters) {
    const group = groups.find((candidate) => candidate.guild === meter.guild);
    if (group) group.meters.push(meter);
    else groups.push({ guild: meter.guild, meters: [meter] });
  }
  return groups;
}
