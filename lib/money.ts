/**
 * The ONE place center-cut math and piastre conversion live
 * (CLAUDE.md rule 3, docs/01-data-model.md §3).
 *
 * Money is stored as **integer piastres** (EGP × 100). Never floats, never a
 * second copy of the split formula. Display formatting lives in lib/format.ts
 * (`formatMoney`) because it is locale-dependent; the arithmetic is here.
 */
import type { ShareType } from "@prisma/client";

/** Largest amount we accept from a form: 10,000,000 EGP. Guards Int overflow. */
export const MAX_PIASTRES = 1_000_000_000;

export function toPiastres(egp: number): number {
  return Math.round(egp * 100);
}

export function fromPiastres(piastres: number): number {
  return piastres / 100;
}

/**
 * Parses an EGP amount typed into a form into piastres.
 * Returns null for anything that isn't a finite, non-negative, in-range number.
 */
export function parseEgpToPiastres(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  const piastres = toPiastres(value);
  if (piastres > MAX_PIASTRES) return null;
  return piastres;
}

/** EGP with up to 2 decimals, for pre-filling a form input from stored piastres. */
export function piastresToInputValue(piastres: number): string {
  return (piastres / 100).toFixed(2);
}

export type ShareSplit = {
  /** Piastres the center keeps. */
  centerShare: number;
  /** Piastres the teacher is owed. */
  teacherShare: number;
};

/**
 * The center's cut of one collected amount. This is the formula that gets
 * frozen onto a Payment as `centerShareSnapshot` / `teacherShareSnapshot`
 * (docs/01-data-model.md §3) — never recomputed from current config afterwards.
 *
 *   FIXED       → shareValue is piastres taken by the center
 *   PERCENTAGE  → shareValue is a whole-number percent, rounded to the nearest
 *                 piastre with Math.round (the documented rounding rule)
 *
 * The center can never take more than was collected, and never less than zero.
 */
export function splitShare(
  amount: number,
  shareType: ShareType,
  shareValue: number,
): ShareSplit {
  const raw =
    shareType === "FIXED"
      ? shareValue
      : Math.round((amount * shareValue) / 100);
  const centerShare = Math.min(Math.max(raw, 0), amount);
  return { centerShare, teacherShare: amount - centerShare };
}
