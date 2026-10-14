/**
 * The ONE place center-cut math and piastre conversion live
 * (CLAUDE.md rule 3, docs/01-data-model.md §3).
 *
 * Money is stored as **integer piastres** (EGP × 100). Never floats, never a
 * second copy of the split formula. Display formatting lives in lib/format.ts
 * (`formatMoney`) because it is locale-dependent; the arithmetic is here.
 */
import type { ShareType } from "@prisma/client";

import { toAsciiDigits } from "./digits.ts";

/**
 * The largest single amount any form accepts: 10,000,000 EGP. Used for an
 * expense, which can legitimately be large (a year's rent). Below the Postgres
 * `integer` ceiling every money column uses.
 */
export const MAX_PIASTRES = 1_000_000_000;

/**
 * The largest **price** a session, class or centre cut may carry: 100,000 EGP
 * (SEC-2b, D-17 (b), SEC-24). A real per-session price at an Egyptian centre
 * is tens to a few thousand EGP, so this leaves ~30× headroom while keeping a
 * single payment ≤ 0.5 % of the `integer` ceiling — a typo or a malicious
 * "10M EGP session" can no longer overflow a sum in a handful of payments.
 * Every money aggregate is a 64-bit sum anyway (lib/db/money-sums.ts); this cap
 * is the second guard, not the only one.
 */
export const MAX_PRICE_PIASTRES = 10_000_000;

/**
 * The Postgres `integer` ceiling. A stored total (`Settlement.totalAmount`)
 * that would exceed it is refused, never truncated or thrown.
 */
export const MAX_STORED_PIASTRES = 2_147_483_647;

export function toPiastres(egp: number): number {
  return Math.round(egp * 100);
}

export function fromPiastres(piastres: number): number {
  return piastres / 100;
}

/** Plain decimal EGP: digits, optionally a point and at most two decimals. */
const EGP_PATTERN = /^\d{1,10}(?:\.\d{1,2})?$/;

/**
 * Parses an EGP amount typed into a form into piastres. Returns null for
 * anything that is not a plain decimal amount within `max` (default
 * `MAX_PIASTRES`). Strict on purpose (SEC-74): `Number()` used to accept
 * `1e3`, `0x10` and `0.001` (silently 0) — none of those is an amount a person
 * typed. Arabic-Indic digits are folded first (lib/digits.ts), so an Arabic
 * keyboard's "١٢٠" is 120 EGP.
 */
export function parseEgpToPiastres(input: string, max: number = MAX_PIASTRES): number | null {
  const trimmed = toAsciiDigits(input).trim();
  if (!EGP_PATTERN.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const piastres = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(piastres) || piastres > max) return null;
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
 * Since SEC-2b (D-15) a FIXED cut above the price is refused when it is
 * configured (`centerCutError`); this clamp stays as the backstop for rows
 * configured before that.
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

export type CenterCutError = "invalidPercent" | "invalidAmount" | "fixedAbovePrice";

/**
 * Is this cut a valid configuration for this price? (SEC-2b, D-15 (c),
 * SEC-22.) The one rule every place that configures a cut — a class, a
 * one-time session, a session's override — and every place that lowers a price
 * runs, in zod and in the data layer alike:
 * - PERCENTAGE: a whole percent 0–100.
 * - FIXED: whole piastres from 0 up to the price itself. A FIXED cut above the
 *   price would silently give the teacher 0 on every payment
 *   (`splitShare`'s clamp), so it is refused instead (`fixedAbovePrice`).
 */
export function centerCutError(
  price: number,
  shareType: ShareType,
  shareValue: number,
): CenterCutError | null {
  if (shareType === "PERCENTAGE") {
    return Number.isInteger(shareValue) && shareValue >= 0 && shareValue <= 100 ? null : "invalidPercent";
  }
  if (!Number.isInteger(shareValue) || shareValue < 0 || shareValue > MAX_PRICE_PIASTRES) return "invalidAmount";
  return shareValue > price ? "fixedAbovePrice" : null;
}
