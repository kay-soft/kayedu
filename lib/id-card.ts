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
import {
  CARD_BRANCH_TEXT_MAX,
  CARD_FONT_FAMILIES,
  CARD_FONT_FAMILY_KEYS,
  CARD_TEXT_ALIGNS,
  DEFAULT_CARD_LAYOUT,
  DEFAULT_CODE_LABEL_COLOR,
  DEFAULT_TEXT_BOX_WIDTH,
  DEFAULT_TEXT_COLOR,
  FALLBACK_BRAND_COLOR,
  HEADER_BAND_HEIGHT,
  isTextElementKey,
  DEFAULT_CARD_BACKGROUND,
  normalizeHex,
  type CardFontFamily,
  type CardTextAlign,
} from "./card-layout.ts";
import { toAsciiDigits } from "./digits.ts";
import { centerInitial, personInitials } from "./initials.ts";
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
  /** Images: the drawn width. Text: the box `align` aligns within (R9). */
  width?: number;
  fontSize?: number;
  weight?: number;
  /** Text only (R9) — `#rrggbb`; absent = the built-in colour. */
  color?: string;
  /** Text only (R9) — logical, so `start` is the right edge on an Arabic card. */
  align?: CardTextAlign;
  /** Text only (R9) — a key of `CARD_FONT_FAMILIES`; absent = the card font. */
  family?: CardFontFamily;
  /** Branch name only (R9) — replaces the centre's real name when non-blank. */
  text?: string;
};

export type CardLayout = {
  /** `gradient-navy` or a solid colour. */
  background: string;
  /** R9: colour of the header band (and nothing else); absent = the theme colour. */
  accent?: string;
  /** R9: colour of the bottom stripe; absent = the theme colour. */
  footer?: string;
  /** R9: draw the header band. Absent/false = no band, as before. */
  headerBand?: boolean;
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
    // A center's editor can remove an element from the card entirely (M18,
    // docs/04 §11.6 "add from a palette... remove with an ×") — stored as an
    // explicit `null`, distinct from the key simply being absent (which means
    // "not customized, use the built-in default"). `el.X` is checked as a
    // boolean everywhere in the renderer below, so omitting the key here is
    // exactly what makes a removed element not render at all.
    if (storedElements[key] === null) continue;

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
      ...(isTextElementKey(key) ? resolveTextStyle(key, stored) : {}),
    };
  }

  const accent = normalizeHex(source.accent);
  const footer = normalizeHex(source.footer);
  // SEC-71: normalised like `accent` — the built-in surface or a hex colour,
  // never a stored string passed through to the renderer as-is.
  const background =
    source.background === DEFAULT_CARD_BACKGROUND
      ? DEFAULT_CARD_BACKGROUND
      : (normalizeHex(source.background) ?? DEFAULT_CARD_LAYOUT.background);

  return {
    background,
    ...(accent ? { accent } : {}),
    ...(footer ? { footer } : {}),
    ...(source.headerBand === true ? { headerBand: true } : {}),
    elements,
  };
}

/**
 * The R9 text-style keys of one stored element. Each is kept only when it is a
 * value the editor could have written — anything else is dropped, so a hand-
 * edited or older row falls back to today's look instead of a broken card.
 */
