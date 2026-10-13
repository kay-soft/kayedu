/**
 * Reads the permission a page asserts, straight from its source — the "page
 * gate is the authority" rule (P1, docs/02-architecture.md §6.2). Used by
 * `scripts/diagnose-nav.ts` and `check:permissions` to prove a nav item shows
 * on exactly the permission its page requires.
 *
 * Static on purpose (CLAUDE.md rule 1 — no browser): the page file's
 * `requirePermission(ctx, "<action>")` call IS the gate.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const GROUP_DIR = {
  center: "(center)",
  teacher: "(teacher)",
} as const;

export type NavExperience = keyof typeof GROUP_DIR;

/** `/classes` → `app/[locale]/(center)/classes/page.tsx` (and the teacher equivalent). */
export function pageFileFor(experience: NavExperience, href: string): string | null {
  const file = join(
    ROOT,
    "app",
    "[locale]",
    GROUP_DIR[experience],
    ...href.split("/").filter(Boolean),
    "page.tsx",
  );
  return existsSync(file) ? file : null;
}

export type PageGate = { found: false } | { found: true; permission: string | null; file: string };

/** The single `requirePermission(ctx, "x")` action a page asserts, or null when it asserts none. */
export function pageGateFor(experience: NavExperience, href: string): PageGate {
  const file = pageFileFor(experience, href);
  if (!file) return { found: false };
  const source = readFileSync(file, "utf8");
  const match = source.match(/requirePermission\(\s*ctx\s*,\s*"([^"]+)"\s*\)/);
  return { found: true, permission: match ? match[1] : null, file };
}
