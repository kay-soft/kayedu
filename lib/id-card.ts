/**
 * The student ID card — one renderer, three uses (docs/04-design-system.md §5,
 * docs/02-architecture.md §10).
 *
 * `renderIdCardSvg()` produces the card as a self-contained SVG string. The
 * detail-page preview, the print view and the file uploaded to Supabase
 * Storage all call it, so what a center sees on screen is byte-for-byte what
 * prints and what is stored. Images are inlined as data URIs — a stored card
 * must not depend on a signed URL that expires.
 *
 * Positions come from `CenterSettings.cardLayout` (configured in M2). This
 * module has **no runtime imports** so `npm run check:people` can render a
 * card outside the Next.js runtime.
 */
import { DEFAULT_CARD_LAYOUT } from "./card-layout.ts";
import { qrMatrix } from "./qr.ts";

/** Card face in layout units. 320 × 202 ≈ credit-card 85.6 × 54 mm. */
export const CARD_WIDTH = 320;
export const CARD_HEIGHT = 202;

/**
 * One placed element. `x`/`y`/`width` are percentages of the card face;
 * `fontSize` is in card units (the face is 202 units tall), so a layout is
 * resolution-independent and prints at any DPI.
 *
 * `x` is a **logical start** offset: on an Arabic card the whole layout
 * mirrors, exactly like the `ps-/pe-` rule for screens (docs/04 §7).
 */
export type CardElement = {
  x: number;
  y: number;
  width?: number;
  fontSize?: number;
  weight?: number;
};

export type CardLayout = {
  background: string;
  elements: Record<string, CardElement>;
};

const DEFAULT_ELEMENTS = DEFAULT_CARD_LAYOUT.elements as unknown as Record<
  string,
  CardElement
>;

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Merges a center's stored layout over the built-in one. The column is
 * free-form JSON on purpose (lib/card-layout.ts) — anything unrecognised is
 * ignored rather than breaking a card at the front desk.
 */
export function resolveCardLayout(raw: unknown): CardLayout {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const storedElements =
    source.elements && typeof source.elements === "object"
      ? (source.elements as Record<string, unknown>)
      : {};

  const elements: Record<string, CardElement> = {};
  for (const [key, fallback] of Object.entries(DEFAULT_ELEMENTS)) {
    const stored =
      storedElements[key] && typeof storedElements[key] === "object"
        ? (storedElements[key] as Record<string, unknown>)
        : {};
    elements[key] = {
      x: num(stored.x, fallback.x),
      y: num(stored.y, fallback.y),
      ...(fallback.width !== undefined || stored.width !== undefined
        ? { width: num(stored.width, fallback.width ?? 20) }
        : {}),
      ...(fallback.fontSize !== undefined || stored.fontSize !== undefined
        ? { fontSize: num(stored.fontSize, fallback.fontSize ?? 12) }
        : {}),
      ...(fallback.weight !== undefined || stored.weight !== undefined
        ? { weight: num(stored.weight, fallback.weight ?? 400) }
        : {}),
    };
  }

  return {
    background:
      typeof source.background === "string"
        ? source.background
        : DEFAULT_CARD_LAYOUT.background,
    elements,
  };
}

// ── The QR payload ─────────────────────────────────────────────────────────

/**
 * What the reception desk scanner reads (M5). The center id rides along so a
 * card issued by another center cannot be mistaken for a local student code —
 * scanning still resolves through the tenant-scoped lookup, this just fails
 * fast and legibly.
 */
export function studentQrPayload(centerId: string, studentCode: string): string {
  return `KAYEDU|${centerId}|${studentCode}`;
}

export function parseStudentQrPayload(
  payload: string,
): { centerId: string; studentCode: string } | null {
  const parts = payload.trim().split("|");
  if (parts.length !== 3 || parts[0] !== "KAYEDU") return null;
  if (!parts[1] || !parts[2]) return null;
  return { centerId: parts[1], studentCode: parts[2] };
}

// ── Rendering ──────────────────────────────────────────────────────────────