function resolveTextStyle(
  key: string,
  stored: Record<string, unknown>,
): Partial<CardElement> {
  const color = normalizeHex(stored.color);
  const align = (CARD_TEXT_ALIGNS as readonly unknown[]).includes(stored.align)
    ? (stored.align as CardTextAlign)
    : null;
  const family = (CARD_FONT_FAMILY_KEYS as readonly unknown[]).includes(stored.family)
    ? (stored.family as CardFontFamily)
    : null;
  const text =
    key === "centerName" && typeof stored.text === "string"
      ? stored.text.trim().slice(0, CARD_BRANCH_TEXT_MAX)
      : "";

  return {
    ...(color ? { color } : {}),
    ...(align ? { align } : {}),
    ...(family ? { family } : {}),
    ...(text ? { text } : {}),
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

/**
 * **The one place a scanned or typed string is turned into a student
 * reference** (R7). A USB keyboard-wedge scanner does not hand over a clean
 * string: it types the QR text like a keyboard, so what arrives can carry a
 * symbology prefix (`]Q1`), a leading STX or trailing CR/LF/TAB the scanner is
 * configured to append, stray invisible characters, full-width or Arabic-Indic
 * digits from an Arabic input method, or a different case. Everything that
 * reads one — the reception search, the session-mode check-in, the gates —
 * goes through `parseScannedStudentInput`; nothing else parses a payload.
 *
 * The payload FORMAT is unchanged (`studentQrPayload` above): the static QR
 * is a locked decision (docs/00 §5.1 "Check-in & the QR payload").
 */

/** Characters a scanner or an input method can add that are never part of the text. */
function isNoiseCodePoint(code: number): boolean {
  return (
    code <= 0x1f || // C0 controls (CR, LF, TAB, STX, ETX, …)
    (code >= 0x7f && code <= 0x9f) || // DEL + C1 controls
    (code >= 0x200b && code <= 0x200f) || // zero-width + LRM/RLM
    (code >= 0x202a && code <= 0x202e) || // bidi embeddings/overrides
    (code >= 0x2060 && code <= 0x2064) || // word joiner, invisible operators
    (code >= 0x2066 && code <= 0x2069) || // bidi isolates
    code === 0xfeff // BOM / zero-width no-break space
  );
}

/**
 * Trim, fold full-width and compatibility forms (NFKC: `ＫＡＹ｜` → `KAY|`),
 * fold Arabic-Indic digits to ASCII (`lib/digits.ts`, the one folder), turn the
 * whitespace controls into spaces and drop every other control or invisible
 * character. The result is what both parsers below read.
 */
export function cleanScannedText(raw: string): string {
  const folded = toAsciiDigits(raw.normalize("NFKC"));
  let out = "";
  for (const char of folded) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d) {
      out += " ";
    } else if (!isNoiseCodePoint(code)) {
      out += char;
    }
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/** `|` plus the look-alikes an input method or a font substitution can produce. */
const PAYLOAD_SEPARATORS = /[|¦∣│]/;
const ID_TOKEN = /^[A-Za-z0-9_-]+$/;

function extractCardPayload(cleaned: string): { centerId: string; studentCode: string } | null {
  const prefix = /KAYEDU/i.exec(cleaned);
  if (!prefix) return null;
  // Anything before the prefix is symbology/prefix noise; read from the prefix on.
  const parts = cleaned.slice(prefix.index + prefix[0].length).split(PAYLOAD_SEPARATORS);
  if (parts.length < 3 || parts[0].trim() !== "") return null;
  const centerId = parts[1].trim();
  if (!ID_TOKEN.test(centerId)) return null;
  // Anything after the code (a suffix the scanner appends) is not part of it.
  const studentCode = /^[A-Za-z0-9_-]+/.exec(parts[2].trim())?.[0];
  if (!studentCode) return null;
  return { centerId, studentCode };
}

/** A card's centre id against this centre's — case-insensitive (ids are lower-case UUIDs). */
export function centerIdsMatch(fromCard: string, centerId: string): boolean {
  return fromCard.toLowerCase() === centerId.toLowerCase();
}

/**
 * The strict card reader: a full `KAYEDU|{centerId}|{studentCode}` payload
 * (tolerant of the noise described above) or `null`. A bare student code is
 * deliberately **not** a payload — use `parseScannedStudentInput` for what a
 * person or a scanner may have entered.
 */
export function parseStudentQrPayload(
  payload: string,
): { centerId: string; studentCode: string } | null {
  return extractCardPayload(cleanScannedText(payload));
}

/** What a reception input holds. */
export type ScannedStudentInput =
  | { kind: "empty" }
  /** A full card payload — the centre id still has to match this centre's. */
  | { kind: "payload"; centerId: string; studentCode: string }
  /** Digits only: a student code typed by hand (or a numeric-only scan). */
  | { kind: "code"; studentCode: string }
  /**
   * Shaped like a card (`…|…|digits`) but without a readable `KAYEDU` prefix —
   * what a scanner sends when the OS keyboard layout is not English: the
   * letters of the prefix and of the centre id arrive as other characters.
   * The centre id cannot be verified, so it is refused rather than guessed at
   * (student codes restart at 1001 in every centre).
   */
  | { kind: "unreadable" }
  /** Anything else — a name or phone fragment, searched as before. */
  | { kind: "text"; text: string };

const MAX_CODE_DIGITS = 15;

export function parseScannedStudentInput(raw: string): ScannedStudentInput {
  const text = cleanScannedText(raw);
  if (text.length === 0) return { kind: "empty" };

  const card = extractCardPayload(text);
  if (card) return { kind: "payload", ...card };

  const compact = text.replace(/ /g, "");
  if (new RegExp(`^[0-9]{1,${MAX_CODE_DIGITS}}$`).test(compact)) {
    return { kind: "code", studentCode: compact };
  }

  const segments = compact.split(PAYLOAD_SEPARATORS);
  if (segments.length >= 3 && /^[0-9]+$/.test(segments[segments.length - 1])) {
    return { kind: "unreadable" };
  }

  return { kind: "text", text };
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
  /**
   * Editor only (R9): wraps each element's markup in `<g data-card-el="key">`
   * so the layout editor can find where every element landed and draw its drag
   * target there. The same renderer, the same markup inside — print and the
   * stored file never set it.
   */
  annotate?: boolean;
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
  options: {
    fill: string;
    size?: number;
    weight?: number;
    opacity?: number;
    /** The element's default box width (percent) when the layout stores none. */
    boxWidth?: number;
  },
): string {
  if (!value) return "";
  const size = options.size ?? element.fontSize ?? 12;
  const align = element.align ?? "start";

  let x: number;
  let y: number;
  let anchor: "start" | "middle" | "end";
  // DES: the anchor is logical. The `direction` attribute on the <text> already
  // makes `start` the right edge of an Arabic run (SVG text-anchor follows the
  // inline direction), so flipping it here as well had anchored every Arabic
  // text at its *left* end — the branch name ran off the card and the photo
  // overprinted the grade. LTR output is byte-for-byte unchanged.
  if (align === "start") {
    // A text is anchored at its logical start (the mirrored `x` on an Arabic card).
    ({ x, y } = place(element, dir));
    anchor = "start";
  } else {
    // Centre / end align inside the element's box. The box is clamped to the
    // card, then mirrored like any other element, so `end` is the left edge of
    // the box on an Arabic card.
    const boxPercent = Math.min(
      element.width ?? options.boxWidth ?? 40,
      100 - Math.min(Math.max(element.x, 0), 100),
    );
    const box = px(boxPercent, CARD_WIDTH);
    const placed = place(element, dir, box);
    y = placed.y;
    if (align === "center") {
      x = round(placed.x + box / 2);
      anchor = "middle";
    } else if (dir === "rtl") {
      // The logical end of an Arabic run is its left edge: the box's left edge.
      x = placed.x;
      anchor = "end";
    } else {
      x = round(placed.x + box);
      anchor = "end";
    }
  }

  const opacity =
    options.opacity !== undefined ? ` opacity="${options.opacity}"` : "";
  const family = element.family
    ? ` font-family="${CARD_FONT_FAMILIES[element.family] ?? CARD_FONT_FAMILIES.cairo}"`
    : "";

  // `dominant-baseline` is unreliable across print engines, so y is the text
  // baseline plus the cap height — the same result everywhere.
  return (
    `<text x="${x}" y="${round(y + size * 0.82)}" ` +
    `font-size="${size}" font-weight="${options.weight ?? element.weight ?? 400}" ` +
    `fill="${options.fill}" text-anchor="${anchor}" direction="${dir}"${opacity}${family}>` +
    `${escapeXml(value)}</text>`
  );
}

/** A colour from a layout, or `fallback` — only `#rrggbb` ever reaches the SVG. */
function paint(value: string | undefined, fallback: string): string {
  return normalizeHex(value) ?? fallback;
}

/** The photo placeholder's monogram — the one initials rule (`lib/initials.ts`, SYS). */
function initials(name: string): string {
  const [first = "", second = ""] = name.trim().split(/\s+/).filter(Boolean);
  return personInitials(first, second);
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
    : FALLBACK_BRAND_COLOR;

  const solidBackground = /^#[0-9a-fA-F]{3,8}$/.test(layout.background)
    ? layout.background
    : null;

  const parts: string[] = [];

  // Editor-only hook (`annotate`): each element's markup sits in a group the
  // editor can measure. Off for print and for the stored file.
  const group = (key: string, markup: string): string =>
    data.annotate && markup ? `<g data-card-el="${key}">${markup}</g>` : markup;

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

  // Optional header band (R9) — full width, so it needs no mirroring; its top
  // corners follow the card's own 12-unit radius.
  if (layout.headerBand) {
    const height = round((CARD_HEIGHT * HEADER_BAND_HEIGHT) / 100);
    parts.push(
      `<path d="M0 ${height}V12a12 12 0 0 1 12-12H${CARD_WIDTH - 12}a12 12 0 0 1 12 12V${height}Z" ` +
        `fill="${paint(layout.accent, brand)}"/>`,
    );
  }

  // Brand accent along the bottom edge — a horizontal band, so it needs no
  // mirroring in either direction.
  parts.push(
    `<rect x="0" y="${CARD_HEIGHT - 6}" width="${CARD_WIDTH}" height="6" fill="${paint(layout.footer, brand)}"/>`,
  );

  // ── Logo ────────────────────────────────────────────────────────────────
  if (el.logo) {
    const size = px(el.logo.width ?? 18, CARD_WIDTH);
    const { x, y } = place(el.logo, dir, size);
    if (data.logoDataUri) {
      parts.push(
        group(
          "logo",
          `<image x="${x}" y="${y}" width="${size}" height="${size}" ` +
            `preserveAspectRatio="xMidYMid slice" href="${escapeXml(data.logoDataUri)}"/>`,
        ),
      );
    } else {
      // The initial's tile is the theme colour — except on a header band, where
      // that could be the band's own colour and vanish, so it goes translucent.
      const tile = layout.headerBand
        ? `fill="#ffffff" fill-opacity="0.22"`
        : `fill="${brand}"`;
      parts.push(
        group(
          "logo",
          `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6" ${tile}/>` +
            `<text x="${round(x + size / 2)}" y="${round(y + size * 0.7)}" ` +
            `font-size="${round(size * 0.55)}" font-weight="700" fill="#ffffff" ` +
            `text-anchor="middle">${escapeXml(centerInitial(data.centerName))}</text>`,
        ),
      );
    }
  }

  if (el.centerName) {
    // A custom branch text (R9) replaces the real name; blank falls back to it.
    const shown = el.centerName.text?.trim() || data.centerName;
    parts.push(
      group(
        "centerName",
        text(el.centerName, dir, shown, {
          fill: paint(el.centerName.color, DEFAULT_TEXT_COLOR.centerName),
          weight: el.centerName.weight ?? 700,
          boxWidth: DEFAULT_TEXT_BOX_WIDTH.centerName,
        }),
      ),
    );
  }

  // ── Photo ───────────────────────────────────────────────────────────────
  if (el.photo) {
    const size = px(el.photo.width ?? 24, CARD_WIDTH);
    const height = round(size * 1.2);
    const { x, y } = place(el.photo, dir, size);
    if (data.photoDataUri) {
      parts.push(
        group(
          "photo",
          `<image x="${x}" y="${y}" width="${size}" height="${height}" ` +
            `preserveAspectRatio="xMidYMid slice" href="${escapeXml(data.photoDataUri)}"/>`,
        ),
      );
    } else {
      parts.push(
        group(
          "photo",
          `<rect x="${x}" y="${y}" width="${size}" height="${height}" rx="6" ` +
            `fill="#ffffff" fill-opacity="0.12"/>` +
            `<text x="${round(x + size / 2)}" y="${round(y + height * 0.62)}" ` +
            `font-size="${round(size * 0.42)}" font-weight="600" fill="#e2e8f0" ` +
            `text-anchor="middle">${escapeXml(initials(data.studentName))}</text>`,
        ),
      );
    }
  }

  if (el.studentName) {
    parts.push(
      group(
        "studentName",
        text(el.studentName, dir, data.studentName, {
          fill: paint(el.studentName.color, DEFAULT_TEXT_COLOR.studentName),
          weight: el.studentName.weight ?? 600,
          boxWidth: DEFAULT_TEXT_BOX_WIDTH.studentName,
        }),
      ),
    );
  }

  if (el.grade && data.gradeName) {
    parts.push(
      group(
        "grade",
        text(el.grade, dir, data.gradeName, {
          fill: paint(el.grade.color, DEFAULT_TEXT_COLOR.grade),
          boxWidth: DEFAULT_TEXT_BOX_WIDTH.grade,
        }),
      ),
    );
  }

  if (el.studentCode) {
    const size = el.studentCode.fontSize ?? 12;
    const customColor = normalizeHex(el.studentCode.color);
    parts.push(
      group(
        "studentCode",
        text(el.studentCode, dir, data.labels.code, {
          // The small caption keeps its muted look; a custom colour recolours
          // it too, softened, so the pair still reads as label + value.
          fill: customColor ?? DEFAULT_CODE_LABEL_COLOR,
          size: round(size * 0.72),
          weight: 500,
          ...(customColor ? { opacity: 0.75 } : {}),
          boxWidth: DEFAULT_TEXT_BOX_WIDTH.studentCode,
        }) +
          text(
            { ...el.studentCode, y: el.studentCode.y + 6 },
            dir,
            data.studentCode,
            {
              fill: customColor ?? DEFAULT_TEXT_COLOR.studentCode,
              weight: el.studentCode.weight ?? 600,
              boxWidth: DEFAULT_TEXT_BOX_WIDTH.studentCode,
            },
          ),
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
      group(
        "qr",
        `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="4" fill="#ffffff"/>` +
          `<g transform="translate(${round(x + quiet)} ${round(y + quiet)}) ` +
          `scale(${round(inner / matrix.count)})">` +
          `<path d="${matrix.path}" fill="#0f172a" shape-rendering="crispEdges"/></g>`,
      ),
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
