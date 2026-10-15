import type { Formats } from "next-intl";

/**
 * Global next-intl formats (docs/04-design-system.md §3 "One numbering system
 * per locale", DES).
 *
 * `Intl` with the bare locale `ar` prints Latin digits, so every ICU count in
 * an Arabic message (`#`, `{n, number}`) came out "3 حصة" beside `lib/format.ts`'s
 * Arabic-Indic "٣". `messages/ar.json` writes its counts as
 * `{count, number, arab}` — this named format — so a translated count uses the
 * same digits as every other figure on the screen. English never references it.
 */
export const FORMATS = {
  number: {
    arab: { numberingSystem: "arab" },
  },
} satisfies Formats;
