/**
 * The teacher nav the gates expect — hand-written on purpose, NOT derived from
 * `TEACHER_NAV`, so it stays an independent oracle: if the real nav changes,
 * `check:permissions` and `seed:verify` fail until this list is updated too.
 * Shared so the two cannot drift apart (they did, at U9 — `profile`).
 */
export const EXPECTED_TEACHER_NAV = ["dashboard", "sessions", "calendar", "students", "classes", "approvals", "settlements", "profile"];
