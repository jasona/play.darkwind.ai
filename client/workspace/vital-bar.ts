import type { CharVitals } from "../gmcp/contracts/char";
// @ts-expect-error Shared DOM renderer is legacy-compatible JavaScript without declarations.
import { vitalBarColor } from "../../public/js/core-information-panel-renderers.mjs";

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
