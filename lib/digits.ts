/**
 * Folds Arabic-Indic (٠-٩) and Extended Arabic-Indic / Persian (۰-۹) digits to
 * ASCII, leaving every other character alone. The one place this happens:
 * the time parser (`lib/time-input.ts`) and the phone search token
 * (`lib/phone.ts`) both type-in numerals that a person on an Arabic keyboard
 * may have entered in either script.
 *
 * No runtime imports, so the gates can exercise it outside Next.js.
 */
export function toAsciiDigits(input: string): string {
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else out += char;
  }
  return out;
}
