import { cookies } from "next/headers";

/** The active center id lives in a cookie; every request resolves from it. */
export const ACTIVE_CENTER_COOKIE = "kayedu_center";

/**
 * "Whole Management" (M11, docs/00-master-product-spec.md §5.1 "Branch
 * architecture"): a view-mode flag for an Owner's analytics roll-up only.
 * It never widens `centerId`-scoping — `kayedu_center` still names one real
 * branch, which every operational screen keeps reading exactly as before.
 * Analytics alone checks this flag to decide whether to sum every branch
 * under the Owner's organization instead of showing just the active one.
 */
export const ACTIVE_CENTER_SCOPE_COOKIE = "kayedu_center_scope";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function getActiveCenterId(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACTIVE_CENTER_COOKIE)?.value ?? null;
}

export async function getActiveCenterScope(): Promise<"all" | null> {
  const store = await cookies();
  return store.get(ACTIVE_CENTER_SCOPE_COOKIE)?.value === "all" ? "all" : null;
}

/** Server Actions / Route Handlers only — a Server Component cannot set cookies. */
export async function setActiveCenterId(
  centerId: string,
  scope?: "all" | null,
): Promise<void> {
  const store = await cookies();
  store.set(ACTIVE_CENTER_COOKIE, centerId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  if (scope === "all") {
    store.set(ACTIVE_CENTER_SCOPE_COOKIE, "all", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
  } else {
    store.delete(ACTIVE_CENTER_SCOPE_COOKIE);
  }
}

export async function clearActiveCenterId(): Promise<void> {
  const store = await cookies();
  store.delete(ACTIVE_CENTER_COOKIE);
  store.delete(ACTIVE_CENTER_SCOPE_COOKIE);
}
