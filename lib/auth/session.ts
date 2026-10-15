import { cache } from "react";
import type { User as AuthUser } from "@supabase/supabase-js";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseEnv } from "@/lib/supabase/env";
import { resolveAppIdentity, type AppIdentity } from "@/lib/auth/identity-link";

/** The Supabase auth user for this request, or null when signed out. */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  if (!supabaseEnv()) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

/**
 * Mirrors a Supabase login into our `User` table (docs/02 §3). The linking
 * rules live in `lib/auth/identity-link.ts` (SEC-2a, D-01): a login is never
 * attached to a person a centre created just because the email matches — that
 * opens a claim staff approve in person.
 */
export function syncUserFromAuth(authUser: AuthUser): Promise<AppIdentity> {
  return resolveAppIdentity(prisma, authUser);
}

/** What this request's login resolves to — see `AppIdentity`. Null when signed out. */
export const getAppIdentity = cache(async (): Promise<AppIdentity | null> => {
  const authUser = await getAuthUser();
  if (!authUser) return null;
  return syncUserFromAuth(authUser);
});

/**
 * The app-side User for this request. Null when signed out — and also while a
 * login has no app user yet (an unconfirmed email under
 * REQUIRE_EMAIL_CONFIRMATION, or a pending claim on a staff-created person):
 * such a login reaches nothing that needs a `User`.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const identity = await getAppIdentity();
  return identity?.kind === "user" ? identity.user : null;
});
