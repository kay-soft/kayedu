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
