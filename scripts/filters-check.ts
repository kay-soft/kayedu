/**
 * Filter-parsing check — the gate for "a filter bar round-trips what the user
 * actually picked".
 *
 * This exists because of a real defect that shipped: the Sessions tab's
 * `status` filter was `z.enum([...]).optional()`, but a dropdown's "All"
 * option submits an **empty string**, not nothing. So with Status on "All" —
 * its default — the whole filter object failed to parse, and the page's
 * `safeParse` fallback then replaced *every* filter with its default,
 * including the date range the user had just chosen. The visible symptom was
 * "picking a date range snaps back to today", which points at the date
 * filter; the cause was three fields away.
 *
 * The two rules asserted here follow directly from that:
 *
 *   1. **Every filter schema parses the exact payload its own form submits**,
 *      with every optional control left on its empty default. A filter bar
 *      that cannot parse its own untouched state is broken by construction.
 *   2. **A genuinely invalid value is still rejected** — leniency about `""`
 *      must not become leniency about anything.
 *
 * Pure static analysis of the schemas — no database, no Next.js runtime.
 *
 * Run with:  npm run check:filters
 */
import { analyticsFilterSchema, expenseFilterSchema } from "../lib/validation/analytics.ts";
import { classListFilterSchema } from "../lib/validation/classes.ts";
import { dateFilterSchema } from "../lib/validation/date-filter.ts";
import { sessionListFilterSchema } from "../lib/validation/sessions.ts";
import { teacherSessionListFilterSchema } from "../lib/validation/teacher.ts";

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Schema = { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } };

/** What a `<form>` posts: every control present, the untouched ones empty. */
function parses(name: string, schema: Schema, payload: Record<string, string>) {
  const result = schema.safeParse(payload);
  check(
    name,
    result.success,
    result.success ? "" : JSON.stringify(result.error),
  );
  return result;
}

// ── 1. Each filter bar parses its own untouched submission ────────────────

console.log("Every filter bar parses its own form's untouched submission");

// The shared date filter writes all four of its fields on every submit, and
// three of them are empty whenever a quick preset is the active selection.
for (const range of ["day", "week", "month"]) {
  parses(
    `Shared date filter: "${range}" preset (date/from/to all empty)`,
    dateFilterSchema,
    { range, date: "", from: "", to: "" },
  );
}
parses("Shared date filter: a specific date", dateFilterSchema, {
  range: "date",
  date: "2026-09-03",
  from: "",
  to: "",
});
parses("Shared date filter: a custom range", dateFilterSchema, {
  range: "range",
  date: "",
  from: "2026-09-01",
  to: "2026-09-06",
});

// The regression itself: a range picked while every sibling filter sits on
// "All". This is the exact payload that used to fail.
const sessionsRange = parses(
  "Sessions: a custom range with every other filter on All",
  sessionListFilterSchema,
  {
    range: "range",
    date: "",
    from: "2026-09-01",
    to: "2026-09-06",
    teacherId: "",
    subjectId: "",
    classGroupId: "",
    status: "",
  },
);
if (sessionsRange.success) {
  const data = sessionsRange.data as { range: string; from: string | null; to: string | null };
  check(
    "Sessions: that range survives parsing instead of falling back to today",
    data.range === "range" && data.from === "2026-09-01" && data.to === "2026-09-06",
    JSON.stringify(data),
  );
}

parses("Sessions: a specific date with every other filter on All", sessionListFilterSchema, {
  range: "date",
  date: "2026-09-03",
  from: "",
  to: "",
  teacherId: "",
  subjectId: "",
  classGroupId: "",
  status: "",
});

parses("Teacher sessions: a date with grade/status/search on All", teacherSessionListFilterSchema, {
  range: "week",
  date: "2026-09-03",
  gradeId: "",
  status: "",
  q: "",
});

parses("Analytics: a custom range with the teacher filter on All", analyticsFilterSchema, {
  range: "range",
  date: "",
  from: "2026-09-01",
  to: "2026-09-06",
  teacherId: "",
});

parses("Expenses: a custom range", expenseFilterSchema, {
  range: "range",
  date: "",
  from: "2026-09-01",
  to: "2026-09-06",
});

parses("Classes: every filter on All", classListFilterSchema, {
  teacherId: "",
  subjectId: "",
  gradeId: "",
});

// ── 2. Tolerating "" must not mean tolerating anything ────────────────────

console.log("\nA genuinely invalid filter value is still rejected");

check(
  "Sessions: a bogus status is rejected",
  !sessionListFilterSchema.safeParse({ range: "day", status: "NONSENSE" }).success,
);
check(
  "Sessions: a bogus range is rejected",
  !sessionListFilterSchema.safeParse({ range: "decade" }).success,
);
check(
  "Teacher sessions: a bogus status is rejected",
  !teacherSessionListFilterSchema.safeParse({ range: "week", status: "NONSENSE" }).success,
);

if (failures > 0) {
  console.error(`\n${failures} filter check(s) failed.`);
  process.exit(1);
}
console.log("\nAll filter checks passed.");
