import { cookies } from "next/headers";

/**
 * The active selection lives in one cookie; every request resolves from it.
 *
 * Its value is a `Center.id` for almost every reader — but for an Owner who
 * has chosen "Whole Management" (M11, docs/00-master-product-spec.md §5.1
 * "Branch architecture"), it holds that `Organization.id` instead. There is
 * still exactly one cookie and one read path: `getTenantContext()`
 * (`lib/auth/tenant.ts`) is where the value is interpreted — try it as a
 * branch id first, then as an organization id an Owner actually holds — and
 * it is the only place that distinction is made. Every operational screen
 * still gets one real, resolved `centerId` out of that (a representative
 * branch when the cookie names an organization); only Analytics additionally
 * reads back which one the cookie actually named, to decide on the roll-up.
 * Reusing the single existing cookie/flow was a deliberate M11 decision — see
 * `02-architecture.md` §4 — rather than adding a second cookie or switching
 * mechanism.
 */
export const ACTIVE_CENTER_COOKIE = "kayedu_center";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** The raw stored value — a `Center.id` or an `Organization.id`. Interpreted by the caller. */
export async function getActiveCenterId(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACTIVE_CENTER_COOKIE)?.value ?? null;
}

/** Server Actions / Route Handlers only — a Server Component cannot set cookies. */
export async function setActiveCenterId(id: string): Promise<void> {
  const store = await cookies();
  store.set(ACTIVE_CENTER_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function clearActiveCenterId(): Promise<void> {
  const store = await cookies();
  store.delete(ACTIVE_CENTER_COOKIE);
}

/**
 * The teacher portal's own choice (U7): one branch, or — absent, the default —
 * **All branches**. Separate from `kayedu_center` on purpose: a person who is
 * staff at one branch and a teacher at others keeps their staff branch when
 * they narrow the teacher portal, and "All branches" is not a value the staff
 * experience could ever resolve. It only names a branch; `getTeacherScope()`
 * (`lib/auth/teacher-scope.ts`) checks it against the teacher's own relations
 * on every request and reads anything else as All branches.
 */
export const TEACHER_BRANCH_COOKIE = "kayedu_teacher_branch";

/** The teacher portal's branch, or null for All branches. Interpreted by `getTeacherScope()`. */
export async function getTeacherBranchId(): Promise<string | null> {
  const store = await cookies();
  return store.get(TEACHER_BRANCH_COOKIE)?.value || null;
}

/** Server Actions only. `null` is All branches — the cookie is removed. */
export async function setTeacherBranchId(id: string | null): Promise<void> {
  const store = await cookies();
  if (!id) {
    store.delete(TEACHER_BRANCH_COOKIE);
    return;
  }
  store.set(TEACHER_BRANCH_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}
