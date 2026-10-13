/**
 * Small, dependency-free helpers for the demo seed (P1). Deterministic on
 * purpose: the same seed run produces the same people, so a re-run finds them
 * by their keys instead of inventing a second copy.
 */
import { normalizePhone } from "../../lib/phone.ts";

/** A tiny seeded PRNG (mulberry32) — same sequence for the same seed. */
export function makeRng(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** Integer in [0, n). */
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}

export type Rng = ReturnType<typeof makeRng>;

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** FNV-1a — a stable 32-bit hash of a string, to seed per-key generators. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Egyptian mobile numbers (010 / 011 / 012 / 015), handed out in the raw
 * formats people actually type — `0100 123 4567`, `+20 100 123 4567`,
 * `0100-1234567` — and always run through `lib/phone.ts` (CLAUDE.md rule 10),
 * so what is stored is the one canonical `01XXXXXXXXX`.
 *
 * **Keyed, not sequential:** a person's number is derived from a stable key
 * (`"downtown:student:07"`), so a re-run of the seed produces the same number
 * for the same person and finds them again by it instead of inventing a
 * duplicate. Every number is unique across the seed (a collision just salts
 * the key), so a `User.phone` unique constraint can never trip and a parent's
 * number can never equal a staff member's.
 */
export class PhoneBook {
  private readonly used = new Set<string>();
  private readonly byKey = new Map<string, { canonical: string; raw: string }>();
  private readonly prefixes = ["010", "011", "012", "015"] as const;

  forKey(key: string): { canonical: string; raw: string } {
    const known = this.byKey.get(key);
    if (known) return known;
    for (let salt = 0; ; salt += 1) {
      const rng = makeRng(hashString(`${key}#${salt}`));
      const prefix = rng.pick(this.prefixes);
      const tail = String(rng.int(100_000_000)).padStart(8, "0");
      const local = `${prefix}${tail}`;
      const canonical = normalizePhone(local);
      if (!canonical || this.used.has(canonical)) continue;
      this.used.add(canonical);
      const style = rng.int(3);
      const raw =
        style === 0
          ? local
          : style === 1
            ? `+20 ${prefix.slice(1)} ${tail.slice(0, 4)} ${tail.slice(4)}`
            : `${prefix}-${tail.slice(0, 4)}-${tail.slice(4)}`;
      const entry = { canonical: normalizePhone(raw) ?? canonical, raw };
      this.byKey.set(key, entry);
      return entry;
    }
  }
}

/** `YYYY-MM-DD` of a UTC-midnight day marker (the same shape as lib/scheduling's dateKey). */
export function isoDay(marker: Date): string {
  return `${marker.getUTCFullYear()}-${String(marker.getUTCMonth() + 1).padStart(2, "0")}-${String(marker.getUTCDate()).padStart(2, "0")}`;
}

/** A UTC-midnight day marker from calendar parts (month is 1-12). */
export function dayOf(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Minutes after midnight → "HH:MM". */
export function hhmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, minutes));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
