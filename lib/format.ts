/**
 * Numeral convention (docs/02 §8, docs/04 §3): Arabic-Indic digits in `ar`,
 * Latin digits in `en`. Never mix within a locale — always format through here.
 */
const NUMBER_LOCALE: Record<string, string> = {
  ar: "ar-EG-u-nu-arab",
  en: "en-US",
};

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale] ?? "en-US").format(value);
}

export function formatDate(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    dateStyle: "medium",
  }).format(value);
}
