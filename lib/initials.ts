/**
 * The letters an avatar falls back to when there is no image — one
 * implementation, used by the sidebar, the header branch switcher, the
 * centre-selection cards and the person avatars on the detail pages alike
 * (CLAUDE.md rule 10, "one normalizer per rule" applied to a display rule
 * rather than a data rule).
 *
 * The rule (R10b): **the initial is the first letter of the name as it is
 * displayed, in whichever locale it is displayed in.** `مركز النور` shows
 * `م`; `Nour Academy` shows `N`. An avatar that disagrees with the label
 * beside it reads as a bug, and the earlier "skip a leading generic word"
 * rule (`مركز`, "Academy", "The") made exactly that happen on every centre
 * named that way. There is no word-skipping of any kind.
 *
 * What the rule still does, because the sidebar once did
 * `name.trim().charAt(0)`:
 *
 *  1. It works in code points. `charAt` returns one UTF-16 code unit, so a
 *     name starting outside the Basic Multilingual Plane yielded half a
 *     surrogate pair — a replacement glyph, not a letter.
 *  2. It skips *characters* that are not a letter or a digit — a leading
 *     quote mark, bracket or invisible bidi mark — which is not skipping a
 *     *word*: `"النور"` (with the quotes) shows `ن`, not a quote.
 */

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The first letter or digit of `text` as a code point — "" when it has none. */
function firstLetter(text: string): string {
  for (const char of text) {
    if (LETTER_OR_DIGIT.test(char)) return char.toLocaleUpperCase();
  }
  return "";
}

/**
 * The single-character avatar label for any displayed name — a person, an
 * organisation, a centre or a branch. "?" only when the name holds no letter
 * or digit at all.
 */
export function nameInitial(name: string): string {
  return firstLetter((name ?? "").trim()) || "?";
}

/** A centre's avatar label: the same rule as a person's, by design. */
export const centerInitial = nameInitial;

/**
 * A person's two-letter monogram. Handles the `"-"` placeholder the data
 * model uses for a single-name person, and code points the same way
 * `nameInitial` does.
 */
export function personInitials(
  firstName: string,
  lastName?: string | null,
): string {
  const first = firstLetter(firstName ?? "");
  const last = firstLetter((lastName ?? "").replace(/^-+$/, ""));
  return `${first}${last}` || "?";
}
