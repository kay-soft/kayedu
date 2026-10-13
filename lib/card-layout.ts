/**
 * ID-card customization (`CenterSettings.cardLayout`).
 *
 * The card itself is rendered in M3; M2 owns the *configuration*. Positions
 * are percentages of the card face (0–100) so the same layout works at print
 * DPI and on screen — landscape credit-card proportions, docs/04 §5.
 *
 * The column is JSON, validated on **write** (`cardLayoutSchema`,
 * lib/validation/settings.ts — R9: hex colours only, fonts from the list below,
 * bounded sizes, no raw CSS) and read **tolerantly** (`resolveCardLayout`,
 * lib/id-card.ts): a layout saved before a key existed simply lacks it, and
 * "absent" always means today's default. This module is the pure vocabulary
 * both sides share, and — like lib/id-card.ts — has no runtime imports.
 *
 * `width` is a percentage of the card **width** and the logo is drawn square,
 * so it also has to clear the photo below it — 13% is the largest value that
 * does on a 320 x 202 face (lib/id-card.ts).
 */
export const DEFAULT_CARD_LAYOUT = {
  version: 1,
  background: "gradient-navy",
  elements: {
    logo: { x: 6, y: 8, width: 13 },
    centerName: { x: 28, y: 10, fontSize: 14, weight: 700 },
    photo: { x: 6, y: 32, width: 24 },
    studentName: { x: 36, y: 36, fontSize: 16, weight: 600 },
    grade: { x: 36, y: 52, fontSize: 12 },
    studentCode: { x: 36, y: 66, fontSize: 12, weight: 600 },
    qr: { x: 74, y: 46, width: 20 },
  },
} as const;

/**
 * The seven elements the renderer (`lib/id-card.ts`) knows how to draw, in
 * the order the visual editor's palette offers them (M18). Adding one back
 * after removal restores exactly this default position/size.
 */
export const CARD_ELEMENT_KEYS = [
  "logo",
  "centerName",
  "photo",
  "studentName",
  "grade",
  "studentCode",
  "qr",
] as const;

export type CardElementKey = (typeof CARD_ELEMENT_KEYS)[number];

/** Which of the seven elements carry a `width` (images) vs a `fontSize` (text) — the editor's resize handle adjusts the field that actually exists on that element. */
export const IMAGE_ELEMENT_KEYS: readonly CardElementKey[] = ["logo", "photo", "qr"];

/** The four text elements — the ones the R9 style controls apply to. */
export const TEXT_ELEMENT_KEYS: readonly CardElementKey[] = [
  "centerName",
  "studentName",
  "grade",
  "studentCode",
];

export function isTextElementKey(key: string): boolean {
  return (TEXT_ELEMENT_KEYS as readonly string[]).includes(key);
}

// ── R9 styling vocabulary ───────────────────────────────────────────────────

/** The built-in surface when no solid `background` colour is stored. */
export const DEFAULT_CARD_BACKGROUND = "gradient-navy";
/** The two stops of that gradient — the contrast check uses the worse of them. */
export const DEFAULT_BACKGROUND_STOPS = ["#0f172a", "#1e293b"] as const;
/** Used when a centre's theme colour is not a usable hex. */
export const FALLBACK_BRAND_COLOR = "#2563eb";

/**
 * The font families a text element may use — a short, closed list (R9). Only
 * `cairo` is a web font the app loads (the product font, Arabic + Latin); the
 * other two are operating-system stacks chosen because both ship Arabic and
 * Latin glyphs, so nothing new is downloaded. The stored value is the **key**,
 * never a CSS string.
 */
export const CARD_FONT_FAMILIES = {
  cairo: "Cairo, 'Segoe UI', system-ui, sans-serif",
  system: "'Segoe UI', Tahoma, Arial, system-ui, sans-serif",
  serif: "'Times New Roman', Georgia, serif",
} as const;

export type CardFontFamily = keyof typeof CARD_FONT_FAMILIES;

export const CARD_FONT_FAMILY_KEYS = Object.keys(
  CARD_FONT_FAMILIES,
) as CardFontFamily[];

/** Logical alignment of a text inside its box — `start` flips in Arabic. */
export const CARD_TEXT_ALIGNS = ["start", "center", "end"] as const;
export type CardTextAlign = (typeof CARD_TEXT_ALIGNS)[number];

/** `weight` values the editor's Normal / Bold toggle writes. */
export const CARD_WEIGHT_NORMAL = 400;
export const CARD_WEIGHT_BOLD = 700;

/** Longest custom branch-name text (R9). */
export const CARD_BRANCH_TEXT_MAX = 60;

/** Bounds shared by the schema, the editor's number fields and the renderer. */
export const CARD_BOUNDS = {
  position: { min: 0, max: 100 },
  imageWidth: { min: 5, max: 60 },
  /** A text element's box — what `align` aligns within. */
  textWidth: { min: 10, max: 100 },
  fontSize: { min: 8, max: 28 },
  weight: { min: 100, max: 900 },
} as const;

/**
 * How wide (percent of the card) a text's box is when the layout does not
 * store one: from the element's default start to the next thing on its row
 * (the QR code for the three lower texts, the card edge for the branch name).
 * It only matters once `align` is `center` or `end` — a `start`-aligned text
 * needs no box, which is why an old layout renders exactly as before.
 */
export const DEFAULT_TEXT_BOX_WIDTH: Record<string, number> = {
  centerName: 66,
  studentName: 36,
  grade: 36,
  studentCode: 36,
};

/** The text colours the renderer used before R9 — "absent colour" means these. */
export const DEFAULT_TEXT_COLOR: Record<string, string> = {
  centerName: "#f8fafc",
  studentName: "#ffffff",
  grade: "#cbd5e1",
  studentCode: "#ffffff",
};
/** The small "Student code" caption above the code. */
export const DEFAULT_CODE_LABEL_COLOR = "#94a3b8";

/** Height of the optional header band, as a percent of the card height. */
export const HEADER_BAND_HEIGHT = 30;

/**
 * Which fields each element may carry. The schema (`cardLayoutSchema`) and the
 * editor's serializer both read this, so a field an element does not have can
 * never be stored.
 */
const IMAGE_FIELDS = ["x", "y", "width"] as const;
const TEXT_FIELDS = [
  "x",
  "y",
  "width",
  "fontSize",
  "weight",
  "color",
  "align",
  "family",
] as const;
export const CARD_ELEMENT_FIELDS: Record<CardElementKey, readonly string[]> = {
  logo: IMAGE_FIELDS,
  photo: IMAGE_FIELDS,
  qr: IMAGE_FIELDS,
  centerName: [...TEXT_FIELDS, "text"],
  studentName: TEXT_FIELDS,
  grade: TEXT_FIELDS,
  studentCode: TEXT_FIELDS,
};

/**
 * `#RGB` / `#RRGGBB` (any case) → `#rrggbb`, else `null`. The one colour
 * normalizer: the resolver, the schema, the editor and the contrast check all
 * go through it (CLAUDE.md rule 10), and nothing but a value that passes it is
 * ever written into the SVG.
 */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  return digits.length === 3
    ? `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`
    : `#${digits}`;
}
