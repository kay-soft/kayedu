/**
 * QR generation for student ID cards (docs/04-design-system.md §5).
 *
 * Produces a resolution-independent SVG path instead of a raster image, so the
 * same output is crisp on screen, at print DPI, and inside the generated card
 * we store in Supabase Storage. No runtime (Next/Prisma) imports — the people
 * check exercises this directly.
 */
import qrcode from "qrcode-generator";

export type QrMatrix = {
  /** Modules per side, excluding the quiet zone. */
  count: number;
  /** SVG path data in a `0 0 count count` viewBox. */
  path: string;
};

/**
 * Error correction level M: ~15% recovery, which survives a printed card
 * getting scuffed in a school bag without inflating the module count.
 */
export function qrMatrix(payload: string): QrMatrix {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();

  const count = qr.getModuleCount();
  const parts: string[] = [];

  // Merge each row's dark modules into runs — a third of the path data of one
  // rect per module, and it renders identically.
  for (let row = 0; row < count; row += 1) {
    let runStart = -1;
    for (let col = 0; col <= count; col += 1) {
      const dark = col < count && qr.isDark(row, col);
      if (dark && runStart === -1) {
        runStart = col;
      } else if (!dark && runStart !== -1) {
        parts.push(`M${runStart} ${row}h${col - runStart}v1h-${col - runStart}z`);
        runStart = -1;
      }
    }
  }

  return { count, path: parts.join("") };
}
