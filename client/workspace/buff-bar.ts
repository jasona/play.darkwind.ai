import type { CharDefence } from "../gmcp/contracts/char.ts";

/** Panel id of the single floating Buff Bar. */
export const BUFF_BAR_PANEL_ID = "buffBar";

export type BuffKind = "buff" | "debuff" | "unknown";

export interface BuffChoice {
  readonly name: string;
  readonly kind: BuffKind;
  readonly desc: string;
}

export interface BuffBarReading {
  /** True when a buff is on show (pinned and active, or the automatic pick). */
  readonly known: boolean;
  readonly label: string;
  readonly kind: BuffKind;
  /** True when the buff has a duration, so the bar drains. */
  readonly timed: boolean;
  /** Seconds left, floored at zero; 0 for untimed buffs. */
  readonly remainingSeconds: number;
  /** Fill 0..100: remaining over duration, or 100 for an untimed buff. */
  readonly percent: number;
  readonly text: string;
  readonly color: string;
  /** The pinned name, or "" for the automatic pick. */
  readonly pinnedName: string;
  /** True when a pin is set but that buff is not active right now. */
  readonly pinMissing: boolean;
  /** Active buffs the player can pin the bar to. */
  readonly choices: readonly BuffChoice[];
  readonly buff: CharDefence | null;
}

const COLORS = {
  buff: "#3fb950",
  warn: "#d29922",
  danger: "#f85149",
  debuff: "#f85149",
  unknown: "#8b949e",
} as const;

export function buffKind(item: Pick<CharDefence, "kind"> | null | undefined): BuffKind {
  if (item?.kind === "debuff") return "debuff";
  if (item?.kind === "unknown") return "unknown";
  return "buff";
}

/** "1:05", "12:40", or "1:02:03"; untimed buffs show nothing. */
export function formatRemaining(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * Seconds left on a defence entry at `now`, counting down from the
 * `remaining` the server sent when the entry was received at `receivedAt`.
 * Entries without a duration are untimed and return 0.
 */
export function buffRemaining(item: CharDefence, receivedAt: number, now: number): number {
  const duration = Number(item.duration) || 0;
  if (duration <= 0) return 0;
  const remaining = Number.isFinite(Number(item.remaining)) ? Number(item.remaining) : duration;
  const elapsed = Math.max(0, (now - receivedAt) / 1000);
  return Math.max(0, remaining - elapsed);
}

function choiceFor(item: CharDefence): BuffChoice {
  return {
    name: item.name,
    kind: buffKind(item),
    desc: typeof item.desc === "string" ? item.desc : "",
  };
}

/**
 * Picks the buff the bar shows: the pinned name when it is active, otherwise
 * the timed buff closest to running out (the one worth watching), otherwise
 * the first buff. `receivedAtFor` supplies the time each entry was received.
 */
export function buffBarReading(
  defences: readonly CharDefence[] | null | undefined,
  pinnedName: string | null | undefined,
  now: number,
  receivedAtFor: (item: CharDefence) => number,
): BuffBarReading {
  const active = (Array.isArray(defences) ? defences : []).filter(
    (item): item is CharDefence =>
      !!item && typeof item.name === "string" && item.name.trim() !== "",
  );
  const choices = active.map(choiceFor);
  const pin = typeof pinnedName === "string" ? pinnedName.trim() : "";
  const pinned = pin ? (active.find((item) => item.name === pin) ?? null) : null;
  const pinMissing = pin !== "" && pinned === null;
  let buff: CharDefence | null = pinned;
  if (!buff && !pin) {
    let soonest: { item: CharDefence; left: number } | null = null;
    for (const item of active) {
      if (!(Number(item.duration) > 0)) continue;
      const left = buffRemaining(item, receivedAtFor(item), now);
      if (!soonest || left < soonest.left) soonest = { item, left };
    }
    buff = soonest ? soonest.item : (active[0] ?? null);
  }
  if (!buff) {
    return {
      known: false,
      label: pin || "Buff",
      kind: "unknown",
      timed: false,
      remainingSeconds: 0,
      percent: 0,
      text: pin ? "not active" : "--",
      color: COLORS.unknown,
      pinnedName: pin,
      pinMissing,
      choices,
      buff: null,
    };
  }
  const kind = buffKind(buff);
  const duration = Number(buff.duration) || 0;
  const timed = duration > 0;
  const remainingSeconds = timed ? buffRemaining(buff, receivedAtFor(buff), now) : 0;
  const percent = timed
    ? Math.max(0, Math.min(100, Math.round((remainingSeconds / duration) * 100)))
    : 100;
  let color: string =
    kind === "debuff" ? COLORS.debuff : kind === "unknown" ? COLORS.unknown : COLORS.buff;
  if (kind === "buff" && timed) {
    if (percent <= 10) color = COLORS.danger;
    else if (percent <= 25) color = COLORS.warn;
  }
  return {
    known: true,
    label: buff.name,
    kind,
    timed,
    remainingSeconds,
    percent,
    text: timed ? formatRemaining(remainingSeconds) : "active",
    color,
    pinnedName: pin,
    pinMissing,
    choices,
    buff,
  };
}

export function buffBarStorageKey(characterProfileId: string): string {
  return `darkflow-buff-bar:${characterProfileId}`;
}

/** The pinned buff name, or "" for the automatic pick. */
export function loadBuffBarPin(
  storage: Pick<Storage, "getItem"> | null | undefined,
  key: string,
): string {
  if (!storage) return "";
  try {
    const raw = storage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const pin =
      parsed && typeof parsed === "object" ? (parsed as { pin?: unknown }).pin : undefined;
    return typeof pin === "string" ? pin.trim() : "";
  } catch {
    return "";
  }
}

/** Writes the pin ("" clears it) and returns what was stored. */
export function saveBuffBarPin(
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
  key: string,
  name: string,
): string {
  const pin = String(name ?? "").trim();
  if (storage) {
    try {
      storage.setItem(key, JSON.stringify({ version: 1, pin }));
    } catch (error) {
      console.warn("Buff Bar could not save its pin", error);
    }
  }
  return pin;
}
