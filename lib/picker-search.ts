import { phoneMatchesQuery } from "./phone.ts";

/**
 * How the searchable pickers (`components/ui/combobox.tsx`) decide an entry
 * matches what was typed (R6, docs/04 §11.16). Matches the **name** and the
 * **phone** — the phone through `lib/phone.ts` (the one normalizer), so
 * `+20 100 123 4567`, `0100…`, `100…`, a tail of digits, or Arabic-Indic
 * digits all find the same person. No second phone implementation here.
 *
 * Pure and import-light so `npm run check:class-creation` can exercise the
 * real predicate outside Next.js.
 */

export type PickerSearchable = {
  label: string;
  phone?: string | null;
};

/** Latin accents, Arabic diacritics and tatweel are not part of what a person types. */
const IGNORED_MARKS = /[̀-ًͯ-ٰٟـ]/g;

export function foldPickerText(value: string): string {
  return value.normalize("NFKD").replace(IGNORED_MARKS, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Digits (either script), spaces and the punctuation a phone is written with — and nothing else. */
const PHONE_ONLY = /^[\d\s+\-().٠-٩۰-۹]+$/;

/**
 * Empty query matches everything. A query written like a phone (digits,
 * spaces, `+`, dashes — `+20 100 123 4567`) is matched as a whole against the
 * phone. Anything with letters is split into words, and every word must be in
 * the name or in the phone ("ahmed 0100": the name has "ahmed" and the phone
 * has "0100").
 */
export function matchesPicker(query: string, item: PickerSearchable): boolean {
  const folded = foldPickerText(query);
  if (folded === "") return true;
  if (PHONE_ONLY.test(query.trim())) return phoneMatchesQuery(item.phone, query);
  const name = foldPickerText(item.label);
  return folded
    .split(" ")
    .every((word) => name.includes(word) || phoneMatchesQuery(item.phone, word));
}
