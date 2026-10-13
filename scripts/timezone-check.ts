/**
 * Timezone check — the R7b acceptance gate: "Today" is the **centre's**
 * calendar day everywhere, never the UTC day (docs/02-architecture.md §11
 * "One owner of today", docs/00-master-product-spec.md §5.1).
 *
 * Run with:  npm run check:timezone
 *
 * Pure — no database. `lib/scheduling.ts`'s `todayInTimezone` is the single
 * owner of "today"; every other module derives its day from it. This gate:
 *
 *   1. Pins the helper at the midnight boundary — 00:30 and 23:30 Cairo, under
 *      BOTH offsets (+03:00 summer, +02:00 winter) — and either side of the
 *      exact midnight, plus the first-of-month rollover, plus a second centre
 *      on a different timezone (east and west of Cairo) resolving its own day.
 *   2. Pins the shared date filter's Day / Week (trailing) / Month
 *      (month-to-date) presets and its defaults on the centre's day.
 *   3. Pins the data-visibility floor (M19) on the centre's day.
 *   4. Pins the cross-centre rules: the teacher dashboard's per-centre
 *      anchors, the student rating pop-up's per-centre 7-day window, and the
 *      one documented combined-value rule (`commonTimeZone`).
 *   5. Statically asserts no file outside `lib/scheduling.ts` derives a
 *      calendar day from UTC (`toISOString().slice(0, 10)`-style,
 *      `setUTCHours`, `startOfUtcDay(now)`) or hand-rolls a second "today".
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { attendedSessionsToRate } from "../lib/db/ratings.ts";
import { teacherDashboardAnchors } from "../lib/db/teacher-portal.ts";
import { clampRangeToVisibility, visibilityWindowFloor } from "../lib/db/visibility.ts";
import {
  DEFAULT_TIMEZONE,
  centreTimeZone,
  commonTimeZone,
  dateKey,
  deviceTodayKey,
  resolveSharedDateFilter,
  startOfSessionDay,
  startOfUtcDay,
  todayInTimezone,
  zonedClock,
  type SharedDateFilterInput,
} from "../lib/scheduling.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const CAIRO = "Africa/Cairo";
const DUBAI = "Asia/Dubai"; // UTC+4, no DST — east of Cairo
const NEW_YORK = "America/New_York"; // UTC−4 in July, UTC−5 in January — west of Cairo

const at = (iso: string) => new Date(iso);
const key = (date: Date) => dateKey(date);

// ── 1. The helper at the midnight boundary ─────────────────────────────────

function checkHelperBoundary() {
  console.log("1. todayInTimezone — the centre's calendar day");

  // Cairo is +03:00 in July (DST) and +02:00 in January. The instants below
  // are written as literal UTC so the offset is *asserted*, not re-derived
  // from the code under test.
  const scenarios = [
    {
      label: "summer +03:00",
      // 00:30 Cairo on 15 Jul = 21:30 UTC on 14 Jul.
      early: at("2026-07-14T21:30:00.000Z"),
      // 23:30 Cairo on 15 Jul = 20:30 UTC on 15 Jul.
      late: at("2026-07-15T20:30:00.000Z"),
      lastMs: at("2026-07-15T20:59:59.999Z"),
      midnight: at("2026-07-15T21:00:00.000Z"),
      day: "2026-07-15",
      next: "2026-07-16",
    },
    {
      label: "winter +02:00",
      // 00:30 Cairo on 15 Jan = 22:30 UTC on 14 Jan.
      early: at("2026-01-14T22:30:00.000Z"),
      // 23:30 Cairo on 15 Jan = 21:30 UTC on 15 Jan.
      late: at("2026-01-15T21:30:00.000Z"),
      lastMs: at("2026-01-15T21:59:59.999Z"),
      midnight: at("2026-01-15T22:00:00.000Z"),
      day: "2026-01-15",
      next: "2026-01-16",
    },
  ];

  for (const s of scenarios) {
    check(
      `${s.label}: at 00:30 Cairo, today is ${s.day} (not the UTC day before it)`,
      key(todayInTimezone(CAIRO, s.early)) === s.day,
      key(todayInTimezone(CAIRO, s.early)),
    );
    check(
      `${s.label}: the UTC-day derivation this replaces is wrong at 00:30 (documents the bug)`,
      key(startOfUtcDay(s.early)) !== s.day,
    );
    check(
      `${s.label}: at 23:30 Cairo, today is still ${s.day} (not tomorrow)`,
      key(todayInTimezone(CAIRO, s.late)) === s.day,
      key(todayInTimezone(CAIRO, s.late)),
    );
    check(
      `${s.label}: the last millisecond of the day is still ${s.day}`,
      key(todayInTimezone(CAIRO, s.lastMs)) === s.day,
    );
    check(
      `${s.label}: exactly local midnight flips to ${s.next}`,
      key(todayInTimezone(CAIRO, s.midnight)) === s.next,
    );
    check(
      `${s.label}: the result is a UTC-midnight day marker (Session.date's shape)`,
      todayInTimezone(CAIRO, s.early).getTime() === startOfUtcDay(todayInTimezone(CAIRO, s.early)).getTime(),
    );
  }

  // The offset follows the IANA data: it changes across the late-October DST
  // end, with no hard-coded constant anywhere.
  check(
    "DST end: 00:30 Cairo on 28 Oct (+03:00) and on 30 Oct (+02:00) are each their own local date",
    key(todayInTimezone(CAIRO, at("2026-10-27T21:30:00.000Z"))) === "2026-10-28" &&
      key(todayInTimezone(CAIRO, at("2026-10-29T22:30:00.000Z"))) === "2026-10-30",
  );

  // Month rollover: 00:30 on 1 Aug in Cairo is still 31 Jul in UTC.
  check(
    "First of the month: 00:30 Cairo on 1 Aug is 1 Aug (UTC would still say 31 Jul)",
    key(todayInTimezone(CAIRO, at("2026-07-31T21:30:00.000Z"))) === "2026-08-01",
  );

  // A second centre on a different timezone resolves its own day.
  const instant = at("2026-07-15T20:30:00.000Z"); // 23:30 Cairo
  check(
    "Second centre (Asia/Dubai, +04:00): the same instant is already 16 Jul 00:30 there",
    key(todayInTimezone(DUBAI, instant)) === "2026-07-16" && key(todayInTimezone(CAIRO, instant)) === "2026-07-15",
  );
  const earlyUtc = at("2026-07-15T03:30:00.000Z"); // 06:30 Cairo, 23:30 the day before in New York
  check(
    "Second centre west of Cairo (America/New_York, −04:00): the same instant is still 14 Jul there",
    key(todayInTimezone(NEW_YORK, earlyUtc)) === "2026-07-14" && key(todayInTimezone(CAIRO, earlyUtc)) === "2026-07-15",
  );
  check(
    "The default `now` is the real clock (a day marker is returned with no argument)",
    !Number.isNaN(todayInTimezone(CAIRO).getTime()),
  );

  // Unknown free-text timezone falls back to Cairo, never throws.
  check(
    "centreTimeZone: an unknown IANA name falls back to the default; null settings too",
    centreTimeZone({ timezone: "Mars/Olympus" }) === DEFAULT_TIMEZONE &&
      centreTimeZone(null) === DEFAULT_TIMEZONE &&
      centreTimeZone({ timezone: DUBAI }) === DUBAI,
  );
  check(
    "todayInTimezone with an unknown zone resolves in the default zone instead of throwing",
    key(todayInTimezone("Mars/Olympus", scenarios[0].early)) === scenarios[0].day,
  );
  check(
    "zonedClock (minute clock) and todayInTimezone agree on the day",
    zonedClock(scenarios[0].early, CAIRO).dayKey === key(todayInTimezone(CAIRO, scenarios[0].early)),
  );

  // The teacher edit deadline counts from the centre's start of day.
  check(
    "startOfSessionDay: a 15 Jul session's day begins 21:00 UTC on 14 Jul (+03:00) and 22:00 UTC on 14 Jan (+02:00)",
    startOfSessionDay(at("2026-07-15T00:00:00.000Z"), CAIRO).toISOString() === "2026-07-14T21:00:00.000Z" &&
      startOfSessionDay(at("2026-01-15T00:00:00.000Z"), CAIRO).toISOString() === "2026-01-14T22:00:00.000Z",
  );

  check(
    "deviceTodayKey (cosmetic picker fallback) returns a YYYY-MM-DD key",
    /^\d{4}-\d{2}-\d{2}$/.test(deviceTodayKey()),
  );
}

// ── 2. The shared date filter ───────────────────────────────────────────────

function checkSharedFilter() {
  console.log("\n2. resolveSharedDateFilter — presets anchored on the centre's day");

  const input = (kind: SharedDateFilterInput["kind"], extra: Partial<SharedDateFilterInput> = {}): SharedDateFilterInput => ({
    kind,
    date: null,
    from: null,
    to: null,
    ...extra,
  });
  const span = (r: { start: Date; end: Date }) => `${key(r.start)}..${key(r.end)}`;

  for (const [label, instant] of [
    ["00:30 Cairo (summer)", at("2026-07-14T21:30:00.000Z")],
    ["23:30 Cairo (summer)", at("2026-07-15T20:30:00.000Z")],
    ["00:30 Cairo (winter)", at("2026-01-14T22:30:00.000Z")],
    ["23:30 Cairo (winter)", at("2026-01-15T21:30:00.000Z")],
  ] as const) {
    const day = key(todayInTimezone(CAIRO, instant));
    const monthStart = `${day.slice(0, 8)}01`;
    const weekStart = key(new Date(todayInTimezone(CAIRO, instant).getTime() - 7 * 86_400_000));
    check(`${label}: Day = ${day}..${day}`, span(resolveSharedDateFilter(input("day"), CAIRO, instant)) === `${day}..${day}`);
    check(
      `${label}: Week (trailing) = ${weekStart}..${day}`,
      span(resolveSharedDateFilter(input("week"), CAIRO, instant)) === `${weekStart}..${day}`,
      span(resolveSharedDateFilter(input("week"), CAIRO, instant)),
    );
    check(
      `${label}: Month (month-to-date) = ${monthStart}..${day}`,
      span(resolveSharedDateFilter(input("month"), CAIRO, instant)) === `${monthStart}..${day}`,
      span(resolveSharedDateFilter(input("month"), CAIRO, instant)),
    );
  }

  const rollover = at("2026-07-31T21:30:00.000Z"); // 00:30 Cairo, 1 Aug
  check(
    "00:30 Cairo on 1 Aug: Month = 2026-08-01..2026-08-01 (UTC would still be July 1..31)",
    span(resolveSharedDateFilter(input("month"), CAIRO, rollover)) === "2026-08-01..2026-08-01",
    span(resolveSharedDateFilter(input("month"), CAIRO, rollover)),
  );

  check(
    "A specific date is taken as picked; a range is normalised — neither moves with the clock",
    span(resolveSharedDateFilter(input("date", { date: at("2026-03-04T00:00:00.000Z") }), CAIRO, rollover)) ===
      "2026-03-04..2026-03-04" &&
      span(
        resolveSharedDateFilter(
          input("range", { from: at("2026-03-09T00:00:00.000Z"), to: at("2026-03-02T00:00:00.000Z") }),
          CAIRO,
          rollover,
        ),
      ) === "2026-03-02..2026-03-09",
  );
  check(
    "A date/range pick with its bounds missing defaults to the centre's day",
    span(resolveSharedDateFilter(input("date"), CAIRO, rollover)) === "2026-08-01..2026-08-01" &&
      span(resolveSharedDateFilter(input("range"), CAIRO, rollover)) === "2026-08-01..2026-08-01",
  );

  const instant = at("2026-07-15T20:30:00.000Z"); // 23:30 Cairo = 00:30 16 Jul Dubai
  check(
    "Second centre: the same instant yields each centre's own Day — Cairo 15 Jul, Dubai 16 Jul",
    span(resolveSharedDateFilter(input("day"), CAIRO, instant)) === "2026-07-15..2026-07-15" &&
      span(resolveSharedDateFilter(input("day"), DUBAI, instant)) === "2026-07-16..2026-07-16",
  );
  check(
    "Second centre: Month-to-date follows the other zone's month boundary too",
    span(resolveSharedDateFilter(input("month"), DUBAI, at("2026-07-31T20:30:00.000Z"))) === "2026-08-01..2026-08-01" &&
      span(resolveSharedDateFilter(input("month"), CAIRO, at("2026-07-31T20:30:00.000Z"))) === "2026-07-01..2026-07-31",
  );
}

// ── 3. The visibility floor ─────────────────────────────────────────────────

function checkVisibilityFloor() {
  console.log("\n3. visibilityWindowFloor — anchored on the centre's day");

  const cairo30 = { isPlatformAdmin: false, settings: { dataVisibilityDays: 30, timezone: CAIRO } };
  const early = at("2026-07-14T21:30:00.000Z"); // 00:30 Cairo, 15 Jul
  const late = at("2026-07-15T20:30:00.000Z"); // 23:30 Cairo, 15 Jul

  check(
    "00:30 Cairo on 15 Jul: the 30-day floor is 15 Jun (the UTC-anchored floor was 14 Jun — a day too old)",
    key(visibilityWindowFloor(cairo30, early) as Date) === "2026-06-15",
    key(visibilityWindowFloor(cairo30, early) as Date),
  );
  check(
    "23:30 Cairo on 15 Jul: the floor is still 15 Jun (same Cairo day, same floor)",
    key(visibilityWindowFloor(cairo30, late) as Date) === "2026-06-15",
  );
  check(
    "The floor flips at the centre's midnight, not UTC's",
    key(visibilityWindowFloor(cairo30, at("2026-07-15T20:59:59.999Z")) as Date) === "2026-06-15" &&
      key(visibilityWindowFloor(cairo30, at("2026-07-15T21:00:00.000Z")) as Date) === "2026-06-16",
  );
  check(
    "Winter (+02:00): 00:30 Cairo on 15 Jan → floor 16 Dec",
    key(visibilityWindowFloor(cairo30, at("2026-01-14T22:30:00.000Z")) as Date) === "2025-12-16",
  );
  check(
    "A second centre on another timezone gets its own floor from the same instant",
    key(visibilityWindowFloor({ isPlatformAdmin: false, settings: { dataVisibilityDays: 30, timezone: DUBAI } }, late) as Date) ===
      "2026-06-16",
  );
  check(
    "A centre with no CenterSettings row falls back to the default zone (and the 30-day window)",
    key(visibilityWindowFloor({ isPlatformAdmin: false, settings: null }, early) as Date) === "2026-06-15",
  );
  check(
    "Platform admin still bypasses the window",
    visibilityWindowFloor({ isPlatformAdmin: true, settings: cairo30.settings }, early) === null,
  );

  const floor = visibilityWindowFloor(cairo30, early) as Date;
  const clamped = clampRangeToVisibility({ start: at("2020-01-01T00:00:00.000Z"), end: todayInTimezone(CAIRO, early) }, floor);
  check(
    "clampRangeToVisibility raises a too-old range to the centre-day floor and leaves the end alone",
    key(clamped.start) === "2026-06-15" && key(clamped.end) === "2026-07-15",
  );
  const range = clampRangeToVisibility(
    resolveSharedDateFilter({ kind: "month", date: null, from: null, to: null }, CAIRO, early),
    floor,
  );
  check(
    "Filter + floor compose on the same day: month-to-date at 00:30 Cairo on 15 Jul is 1..15 Jul, inside the window",
    `${key(range.start)}..${key(range.end)}` === "2026-07-01..2026-07-15",
  );
}

// ── 4. Cross-centre views ───────────────────────────────────────────────────

function checkCrossCentre() {
  console.log("\n4. Cross-centre views — each centre's own day, never one global day");

  // The teacher dashboard: Cairo and Dubai centres, 23:30 Cairo on Wed 15 Jul 2026.
  const instant = at("2026-07-15T20:30:00.000Z");
  const cairo = teacherDashboardAnchors(CAIRO, instant);
  const dubai = teacherDashboardAnchors(DUBAI, instant);
  check(
    "Teacher dashboard: each centre gets its own 'today' (Cairo 15 Jul, Dubai 16 Jul)",
    key(cairo.today) === "2026-07-15" && key(dubai.today) === "2026-07-16",
  );
  // 15 Jul 2026 is a Wednesday → Sunday-start week 12..18 Jul; 16 Jul (Thu) → same week.
  check(
    "Teacher dashboard: the calendar week is anchored on that centre's day (Sunday-start)",
    `${key(cairo.week.start)}..${key(cairo.week.end)}` === "2026-07-12..2026-07-18",
  );
  const monthEdge = at("2026-07-31T20:30:00.000Z"); // 23:30 Cairo on 31 Jul = 00:30 1 Aug Dubai
  const cairoEdge = teacherDashboardAnchors(CAIRO, monthEdge);
  const dubaiEdge = teacherDashboardAnchors(DUBAI, monthEdge);
  check(
    "Teacher dashboard: at a month boundary the two centres sit in different calendar months",
    `${key(cairoEdge.month.start)}..${key(cairoEdge.month.end)}` === "2026-07-01..2026-07-31" &&
      `${key(dubaiEdge.month.start)}..${key(dubaiEdge.month.end)}` === "2026-08-01..2026-08-31",
  );
  const early = teacherDashboardAnchors(CAIRO, at("2026-07-14T21:30:00.000Z"));
  const late = teacherDashboardAnchors(CAIRO, at("2026-07-15T20:30:00.000Z"));
  check(
    "Teacher dashboard: 00:30 and 23:30 Cairo agree on today, week and month",
    key(early.today) === key(late.today) &&
      key(early.week.start) === key(late.week.start) &&
      key(early.month.start) === key(late.month.start),
  );

  // The one documented combined-value rule.
  check(
    "commonTimeZone: centres that share a zone use it; a mix (or none) uses the platform default",
    commonTimeZone([DUBAI, DUBAI]) === DUBAI &&
      commonTimeZone([CAIRO, DUBAI]) === DEFAULT_TIMEZONE &&
      commonTimeZone([]) === DEFAULT_TIMEZONE &&
      commonTimeZone(["Mars/Olympus", CAIRO]) === CAIRO,
  );
}

async function checkRatingWindow() {
  console.log("\n5. Student rating pop-up — the 7-day window is per centre");

  // `attendedSessionsToRate` only needs these three reads; the database's own
  // coarse date bound is irrelevant here because the per-centre window is
  // applied in memory, which is exactly what is under test.
  type Row = Record<string, unknown>;
  function makeDb(rows: Row[]) {
    return {
      sessionAttendee: { findMany: async () => rows },
      sessionRating: { findMany: async () => [] },
      sessionRatingSkip: { findMany: async () => [] },
    } as unknown as Parameters<typeof attendedSessionsToRate>[0];
  }
  const row = (id: string, centerId: string, date: string, timezone: string | null): Row => ({
    sessionId: id,
    session: {
      id,
      centerId,
      teacherId: "teacher",
      date: at(`${date}T00:00:00.000Z`),
      title: null,
      subjectId: null,
      gradeId: null,
      classGroup: { subjectId: null, gradeId: null },
      center: { settings: timezone ? { timezone } : null },
    },
  });
  const pending = async (rows: Row[], now: Date) =>
    (await attendedSessionsToRate(makeDb(rows), "student", now)).map((entry) => entry.sessionId).sort();

  // 00:30 Cairo on 15 Jul 2026 — 21:30 UTC on 14 Jul.
  const early = at("2026-07-14T21:30:00.000Z");
  const cairoRows = [
    row("today", "c1", "2026-07-15", CAIRO),
    row("six-back", "c1", "2026-07-09", CAIRO),
    row("seven-back", "c1", "2026-07-08", CAIRO),
    row("tomorrow", "c1", "2026-07-16", CAIRO),
  ];
  check(
    "At 00:30 Cairo, a session dated today is in the window (the UTC clock excluded it); 6 days back is in, 7 and tomorrow are out",
    JSON.stringify(await pending(cairoRows, early)) === JSON.stringify(["six-back", "today"]),
    JSON.stringify(await pending(cairoRows, early)),
  );
  const late = at("2026-07-15T20:30:00.000Z");
  check(
    "At 23:30 Cairo the same Cairo day gives the same window",
    JSON.stringify(await pending(cairoRows, late)) === JSON.stringify(["six-back", "today"]),
  );

  // Two centres in different zones, one instant: each row is held to its own centre's day.
  const mixed = [
    row("cairo-15", "c1", "2026-07-15", CAIRO),
    row("ny-15", "c2", "2026-07-15", NEW_YORK),
    row("ny-14", "c2", "2026-07-14", NEW_YORK),
    row("no-settings-15", "c3", "2026-07-15", null),
  ];
  check(
    "Cross-centre: at 00:30 Cairo, a 15 Jul session counts in Cairo (and a centre with no settings), not in New York (still 14 Jul there)",
    JSON.stringify(await pending(mixed, early)) === JSON.stringify(["cairo-15", "no-settings-15", "ny-14"]),
    JSON.stringify(await pending(mixed, early)),
  );
}

// ── 6. Static: no second derivation of a calendar day from UTC ─────────────

/**
 * The only file allowed to derive a day from the clock, and why. Anything
 * added here needs a justification the sweep can defend — the whole point of
 * R7b is that this list stays at one.
 */
