/**
 * ID-card styling + Users & Roles scope check — the R9 acceptance gate.
 *
 * Run with:  npm run check:card-layout
 *
 * R9 gives the ID-card editor text styling, card colours and a custom branch
 * text, fixes dragging and selection, and takes teachers off the Users & Roles
 * screen. CLAUDE.md rule 1 forbids browser testing, so this gate enforces the
 * mechanisms instead (the same way `check:rtl` does):
 *
 *  1. The stored shape — `cardLayoutSchema` accepts a valid styled layout and
 *     refuses a bad hex, an unknown font, an oversized text, an out-of-range
 *     size, an unknown key and a raw CSS string; old layouts still validate.
 *  2. `resolveCardLayout` — the single resolver: old layouts resolve to exactly
 *     what they did, new keys are optional, custom branch text vs fallback,
 *     colour keys resolved, anything unrecognised dropped.
 *  3. The one renderer — golden SHA-256 of the SVG for layouts saved before R9
 *     (captured from the pre-R9 renderer, so "renders exactly as before" is
 *     byte-for-byte), the new styles actually reach the SVG in both directions,
 *     the editor's `annotate` hook adds nothing but wrapper groups, and
 *     statically no second card renderer exists.
 *  4. The QR payload — a golden string and the parser round trip, untouched.
 *  5. Contrast helper unit tests (WCAG AA), including the non-blocking
 *     editor-side pairing logic.
 *  6. Users & Roles — the staff queries (the exact filters the screen runs)
 *     exclude TEACHER memberships and invitations; TEACHER is refused by the
 *     invitation and role-change schemas the actions parse with; the dropdowns
 *     do not offer it; and the permissions matrix still lists the TEACHER
 *     column.
 *  7. The Center 60 seed layout is valid and clears AA.
 *
 * Section 6's data checks need a reachable database (a throwaway organization,
 * cleaned up after) — like every other gate. Nothing here can reset a database.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient, type Role } from "@prisma/client";

import {
  CARD_BRANCH_TEXT_MAX,
  CARD_FONT_FAMILIES,
  CARD_FONT_FAMILY_KEYS,
  DEFAULT_CARD_LAYOUT,
  normalizeHex,
} from "../lib/card-layout.ts";
import {
  AA_LARGE,
  AA_NORMAL,
  cardContrastIssues,
  contrastRatio,
  relativeLuminance,
  requiredContrast,
} from "../lib/card-style.ts";
import {
  parseStudentQrPayload,
  renderIdCardSvg,
  resolveCardLayout,
  studentQrPayload,
  type CardLayout,
} from "../lib/id-card.ts";
import {
  CENTER_STAFF_ROLES,
  MATRIX_ROLES,
  editableActionsFor,
} from "../lib/auth/permissions.ts";
import {
  staffInvitationFilter,
  staffMembershipFilter,
} from "../lib/db/staff-filter.ts";
import { scopedData, scopedWhere } from "../lib/db/tenant-scope.ts";
import {
  ASSIGNABLE_STAFF_ROLES,
  createInvitationSchema,
} from "../lib/validation/auth.ts";
import {
  cardLayoutDocumentSchema,
  cardLayoutSchema,
  memberRoleSchema,
} from "../lib/validation/settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const prisma = new PrismaClient();

const SLUG_A = "card-layout-check-a";
const SLUG_B = "card-layout-check-b";
const ORG_NAME = "Card Layout Check Org";
const EMAIL_PREFIX = "card-layout-check-";

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** A file's code without its comments — a doc comment naming a function is not a call. */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The posted form value, as the editor builds it. */
function parseLayout(layout: unknown) {
  return cardLayoutSchema.safeParse({
    locale: "en",
    cardLayout: JSON.stringify(layout),
  });
}

const LAYOUT_FULL = {
  version: 1,
  background: "#0f2a1d",
  accent: "#166534",
  footer: "#f59e0b",
  headerBand: true,
  elements: {
    logo: { x: 6, y: 8, width: 13 },
    centerName: {
      x: 28,
      y: 10,
      width: 66,
      fontSize: 14,
      weight: 700,
      color: "#FDE68A",
      align: "center",
      family: "serif",
      text: "Custom Name",
    },
    photo: null,
    studentName: { x: 36, y: 36, fontSize: 16, weight: 600, color: "#00ff00", align: "end", family: "system" },
    grade: { x: 36, y: 52, fontSize: 12 },
    studentCode: { x: 36, y: 66, fontSize: 12, weight: 600 },
    qr: { x: 74, y: 46, width: 20 },
  },
};

