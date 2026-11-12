/**
 * The teacher nav the gates expect — hand-written on purpose, NOT derived from
 * `TEACHER_NAV`, so it stays an independent oracle: if the real nav changes,
 * `check:permissions` and `seed:verify` fail until this list is updated too.
 * Shared so the two cannot drift apart (they did, at U9 — `profile`).
 * W7a (D-W36): + "assistants". W8a (D-W38): + "workspaces". W8d (D-W41): + "earnings".
 */
export const EXPECTED_TEACHER_NAV = ["dashboard", "sessions", "calendar", "students", "classes", "assessments", "approvals", "earnings", "settlements", "assistants", "workspaces", "profile"];

/**
 * The minimal shell of a teacher with no branch but a PERSONAL workspace —
 * hand-written, the same oracle discipline. W8a (D-W38): workspaces, centers.
 * W8d (D-W41): + earnings, assistants. W9 (D-W42 item 7): + calendar,
 * assessments. `check:workspaces` compares it with `TEACHER_WORKSPACE_ONLY_NAV`.
 */
export const EXPECTED_WORKSPACE_ONLY_TEACHER_NAV = ["workspaces", "calendar", "assessments", "earnings", "assistants", "centers"];

/**
 * The assistant shell's nav per seeded case (X1) — hand-written from the
 * catalogue (`lib/assistant-catalog.ts`), NOT derived from
 * `lib/assistant-nav.ts`, the same oracle discipline. For a teacher with one
 * branch that allows assistants (baseline TEACHER cells, trusted) and one
 * PERSONAL workspace:
 *  - FULL grants every key but `students.phones`: Home, Exams & homework
 *    (assessments.review), Classes (classes.view, branches), Workspaces,
 *    Requests (requests.manage, a trusted teacher), Overview (analytics.view,
 *    branches) and Earnings (analytics.view);
 *  - the custom check-in case (`checkin.workspace` + `payments.workspace`)
 *    acts only in workspaces: Home and Workspaces — no Earnings, nothing at
 *    the branch.
 * Imported by `seed:verify`, `check:permissions` and `e2e/navigation.spec.ts`.
 */
export const EXPECTED_ASSISTANT_NAV = {
  FULL: ["home", "assessments", "classes", "workspaces", "requests", "overview", "earnings"],
  CHECKIN: ["home", "workspaces"],
} as const;
