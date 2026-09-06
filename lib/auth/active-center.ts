import { cookies } from "next/headers";

/** The active center id lives in a cookie; every request resolves from it. */
export const ACTIVE_CENTER_COOKIE = "kayedu_center";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function getActiveCenterId(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACTIVE_CENTER_COOKIE)?.value ?? null;
}

/** Server Actions / Route Handlers only — a Server Component cannot set cookies. */
export async function setActiveCenterId(centerId: string): Promise<void> {
  const store = await cookies();
  store.set(ACTIVE_CENTER_COOKIE, centerId, {
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