export type IdCardData = {
  centerName: string;
  brandColor: string;
  /** Inlined so a stored card never depends on an expiring signed URL. */
  logoDataUri?: string | null;
  photoDataUri?: string | null;
  studentName: string;
  gradeName?: string | null;
  studentCode: string;
  /** From studentQrPayload(centerId, studentCode) — what the desk scans. */
  qrPayload: string;
  /** Localized field labels — no hardcoded UI strings (CLAUDE.md rule 5). */
  labels: { code: string };
  dir: "rtl" | "ltr";
  layout: CardLayout;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Percentage → card units, clamped so a bad layout cannot escape the face. */
function px(percent: number, extent: number): number {
  return round(Math.min(Math.max(percent, 0), 100) * extent) / 100;
}

type Placed = { x: number; y: number };

/** Mirrors the layout for an Arabic card — `x` is a logical start offset. */
function place(
  element: CardElement,
  dir: "rtl" | "ltr",
  widthUnits = 0,
): Placed {
  const start = px(element.x, CARD_WIDTH);
  const y = px(element.y, CARD_HEIGHT);
  const x = dir === "rtl" ? CARD_WIDTH - start - widthUnits : start;
  return { x: round(x), y: round(y) };
}

function text(
  element: CardElement,
  dir: "rtl" | "ltr",
  value: string,
  options: { fill: string; size?: number; weight?: number; opacity?: number },
): string {
  if (!value) return "";
  const size = options.size ?? element.fontSize ?? 12;
  const { x, y } = place(element, dir);
  const anchor = dir === "rtl" ? "end" : "start";
  const opacity =
    options.opacity !== undefined ? ` opacity="${options.opacity}"` : "";

  // `dominant-baseline` is unreliable across print engines, so y is the text
  // baseline plus the cap height — the same result everywhere.
  return (
    `<text x="${x}" y="${round(y + size * 0.82)}" ` +
    `font-size="${size}" font-weight="${options.weight ?? element.weight ?? 400}" ` +
    `fill="${options.fill}" text-anchor="${anchor}" direction="${dir}"${opacity}>` +
    `${escapeXml(value)}</text>`
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part.charAt(0));
  return letters.join("").toUpperCase() || "?";
}

/**
 * The card, as a standalone SVG document. Landscape credit-card proportions,
 * dark gradient surface, center logo + name, student photo, name, grade,
 * student code and a QR block (docs/04 §5).
 */
export function renderIdCardSvg(data: IdCardData): string {
  const { layout, dir } = data;
  const el = layout.elements;
  const brand = /^#[0-9a-fA-F]{3,8}$/.test(data.brandColor)
    ? data.brandColor
    : "#2563eb";

  const solidBackground = /^#[0-9a-fA-F]{3,8}$/.test(layout.background)
    ? layout.background
    : null;

  const parts: string[] = [];

  parts.push(
    `<defs>` +
      `<linearGradient id="kayedu-card-bg" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#1e293b"/>` +
      `</linearGradient>` +
      `</defs>`,
  );

  parts.push(
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="12" ` +
      `fill="${solidBackground ?? "url(#kayedu-card-bg)"}"/>`,
  );

  // Brand accent along the bottom edge — a horizontal band, so it needs no
  // mirroring in either direction.
  parts.push(
    `<rect x="0" y="${CARD_HEIGHT - 6}" width="${CARD_WIDTH}" height="6" fill="${brand}"/>`,
  );

  // ── Logo ────────────────────────────────────────────────────────────────
  if (el.logo) {
    const size = px(el.logo.width ?? 18, CARD_WIDTH);
    const { x, y } = place(el.logo, dir, size);
    if (data.logoDataUri) {
      parts.push(
        `<image x="${x}" y="${y}" width="${size}" height="${size}" ` +
          `preserveAspectRatio="xMidYMid slice" href="${escapeXml(data.logoDataUri)}"/>`,
      );
    } else {
      parts.push(
        `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6" fill="${brand}"/>` +
          `<text x="${round(x + size / 2)}" y="${round(y + size * 0.7)}" ` +
          `font-size="${round(size * 0.55)}" font-weight="700" fill="#ffffff" ` +
          `text-anchor="middle">${escapeXml(data.centerName.trim().charAt(0))}</text>`,
      );
    }
  }

  if (el.centerName) {
    parts.push(
      text(el.centerName, dir, data.centerName, {
        fill: "#f8fafc",
        weight: el.centerName.weight ?? 700,
      }),
    );
  }

  // ── Photo ───────────────────────────────────────────────────────────────
  if (el.photo) {
    const size = px(el.photo.width ?? 24, CARD_WIDTH);
    const height = round(size * 1.2);
    const { x, y } = place(el.photo, dir, size);
    if (data.photoDataUri) {
      parts.push(
        `<image x="${x}" y="${y}" width="${size}" height="${height}" ` +
          `preserveAspectRatio="xMidYMid slice" href="${escapeXml(data.photoDataUri)}"/>`,
      );
    } else {
      parts.push(
        `<rect x="${x}" y="${y}" width="${size}" height="${height}" rx="6" ` +
          `fill="#ffffff" fill-opacity="0.12"/>` +
          `<text x="${round(x + size / 2)}" y="${round(y + height * 0.62)}" ` +
          `font-size="${round(size * 0.42)}" font-weight="600" fill="#e2e8f0" ` +
          `text-anchor="middle">${escapeXml(initials(data.studentName))}</text>`,
      );
    }
  }

  if (el.studentName) {
    parts.push(
      text(el.studentName, dir, data.studentName, {
        fill: "#ffffff",
        weight: el.studentName.weight ?? 600,
      }),
    );
  }

  if (el.grade && data.gradeName) {
    parts.push(text(el.grade, dir, data.gradeName, { fill: "#cbd5e1" }));
  }

  if (el.studentCode) {
    const size = el.studentCode.fontSize ?? 12;
    parts.push(
      text(el.studentCode, dir, data.labels.code, {
        fill: "#94a3b8",
        size: round(size * 0.72),
        weight: 500,
      }),
    );
    parts.push(
      text(
        { ...el.studentCode, y: el.studentCode.y + 6 },
        dir,
        data.studentCode,
        { fill: "#ffffff", weight: el.studentCode.weight ?? 600 },
      ),
    );
  }

  // ── QR ──────────────────────────────────────────────────────────────────
  if (el.qr) {
    const size = px(el.qr.width ?? 20, CARD_WIDTH);
    const { x, y } = place(el.qr, dir, size);
    const matrix = qrMatrix(data.qrPayload);
    const quiet = round(size * 0.08);
    const inner = round(size - quiet * 2);
    parts.push(
      `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="4" fill="#ffffff"/>` +
        `<g transform="translate(${round(x + quiet)} ${round(y + quiet)}) ` +
        `scale(${round(inner / matrix.count)})">` +
        `<path d="${matrix.path}" fill="#0f172a" shape-rendering="crispEdges"/></g>`,
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" ` +
    `width="85.6mm" height="54mm" role="img" ` +
    `aria-label="${escapeXml(`${data.studentName} — ${data.studentCode}`)}" ` +
    `font-family="Cairo, 'Segoe UI', system-ui, sans-serif">` +
    parts.join("") +
    `</svg>`
  );
}
