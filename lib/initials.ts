/**
 * The letters an avatar falls back to when there is no image — one
 * implementation, used by the sidebar, the header branch switcher and the
 * centre-selection cards alike (CLAUDE.md rule 10, "one normalizer per rule"
 * applied to a display rule rather than a data rule).
 *
 * The sidebar previously did `name.trim().charAt(0)`, which is wrong in three
 * ways that all show up in this product:
 *
 *  1. `charAt` returns one UTF-16 code unit, so any name starting outside the
 *     Basic Multilingual Plane yields half a surrogate pair — a replacement
 *     glyph, not a letter.
 *  2. It takes punctuation, digits and invisible bidi marks as the initial. A
 *     centre saved as `"النور"` (with the quotes) shows a quote mark.
 *  3. Most Egyptian centres are registered as `مركز <name>` or
 *     `<name> Academy` — the generic word is not what anyone calls the place,
 *     so an initial taken from it labels every branch in a city with the same
 *     letter.
 *
 * So: work in code points, skip anything that is not a letter or a digit, and
 * skip a leading generic word when the name has a real one after it.
 */

/** Words nobody uses to identify a centre when saying its name aloud. */
const GENERIC_PREFIXES = new Set([
  "مركز",
  "مراكز",
  "أكاديمية",
  "اكاديمية",
  "مدرسة",
  "معهد",
  "سنتر",
  "center",
  "centre",
  "academy",
  "school",
  "institute",
  "the",
]);

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The first letter of a word, as a code point — "" when the word has none. */
function firstLetter(word: string): string {
  for (const char of word) {
    if (LETTER_OR_DIGIT.test(char)) return char.toLocaleUpperCase();
  }
  return "";
}

/**
 * The single-character avatar label for an organization, centre or branch
 * name. Returns "?" only when the name holds no letter or digit at all.
 */
export function centerInitial(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => firstLetter(word) !== "");

  if (words.length === 0) return "?";

  const meaningful =
    words.length > 1 && GENERIC_PREFIXES.has(words[0].toLocaleLowerCase())
      ? words[1]
      : words[0];

  return firstLetter(meaningful) || "?";
}

/**
 * The single-letter avatar label for a person's name. Unlike `centerInitial`
 * it never skips a leading word — "Center" is a generic prefix on a business
 * name, but a person called Amira is not shortened to her surname.
 */
export function nameInitial(name: string): string {
  for (const word of (name ?? "").trim().split(/\s+/)) {
    const letter = firstLetter(word);
    if (letter) return letter;
  }
  return "?";
}

/**
 * A person's two-letter monogram. Handles the `"-"` placeholder the data
 * model uses for a single-name person, and code points the same way
 * `centerInitial` does.
 */
export function personInitials(
  firstName: string,
  lastName?: string | null,
): string {
  const first = firstLetter(firstName ?? "");
  const last = firstLetter((lastName ?? "").replace(/^-+$/, ""));
  return `${first}${last}` || "?";
}