// ── Golden values, captured from the renderer as it was before R9 ──────────

const GOLDEN_CENTER_ID = "c0ffee00-1111-2222-3333-444455556666";
const GOLDEN_QR_PAYLOAD = `KAYEDU|${GOLDEN_CENTER_ID}|1001`;

const CARD_BASE = {
  centerName: 'Al-Noor "A" & Co',
  brandColor: "#2563eb",
  studentName: "Mona Hassan",
  gradeName: "Grade 11",
  studentCode: "1001",
  qrPayload: studentQrPayload(GOLDEN_CENTER_ID, "1001"),
  labels: { code: "Student code" },
};

/** Layouts a centre could already have saved before R9, and the SVG each one produced. */
const OLD_LAYOUTS: { name: string; raw: unknown; ltr: string; rtl: string }[] = [
  {
    name: "no layout at all (the built-in card)",
    raw: null,
    ltr: "f5424847a1fbf1a02e2a33e597d57c0562d31baa41d84ba4992b604784c95208",
    rtl: "7e818170d51d5c87bf44251d85ef4e8676fa2e3274600c9de58eb838f7ebca57",
  },
  {
    name: "a one-element override",
    raw: { version: 1, elements: { qr: { x: 70, width: 22 } } },
    ltr: "34d0fbff65436d29d75cdd802b78a5719387ab5069af4bd746152d04bbb97ae0",
    rtl: "c9824540e0dc54d54026e0a5fb4c3bf5958166c90bd2725366b6969923330275",
  },
  {
    name: "a solid background with a removed logo",
    raw: {
      version: 1,
      background: "#112233",
      elements: { logo: null, grade: { x: 40, y: 50, fontSize: 14, weight: 700 } },
    },
    ltr: "a21ce9a044053199a0c64ce7f63704e8997623c7d5ccfce1f03ee5c2267954a7",
    rtl: "823f3724812bdb7ca6b8e40c9c444a28ce23339bcd786dc46fe27e2a9f9e78bc",
  },
  {
    name: "the full shape the M18 editor saved",
    raw: {
      version: 1,
      background: "gradient-navy",
      elements: {
        logo: { x: 6, y: 8, width: 13 },
        centerName: { x: 28, y: 10, fontSize: 14, weight: 700 },
        photo: null,
        studentName: { x: 36, y: 36, fontSize: 16, weight: 600 },
        grade: { x: 36, y: 52, fontSize: 12 },
        studentCode: { x: 36, y: 66, fontSize: 12, weight: 600 },
        qr: { x: 74, y: 46, width: 20 },
      },
    },
    ltr: "23c89e874699c3583ef00b0159621f638745b7c467d51e6a5f67031b96c98d29",
    rtl: "3dce242065bcc3d296aa5fc540b218e80b75213184209163b2422072830a7325",
  },
];

function render(layout: CardLayout, dir: "ltr" | "rtl", extra: { annotate?: boolean; centerName?: string } = {}) {
  return renderIdCardSvg({ ...CARD_BASE, ...extra, dir, layout });
}

