/**
 * ID-card colour contrast (R9) — the editor's non-blocking WCAG AA warning.
 *
 * Pure: no runtime imports beyond the card modules, so `npm run check:card-layout`
 * can unit-test it. A poor pairing only ever *warns* — saving is never blocked.
 */
import {
  DEFAULT_BACKGROUND_STOPS,
  DEFAULT_TEXT_COLOR,
  FALLBACK_BRAND_COLOR,
  HEADER_BAND_HEIGHT,
  normalizeHex,
  TEXT_ELEMENT_KEYS,
  type CardElementKey,
} from "./card-layout.ts";
import { CARD_HEIGHT, type CardLayout } from "./id-card.ts";

/** WCAG 2.x AA: 4.5:1 for normal text, 3:1 for large text. */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rgb`/`#rrggbb` colour; `null` if it is not one. */
export function relativeLuminance(color: string): number | null {
  const hex = normalizeHex(color);
  if (!hex) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio (1–21) between two colours; `null` if either is not a hex. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * WCAG "large text" is 18pt, or 14pt bold. The card face is 320 units for
 * 85.6 mm — about one CSS pixel per unit — so that is 24 units, or ~18.7 bold.
 */
export function requiredContrast(fontSize: number, weight: number): number {
  return fontSize >= 24 || (fontSize >= 18.66 && weight >= 700) ? AA_LARGE : AA_NORMAL;
}

export type ContrastIssue = {
  key: CardElementKey;
  ratio: number;
  required: number;
  text: string;
  /** The backdrop that gave the worst ratio. */
  background: string;
};

/**
 * What a text sits on: the header band when the layout has one and the text's
 * middle falls inside it, otherwise the card background (both gradient stops,
 * so the worse of the two decides).
 */
export function textBackdrops(
  layout: CardLayout,
  element: { y: number; fontSize?: number },
  brand: string,
): string[] {
  const middle = element.y + (((element.fontSize ?? 12) / 2) / CARD_HEIGHT) * 100;
  if (layout.headerBand && middle <= HEADER_BAND_HEIGHT) {
    return [normalizeHex(layout.accent) ?? brand];
  }
  const solid = normalizeHex(layout.background);
  return solid ? [solid] : [...DEFAULT_BACKGROUND_STOPS];
}

/** Every text element whose colour falls below AA on what it sits on. */
export function cardContrastIssues(
  layout: CardLayout,
  brandColor: string,
): ContrastIssue[] {
  const brand = normalizeHex(brandColor) ?? FALLBACK_BRAND_COLOR;
  const issues: ContrastIssue[] = [];

  for (const key of TEXT_ELEMENT_KEYS) {
    const element = layout.elements[key];
    if (!element) continue;
    const text = normalizeHex(element.color) ?? DEFAULT_TEXT_COLOR[key];
    const required = requiredContrast(element.fontSize ?? 12, element.weight ?? 400);

    let worst: { ratio: number; background: string } | null = null;
    for (const background of textBackdrops(layout, element, brand)) {
      const ratio = contrastRatio(text, background);
      if (ratio !== null && (worst === null || ratio < worst.ratio)) {
        worst = { ratio, background };
      }
    }
    if (worst && worst.ratio < required) {
      issues.push({ key, text, required, ...worst });
    }
  }
  return issues;
}
