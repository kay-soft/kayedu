/**
 * ID-card customization (`CenterSettings.cardLayout`).
 *
 * The card itself is rendered in M3; M2 owns the *configuration*. Positions
 * are percentages of the card face (0–100) so the same layout works at print
 * DPI and on screen — landscape credit-card proportions, docs/04 §5.
 *
 * The column is free-form JSON on purpose: a center may add keys we have not
 * thought of, and the renderer ignores what it does not understand. This
 * constant is the starting point the editor offers, not a schema.
 */
export const DEFAULT_CARD_LAYOUT = {
  version: 1,
  background: "gradient-navy",
  elements: {
    logo: { x: 6, y: 8, width: 18 },
    centerName: { x: 28, y: 10, fontSize: 14, weight: 700 },
    photo: { x: 6, y: 32, width: 24 },
    studentName: { x: 36, y: 36, fontSize: 16, weight: 600 },
    grade: { x: 36, y: 52, fontSize: 12 },
    studentCode: { x: 36, y: 66, fontSize: 12, weight: 600 },
    qr: { x: 74, y: 46, width: 20 },
  },
} as const;

export function defaultCardLayoutJson(): string {
  return JSON.stringify(DEFAULT_CARD_LAYOUT, null, 2);
}