/** The one `<text …>content</text>` whose content is `content`. */
function textTag(svg: string, content: string): string {
  const escaped = content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<text [^>]*>${escaped}</text>`).exec(svg)?.[0] ?? "";
}

function attr(tag: string, name: string): string | null {
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

/** Removes the editor's `data-card-el` wrapper groups, leaving the markup inside. */
function unwrapAnnotations(svg: string): string {
  const stack: boolean[] = [];
  return svg.replace(/<g\b[^>]*>|<\/g>/g, (token) => {
    if (token === "</g>") return stack.pop() ? "" : token;
    const annotation = token.startsWith("<g data-card-el=");
    stack.push(annotation);
    return annotation ? "" : token;
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", ".git"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.organization.deleteMany({ where: { name: ORG_NAME } });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

async function addMember(centerId: string, role: Role, tag: string) {
  const user = await prisma.user.create({
    data: {
      firstName: role,
      lastName: tag,
      email: `${EMAIL_PREFIX}${tag}@example.test`,
      locale: "en",
    },
  });
  return prisma.membership.create({
    data: scopedData(centerId, {
      userId: user.id,
      role,
      firstName: role,
      lastName: tag,
      joinedAt: new Date(),
    }),
  });
}

async function addInvitation(centerId: string, role: Role, tag: string) {
  return prisma.invitation.create({
    data: scopedData(centerId, {
      email: `${EMAIL_PREFIX}invite-${tag}@example.test`,
      role,
      token: `${EMAIL_PREFIX}${tag}-${Math.random().toString(36).slice(2)}`,
      invitedBy: "card-layout-check",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }),
  });
}

async function main() {
  await cleanup();
  console.log("ID-card styling + Users & Roles scope check (R9)");

  // ── 1. The stored shape ────────────────────────────────────────────────
  console.log("\n1. cardLayoutSchema");
  const accepted = parseLayout(LAYOUT_FULL);
  check("a fully styled layout is accepted", accepted.success);
  check(
    "hex colours are normalized to lower-case on the way in",
    accepted.success &&
      (accepted.data.cardLayout as { elements: { centerName: { color: string } } }).elements
        .centerName.color === "#fde68a",
  );
  check(
    "layouts saved before R9 still validate",
    OLD_LAYOUTS.every((old) => old.raw === null || parseLayout(old.raw).success),
  );
  check(
    "the existing config-check layout (partial element, no y) still validates",
    parseLayout({ version: 1, elements: { qr: { x: 74 } } }).success,
  );
  check("an empty field still means 'no customization'", cardLayoutSchema.safeParse({ locale: "en", cardLayout: "  " }).data?.cardLayout === null);
  check("malformed JSON and a non-object are still refused",
    !cardLayoutSchema.safeParse({ locale: "en", cardLayout: "{nope" }).success &&
      !cardLayoutSchema.safeParse({ locale: "en", cardLayout: "[1,2]" }).success);

  const withText = (patch: object) => ({
    ...LAYOUT_FULL,
    elements: { ...LAYOUT_FULL.elements, studentName: { x: 36, y: 36, ...patch } },
  });
  check("a colour that is not #RRGGBB is refused (name)", !parseLayout(withText({ color: "red" })).success);
  check("a colour that is not #RRGGBB is refused (3-digit)", !parseLayout(withText({ color: "#fff" })).success);
  check("a colour that is not #RRGGBB is refused (8-digit)", !parseLayout(withText({ color: "#ffffffff" })).success);
  check("a raw CSS string is refused as a colour", !parseLayout(withText({ color: "url(javascript:alert(1))" })).success);
  check("an unknown font family is refused", !parseLayout(withText({ family: "Comic Sans MS" })).success);
  check("a raw font stack is refused", !parseLayout(withText({ family: "'Segoe UI', sans-serif" })).success);
  check("an unknown alignment is refused", !parseLayout(withText({ align: "left" })).success);
  check("a font size below the minimum is refused", !parseLayout(withText({ fontSize: 7 })).success);
  check("a font size above the maximum is refused", !parseLayout(withText({ fontSize: 29 })).success);
  check("a position outside the card is refused", !parseLayout(withText({ x: 101 })).success && !parseLayout(withText({ y: -1 })).success);
  check("a text box wider than the card is refused", !parseLayout(withText({ width: 101 })).success);
  check("a non-number size is refused", !parseLayout(withText({ fontSize: "14" })).success);
  check("an unknown element key is refused", !parseLayout({ ...LAYOUT_FULL, elements: { ...LAYOUT_FULL.elements, banner: { x: 1, y: 1 } } }).success);
  check("an unknown field on an element is refused", !parseLayout(withText({ shadow: "0 0 4px red" })).success);
  check("a text style on an image element is refused", !parseLayout({ ...LAYOUT_FULL, elements: { ...LAYOUT_FULL.elements, logo: { x: 6, y: 8, width: 13, color: "#ffffff" } } }).success);
  check("an unknown top-level key is refused", !parseLayout({ ...LAYOUT_FULL, css: "body{}" }).success);
  check("a background that is neither the gradient nor a hex is refused", !parseLayout({ ...LAYOUT_FULL, background: "linear-gradient(red, blue)" }).success);
  check("an image wider than the maximum is refused", !parseLayout({ ...LAYOUT_FULL, elements: { ...LAYOUT_FULL.elements, qr: { x: 74, y: 46, width: 61 } } }).success);

  const branchText = (text: string) => ({
    ...LAYOUT_FULL,
    elements: { ...LAYOUT_FULL.elements, centerName: { x: 28, y: 10, text } },
  });
  check(`a branch text of exactly ${CARD_BRANCH_TEXT_MAX} characters is accepted`, parseLayout(branchText("x".repeat(CARD_BRANCH_TEXT_MAX))).success);
  check(`a branch text over ${CARD_BRANCH_TEXT_MAX} characters is refused`, !parseLayout(branchText("x".repeat(CARD_BRANCH_TEXT_MAX + 1))).success);
  check("a branch text with a control character is refused", !parseLayout(branchText("a\u0007b")).success);
  check("a blank branch text is accepted (it means 'use the real name')", parseLayout(branchText("")).success);
  check("a custom text on any other element is refused", !parseLayout(withText({ text: "hi" })).success);
  check(
    "the document schema is the one the action parses with",
    cardLayoutDocumentSchema.safeParse(LAYOUT_FULL).success,
  );

  // ── 2. The resolver ────────────────────────────────────────────────────
  console.log("\n2. resolveCardLayout");
  const builtIn = resolveCardLayout(null);
  check(
    "no stored layout resolves to the built-in one, with none of the new keys",
    builtIn.elements.centerName.x === 28 &&
      builtIn.background === DEFAULT_CARD_LAYOUT.background &&
      builtIn.accent === undefined &&
      builtIn.footer === undefined &&
      builtIn.headerBand === undefined &&
      Object.values(builtIn.elements).every(
        (element) =>
          element.color === undefined &&
          element.align === undefined &&
          element.family === undefined &&
          element.text === undefined,
      ),
  );
  check(
    "an old layout resolves exactly as before (positions merged, no new keys)",
    JSON.stringify(resolveCardLayout({ version: 1, elements: { qr: { x: 70, width: 22 } } }).elements.qr) ===
      JSON.stringify({ x: 70, y: 46, width: 22 }),
  );
  const resolved = resolveCardLayout(LAYOUT_FULL);
  check(
    "colour keys resolve (background, accent, footer, header band, per-text colour)",
    resolved.background === "#0f2a1d" &&
      resolved.accent === "#166534" &&
      resolved.footer === "#f59e0b" &&
      resolved.headerBand === true &&
      resolved.elements.centerName.color === "#fde68a" &&
      resolved.elements.studentName.color === "#00ff00",
  );
  check(
    "style keys resolve (alignment, font, box width, weight)",
    resolved.elements.centerName.align === "center" &&
      resolved.elements.centerName.family === "serif" &&
      resolved.elements.centerName.width === 66 &&
      resolved.elements.studentName.align === "end" &&
      resolved.elements.studentName.family === "system",
  );
  check("a removed element stays removed", resolved.elements.photo === undefined);
  check("custom branch text resolves", resolved.elements.centerName.text === "Custom Name");
  check(
    "blank custom branch text resolves to no text (the fallback)",
    resolveCardLayout({ elements: { centerName: { text: "   " } } }).elements.centerName.text === undefined,
  );
  check(
    "branch text is trimmed and capped at the maximum",
    resolveCardLayout({ elements: { centerName: { text: `  ${"y".repeat(100)}  ` } } }).elements
      .centerName.text?.length === CARD_BRANCH_TEXT_MAX,
  );
  const hostile = resolveCardLayout({
    background: "gradient-navy",
    accent: "red",
    footer: "url(#x)",
    headerBand: "yes",
    elements: {
      studentName: { color: "red", align: "diagonal", family: "Comic Sans", text: "nope" },
      logo: { color: "#ffffff", align: "end" },
    },
  });
  check(
    "unrecognised style values are dropped, never carried into the card",
    hostile.accent === undefined &&
      hostile.footer === undefined &&
      hostile.headerBand === undefined &&
      hostile.elements.studentName.color === undefined &&
      hostile.elements.studentName.align === undefined &&
      hostile.elements.studentName.family === undefined &&
      hostile.elements.studentName.text === undefined &&
      hostile.elements.logo.color === undefined,
  );
  check("malformed input falls back to the built-in layout", resolveCardLayout("not json").elements.qr.x === 74);

  // ── 3. The one renderer ────────────────────────────────────────────────
  console.log("\n3. One renderer");
  for (const old of OLD_LAYOUTS) {
    const layout = resolveCardLayout(old.raw);
    check(`old layout renders byte-for-byte as before (LTR) — ${old.name}`, sha256(render(layout, "ltr")) === old.ltr);
    check(`old layout renders byte-for-byte as before (RTL) — ${old.name}`, sha256(render(layout, "rtl")) === old.rtl);
  }

  const styledLtr = render(resolved, "ltr", { centerName: "Real Branch" });
  const styledRtl = render(resolved, "rtl", { centerName: "Real Branch" });
  for (const [dir, svg] of [["LTR", styledLtr], ["RTL", styledRtl]] as const) {
    check(`custom branch text replaces the real name (${dir})`, svg.includes(">Custom Name</text>") && !svg.includes("Real Branch"));
    const name = textTag(svg, "Custom Name");
    check(`branch text takes its colour, font and alignment (${dir})`,
      attr(name, "fill") === "#fde68a" &&
        attr(name, "font-family") === CARD_FONT_FAMILIES.serif &&
        attr(name, "text-anchor") === "middle");
    const student = textTag(svg, "Mona Hassan");
    check(`student name takes its colour, font and weight (${dir})`,
      attr(student, "fill") === "#00ff00" &&
        attr(student, "font-family") === CARD_FONT_FAMILIES.system &&
        attr(student, "font-weight") === "600");
    check(`the card background colour applies (${dir})`, svg.includes('height="202" rx="12" fill="#0f2a1d"'));
    check(`the footer stripe colour applies (${dir})`, svg.includes('y="196" width="320" height="6" fill="#f59e0b"'));
    check(`the header band draws in the accent colour (${dir})`, svg.includes('<path d="M0 60.6V12a12 12 0 0 1 12-12H308a12 12 0 0 1 12 12V60.6Z" fill="#166534"/>'));
  }
  check("end alignment anchors at the box end in LTR", attr(textTag(styledLtr, "Mona Hassan"), "text-anchor") === "end");
  check("end alignment anchors at the box's left edge in RTL (logical end)", attr(textTag(styledRtl, "Mona Hassan"), "text-anchor") === "start");

  const aligned = (align: string, dir: "ltr" | "rtl") =>
    render(resolveCardLayout({ elements: { studentName: { x: 36, align } } }), dir);
  check("centre alignment centres the text on its box (36% + half of 36% = 172.8)", attr(textTag(aligned("center", "ltr"), "Mona Hassan"), "x") === "172.8");
  check("end alignment in LTR sits at the box end (230.4)", attr(textTag(aligned("end", "ltr"), "Mona Hassan"), "x") === "230.4");
  check("end alignment in RTL sits at the mirrored box's left edge (89.6)", attr(textTag(aligned("end", "rtl"), "Mona Hassan"), "x") === "89.6");
  check("start alignment is the pre-R9 path (explicit 'start' = absent)", aligned("start", "ltr") === render(resolveCardLayout({ elements: { studentName: { x: 36 } } }), "ltr"));

  const noBand = render(resolveCardLayout({ background: "#112233" }), "ltr");
  check("no header band is drawn unless the layout asks for one", !noBand.includes("V12a12"));
  check("without a footer colour the stripe follows the theme colour", noBand.includes('height="6" fill="#2563eb"'));
  check("a blank custom text falls back to the real name",
    render(resolveCardLayout({ elements: { centerName: { text: "" } } }), "ltr", { centerName: "Real Branch" }).includes(">Real Branch</text>"));
  check("custom text is escaped like any other card text",
    render(resolveCardLayout({ elements: { centerName: { text: "<b>&\"" } } }), "ltr").includes("&lt;b&gt;&amp;&quot;") );

  const annotated = render(resolved, "ltr", { annotate: true });
  check("the editor's annotate hook wraps every drawn element in a measurable group",
    ["logo", "centerName", "studentName", "grade", "studentCode", "qr"].every((key) => annotated.includes(`<g data-card-el="${key}">`)));
  check("…and a removed element has no group", !annotated.includes('data-card-el="photo"'));
  check("annotate adds nothing but the wrapper groups (same markup as print)", unwrapAnnotations(annotated) === render(resolved, "ltr"));
  check("print and the stored file never carry the editor hook", !render(resolved, "ltr").includes("data-card-el"));

  const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components")), ...walk(join(ROOT, "lib"))];
  const rel = (path: string) => relative(ROOT, path).replace(/\\/g, "/");
  const codeOf = (file: string) => code(rel(file));
  const definers = files.filter((file) => /function renderIdCardSvg\b/.test(codeOf(file))).map(rel);
  check("exactly one renderIdCardSvg exists (lib/id-card.ts)", definers.length === 1 && definers[0] === "lib/id-card.ts", definers.join(", "));
  const callers = files.filter((file) => /renderIdCardSvg\(/.test(codeOf(file))).map(rel).filter((file) => file !== "lib/id-card.ts").sort();
  check(
    "only the stored/print builder and the editor preview call it — one render path",
    JSON.stringify(callers) === JSON.stringify(["app/[locale]/(center)/settings/card/card-form.tsx", "lib/db/id-cards.ts"]),
    callers.join(", "),
  );
  const markup = /<(svg|rect|text|path|image|linearGradient)\b/;
  const secondRenderers = ["app/[locale]/(center)/settings/card/card-form.tsx", "app/[locale]/(center)/settings/card/card-style-controls.tsx", "components/center/id-card-preview.tsx"].filter((file) => markup.test(code(file)));
  check("no card markup is written outside lib/id-card.ts (no second renderer component)", secondRenderers.length === 0, secondRenderers.join(", "));
  const printers = ["app/[locale]/(print)/students/[id]/card/page.tsx", "app/[locale]/(center)/students/[id]/page.tsx", "app/[locale]/(center)/students/actions.ts"];
  check("print, the detail preview and card generation all go through studentCardSvg", printers.every((file) => /studentCardSvg\(/.test(code(file)) && !/renderIdCardSvg\(/.test(code(file))));

  check("the font list is closed and has the three entries", JSON.stringify(CARD_FONT_FAMILY_KEYS) === JSON.stringify(["cairo", "system", "serif"]));
  check("no monospace/Latin-only family is on the list (Arabic must render)", CARD_FONT_FAMILY_KEYS.every((key) => !/mono|courier/i.test(CARD_FONT_FAMILIES[key])));

  // ── 4. The QR payload ──────────────────────────────────────────────────
  console.log("\n4. QR payload (locked)");
  check("the payload is byte-for-byte the golden string", studentQrPayload(GOLDEN_CENTER_ID, "1001") === GOLDEN_QR_PAYLOAD);
  const parsed = parseStudentQrPayload(GOLDEN_QR_PAYLOAD);
  check("the parser still reads it back", parsed?.centerId === GOLDEN_CENTER_ID && parsed.studentCode === "1001");
  check("a styled card encodes the same QR as an unstyled one (the QR block never changes)",
    (/<path d="(M[^"]*)" fill="#0f172a"/.exec(styledLtr)?.[1] ?? "x") ===
      (/<path d="(M[^"]*)" fill="#0f172a"/.exec(render(builtIn, "ltr"))?.[1] ?? "y"));

  // ── 5. Contrast ────────────────────────────────────────────────────────
  console.log("\n5. Contrast helper");
  check("black on white is 21:1", Math.abs((contrastRatio("#000000", "#ffffff") ?? 0) - 21) < 0.001);
  check("the ratio is symmetric", contrastRatio("#123456", "#fedcba") === contrastRatio("#fedcba", "#123456"));
  check("identical colours are 1:1", contrastRatio("#336699", "#336699") === 1);
  check("#767676 on white just passes AA (4.54)", (contrastRatio("#767676", "#ffffff") ?? 0) >= AA_NORMAL);
  check("#777777 on white just fails AA (4.48)", (contrastRatio("#777777", "#ffffff") ?? 99) < AA_NORMAL);
  check("3-digit hex is read like its 6-digit form", contrastRatio("#000", "#fff") === contrastRatio("#000000", "#ffffff"));
  check("a non-colour yields no ratio, not a crash", contrastRatio("red", "#fff") === null && relativeLuminance("nope") === null);
  check("white has luminance 1, black 0", relativeLuminance("#ffffff") === 1 && relativeLuminance("#000000") === 0);
  check("normal text needs 4.5:1, large text 3:1", requiredContrast(12, 400) === AA_NORMAL && requiredContrast(24, 400) === AA_LARGE && requiredContrast(19, 700) === AA_LARGE && requiredContrast(19, 400) === AA_NORMAL);
  check("normalizeHex lower-cases and expands", normalizeHex("#ABC") === "#aabbcc" && normalizeHex("#A1B2C3") === "#a1b2c3" && normalizeHex("blue") === null && normalizeHex(7) === null);

  check("the built-in card has no contrast warnings", cardContrastIssues(builtIn, "#2563eb").length === 0);
  check("the seeded styled card has no contrast warnings", cardContrastIssues(resolved, "#2563eb").length === 0);
  const poor = resolveCardLayout({ background: "#f8fafc", elements: { studentName: { color: "#ffffff" } } });
  const poorIssues = cardContrastIssues(poor, "#2563eb");
  check("white text on a near-white background warns", poorIssues.some((issue) => issue.key === "studentName" && issue.ratio < issue.required));
  const bandPoor = resolveCardLayout({ headerBand: true, accent: "#fde68a", elements: { centerName: { color: "#f8fafc" } } });
  check("text inside a light header band is judged against the band, not the card", cardContrastIssues(bandPoor, "#2563eb").some((issue) => issue.key === "centerName" && issue.background === "#fde68a"));
  const bandBelow = resolveCardLayout({ headerBand: true, accent: "#fde68a", elements: { studentName: { color: "#ffffff" } } });
  check("text below the band is judged against the card background", !cardContrastIssues(bandBelow, "#2563eb").some((issue) => issue.key === "studentName"));
  check("a warning never blocks saving — the schema accepts the poor pairing", parseLayout({ version: 1, background: "#f8fafc", elements: { studentName: { x: 36, y: 36, color: "#ffffff" } } }).success);

  // ── 6. Users & Roles ───────────────────────────────────────────────────
  console.log("\n6. Users & Roles lists centre staff only");
  const org = await prisma.organization.create({ data: { name: ORG_NAME } });
  const centerA = await prisma.center.create({ data: { slug: SLUG_A, name: "Card Check A", organizationId: org.id } });
  const centerB = await prisma.center.create({ data: { slug: SLUG_B, name: "Card Check B", organizationId: org.id } });

  const owner = await addMember(centerA.id, "OWNER", "owner");
  await addMember(centerA.id, "MANAGER", "manager");
  await addMember(centerA.id, "RECEPTIONIST", "reception");
  await addMember(centerA.id, "ACCOUNTANT", "accountant");
  const teacher = await addMember(centerA.id, "TEACHER", "teacher");
  const teacherElsewhere = await addMember(centerB.id, "TEACHER", "teacher-b");
  const inviteManager = await addInvitation(centerA.id, "MANAGER", "manager");
  const inviteTeacher = await addInvitation(centerA.id, "TEACHER", "teacher");
  await addInvitation(centerB.id, "MANAGER", "manager-b");

  const staffRows = await prisma.membership.findMany({ where: scopedWhere(centerA.id, staffMembershipFilter()) });
  check("the staff membership query returns the four staff roles", staffRows.length === 4 && staffRows.every((row) => (CENTER_STAFF_ROLES as readonly string[]).includes(row.role)));
  check("…and no TEACHER membership", !staffRows.some((row) => row.id === teacher.id || row.role === "TEACHER"));
  const staffOnlyActive = await prisma.membership.findMany({ where: scopedWhere(centerA.id, staffMembershipFilter({ active: true })) });
  check("the filter composes with extra conditions without losing the role pin", staffOnlyActive.every((row) => row.role !== "TEACHER"));
  check("…and stays centre-scoped (the other centre's teacher is not there either)", !staffRows.some((row) => row.id === teacherElsewhere.id));
  const staffInvites = await prisma.invitation.findMany({ where: scopedWhere(centerA.id, staffInvitationFilter({ status: "PENDING" })) });
  check("the staff invitation query lists the pending staff invitation", staffInvites.some((row) => row.id === inviteManager.id));
  check("…and no TEACHER invitation", !staffInvites.some((row) => row.id === inviteTeacher.id || row.role === "TEACHER"));
  const teacherRowsStill = await prisma.membership.count({ where: scopedWhere(centerA.id, { role: "TEACHER" as Role }) });
  const teacherInvitesStill = await prisma.invitation.count({ where: scopedWhere(centerA.id, { role: "TEACHER" as Role, status: "PENDING" as const }) });
  check("existing TEACHER memberships and invitations are untouched (still stored, just not listed here)", teacherRowsStill === 1 && teacherInvitesStill === 1);
  check("the owner row is still listed", staffRows.some((row) => row.id === owner.id));

  const scopedSource = source("lib/db/scoped.ts");
  check("the scoped staff helpers apply those exact filters", /listStaffWithUser[\s\S]{0,260}staffMembershipFilter\(/.test(scopedSource) && /listStaff:[\s\S]{0,260}staffInvitationFilter\(/.test(scopedSource));
  check("the old unfiltered listWithUser helper is gone", !/listWithUser\b/.test(scopedSource) && !walk(join(ROOT, "app")).some((file) => /\.memberships\.listWithUser\b/.test(readFileSync(file, "utf8"))));
  const staffPage = source("app/[locale]/(center)/settings/staff/page.tsx");
  check("the Users & Roles page reads only the staff helpers", /memberships\.listStaffWithUser\(/.test(staffPage) && /invitations\.listStaff\(/.test(staffPage) && !/invitations\.list\(/.test(staffPage));

  console.log("\n   TEACHER is refused by direct call");
  const invite = (role: string) => createInvitationSchema.safeParse({ email: "x@example.test", role, locale: "en" });
  const changeRole = (role: string) => memberRoleSchema.safeParse({ membershipId: "m1", role, locale: "en" });
  for (const role of ASSIGNABLE_STAFF_ROLES) {
    check(`an invitation for ${role} is accepted`, invite(role).success);
    check(`a role change to ${role} is accepted`, changeRole(role).success);
  }
  const inviteTeacherResult = invite("TEACHER");
  const roleTeacherResult = changeRole("TEACHER");
  check("an invitation for TEACHER is refused, with the Teachers-page message", !inviteTeacherResult.success && inviteTeacherResult.error.issues[0]?.message === "teacherViaTeachersPage");
  check("a role change to TEACHER is refused, with the Teachers-page message", !roleTeacherResult.success && roleTeacherResult.error.issues[0]?.message === "teacherViaTeachersPage");
  check("an unknown role is refused too", !invite("PLATFORM_ADMIN").success && !changeRole("STUDENT").success);
  check("the assignable roles are exactly the centre-staff roles", JSON.stringify([...ASSIGNABLE_STAFF_ROLES].sort()) === JSON.stringify([...CENTER_STAFF_ROLES].sort()));

  const actions = source("app/[locale]/(center)/settings/staff/actions.ts");
  const memberActions = source("app/[locale]/(center)/settings/staff/member-actions.ts");
  check("createInvitationAction parses with the staff-only schema", /createInvitationSchema\.safeParse\(/.test(actions));
  check("changeMemberRoleAction parses with the staff-only schema", /memberRoleSchema\.safeParse\(/.test(memberActions));
  check("an existing TEACHER membership cannot be re-roled or deactivated through these actions", (memberActions.match(/membership\.role === "TEACHER"\) return TEACHER_ELSEWHERE/g) ?? []).length === 2);
  check("the invite dropdown does not offer TEACHER", !/"TEACHER"/.test(source("app/[locale]/(center)/settings/staff/invite-form.tsx")));
  check("the role-change dropdown does not offer TEACHER", !/"TEACHER"/.test(source("app/[locale]/(center)/settings/staff/member-row.tsx")));

  console.log("\n   The permissions matrix keeps its TEACHER column");
  check("MATRIX_ROLES still lists TEACHER", (MATRIX_ROLES as readonly string[]).includes("TEACHER"));
  check("TEACHER still has editable actions in the matrix", editableActionsFor("TEACHER").length > 0);
  const matrixPage = source("app/[locale]/(center)/settings/permissions/page.tsx");
  check("the permissions screen is built from MATRIX_ROLES (not the staff list)", /MATRIX_ROLES/.test(matrixPage) && !/CENTER_STAFF_ROLES|ASSIGNABLE_STAFF_ROLES/.test(matrixPage));

  // ── 7. The seed ────────────────────────────────────────────────────────
  console.log("\n7. Center 60 seed");
  const seed = source("prisma/seed.ts");
  const literal = /const NASR_CITY_CARD_LAYOUT = (\{[\s\S]*?\n\});/.exec(seed)?.[1];
  check("the seed defines a styled card layout for one branch", Boolean(literal) && /cardLayout: NASR_CITY_CARD_LAYOUT/.test(seed));
  if (literal) {
    const seeded = new Function(`return (${literal});`)();
    check("…which passes the real schema", cardLayoutDocumentSchema.safeParse(seeded).success);
    const layout = resolveCardLayout(seeded);
    check(
      "…and exercises colours, a header band and the custom branch text",
      Boolean(layout.accent && layout.footer && layout.headerBand && layout.background.startsWith("#") && layout.elements.centerName.text),
    );
    check("…with no contrast warnings", cardContrastIssues(layout, "#2563eb").length === 0);
  }
  check("the seed validates the layout and never overwrites an existing one", /cardLayoutDocumentSchema\.parse\(/.test(seed) && /settings\.cardLayout === null/.test(seed));
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} card-layout check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll card-layout checks passed.");
  });