const ALLOWLIST: Record<string, string> = {
  "lib/scheduling.ts":
    "The one helper: `todayInTimezone` and its `dateKey`/`startOfUtcDay` marker primitives live here.",
};

const SCAN_DIRS = ["app", "lib", "components", "prisma"];
const EXCLUDED = ["node_modules", ".next", "prisma/migrations"];

/** [rule name, pattern] — each is a way of deriving (or re-deriving) a calendar day from the UTC clock. */
const FORBIDDEN: { name: string; regex: RegExp }[] = [
  {
    name: "toISOString().slice/substring/split — a UTC calendar-day string (use dateKey / todayInTimezone)",
    regex: /toISOString\(\)\s*\.\s*(?:slice|substring|substr|split)\s*\(/,
  },
  { name: "setUTCHours — UTC day arithmetic on a clock value", regex: /\bsetUTCHours\s*\(/ },
  {
    name: "startOfUtcDay(now / new Date()) — the UTC-day 'today' (use todayInTimezone)",
    regex: /\bstartOfUtcDay\(\s*(?:new Date\(|now\b|options\.now|params\.now)/,
  },
  {
    name: "a hand-rolled 'today' marker from the zoned day key (use todayInTimezone)",
    regex: /\$\{[^}]*dayKey\}T00:00:00|dayMarker\(\s*zonedClock/,
  },
  { name: "Date.now()/new Date() fed straight into Date.UTC day maths", regex: /Date\.UTC\([^)]*new Date\(\)/ },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).replace(/\\/g, "/");
    if (EXCLUDED.some((segment) => rel.includes(segment))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Drops block comments and whole-line `//` comments, so documentation may name the forbidden forms. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

function checkStaticSweep() {
  console.log("\n6. Static sweep — no calendar day derived from UTC outside the helper");

  check(
    "The allowlist is exactly the one helper file",
    Object.keys(ALLOWLIST).length === 1 && "lib/scheduling.ts" in ALLOWLIST,
  );

  // The rules must actually bite: each known-bad shape is caught, each
  // sanctioned shape is not.
  const caught = (snippet: string) => FORBIDDEN.some((rule) => rule.regex.test(snippet));
  check(
    "The sweep's rules catch every UTC-today shape the sweep removed",
    [
      "const d = new Date().toISOString().slice(0, 10);",
      "const d = startOfUtcDay(now).toISOString().slice(0, 10);",
      'const d = date.toISOString().split("T")[0];',
      "deadline.setUTCHours(0, 0, 0, 0);",
      "const today = startOfUtcDay(new Date());",
      "const today = startOfUtcDay(now);",
      "const today = new Date(`${zonedClock(now, tz).dayKey}T00:00:00.000Z`);",
      "const today = dayMarker(zonedClock(now, tz).dayKey);",
    ].every(caught),
  );
  check(
    "The sweep's rules leave the sanctioned shapes alone (day markers, dateKey, todayInTimezone)",
    ![
      "const key = dateKey(session.date);",
      "const today = todayInTimezone(timeZone, now);",
      "const normalised = startOfUtcDay(next.date);",
      "const marker = dayMarker(value.date);",
      "const d = new Date(`${value}T00:00:00.000Z`);",
    ].some(caught),
  );

  const files = SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir)));
  check("The sweep actually scanned the app (sanity: more than 100 source files)", files.length > 100, String(files.length));

  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel in ALLOWLIST) continue;
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      for (const rule of FORBIDDEN) {
        if (rule.regex.test(line)) offenders.push(`${rel}:${index + 1} — ${rule.name}`);
      }
    });
  }
  check(
    "No file outside lib/scheduling.ts uses a UTC-derived 'today' pattern",
    offenders.length === 0,
    `\n      ${offenders.join("\n      ")}`,
  );

  // Positive: the call sites the sweep changed really do resolve through the helper.
  const mustUseHelper: Record<string, RegExp> = {
    "app/[locale]/(center)/dashboard/page.tsx": /todayInTimezone\(/,
    "app/[locale]/(center)/sessions/page.tsx": /todayInTimezone\(/,
    "app/[locale]/(center)/analytics/page.tsx": /todayInTimezone\(/,
    "app/[locale]/(center)/expenses/page.tsx": /todayInTimezone\(/,
    "app/[locale]/(teacher)/teacher/dashboard/page.tsx": /teacherDashboardAnchors\(/,
    "app/[locale]/(teacher)/teacher/sessions/page.tsx": /todayInTimezone\(/,
    "app/[locale]/(student)/student/schedule/page.tsx": /todayInTimezone\(/,
    "app/[locale]/(parent)/parent/page.tsx": /todayInTimezone\(/,
    "app/[locale]/(center)/students/[id]/page.tsx": /todayInTimezone\(/,
    "lib/db/reception.ts": /todayInTimezone\(/,
    "lib/db/visibility.ts": /todayInTimezone\(/,
    "lib/db/ratings.ts": /todayInTimezone\(/,
    "lib/db/session-lifecycle.ts": /todayInTimezone\(/,
    "lib/db/settlements.ts": /todayInTimezone\(/,
    "lib/db/room-sets.ts": /todayInTimezone\(/,
    "lib/db/class-sessions.ts": /todayInTimezone\(/,
  };
  for (const [rel, pattern] of Object.entries(mustUseHelper)) {
    check(`${rel} resolves its day through the helper`, pattern.test(readFileSync(join(ROOT, rel), "utf8")));
  }

  // Positive: every page that applies the shared date filter hands it the centre's zone.
  for (const rel of [
    "app/[locale]/(center)/sessions/page.tsx",
    "app/[locale]/(center)/analytics/page.tsx",
    "app/[locale]/(center)/expenses/page.tsx",
  ]) {
    const source = readFileSync(join(ROOT, rel), "utf8");
    check(
      `${rel} passes the centre's timezone to resolveSharedDateFilter and the floor`,
      /resolveSharedDateFilter\(toSharedDateFilterInput\(filters\),\s*timeZone,\s*now\)/.test(source) &&
        /visibilityWindowFloor\(ctx,\s*now\)/.test(source),
    );
  }

  // The analytics roll-up shares one range across branches — the documented rule is the active branch's zone.
  const analytics = readFileSync(join(ROOT, "app/[locale]/(center)/analytics/page.tsx"), "utf8");
  check(
    "Analytics roll-up: the one combined range is resolved against the active branch's zone (documented rule)",
    /const timeZone = centreTimeZone\(ctx\.settings\)/.test(analytics),
  );
  // The teacher dashboard must not hold a page-level 'today' shared by every centre.
  const teacherDashboard = readFileSync(join(ROOT, "app/[locale]/(teacher)/teacher/dashboard/page.tsx"), "utf8");
  check(
    "Teacher dashboard: no page-level `today` shared across centres — anchors are computed inside the per-centre map",
    !/^\s*const today\b/m.test(teacherDashboard) && /contexts\.map\([\s\S]*teacherDashboardAnchors\(/.test(teacherDashboard),
  );
}

async function main() {
  checkHelperBoundary();
  checkSharedFilter();
  checkVisibilityFloor();
  checkCrossCentre();
  await checkRatingWindow();
  checkStaticSweep();

  if (failures > 0) {
    console.error(`\n${failures} timezone check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll timezone checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
