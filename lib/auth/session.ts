import { cache } from "react";
import type { User as AuthUser } from "@supabase/supabase-js";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseEnv } from "@/lib/supabase/env";

/** The Supabase auth user for this request, or null when signed out. */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  if (!supabaseEnv()) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

function nameFromAuth(authUser: AuthUser): { firstName: string; lastName: string } {
  const meta = (authUser.user_metadata ?? {}) as Record<string, unknown>;
  const first = typeof meta.first_name === "string" ? meta.first_name.trim() : "";
  const last = typeof meta.last_name === "string" ? meta.last_name.trim() : "";
  if (first || last) return { firstName: first || "-", lastName: last || "-" };

  const fullName = typeof meta.full_name === "string" ? meta.full_name.trim() : "";
  if (fullName) {
    const [head, ...rest] = fullName.split(/\s+/);
    return { firstName: head, lastName: rest.join(" ") || "-" };
  }

  const local = authUser.email?.split("@")[0] ?? "user";
  return { firstName: local, lastName: "-" };
}

/**
 * Mirrors the Supabase auth user into our `User` table (docs/02 §3).
 *
 * Identity is global: one User per person. If a User row already exists for
 * this email (e.g. seeded, or invited before they signed up) we *link* it
 * rather than creating a second person.
 */
export async function syncUserFromAuth(authUser: AuthUser): Promise<User> {
  const email = authUser.email?.trim().toLowerCase() ?? null;

  const linked = await prisma.user.findUnique({ where: { authId: authUser.id } });
  if (linked) {
    if (email && linked.email !== email) {
      return prisma.user.update({ where: { id: linked.id }, data: { email } });
    }
    return linked;
  }

  if (email) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      if (byEmail.authId && byEmail.authId !== authUser.id) {
        throw new Error(
          `User ${byEmail.id} is already linked to a different auth identity.`,
        );
      }
      return prisma.user.update({
        where: { id: byEmail.id },
        data: { authId: authUser.id },
      });
    }
  }

  const meta = (authUser.user_metadata ?? {}) as Record<string, unknown>;
  const rawPhone = typeof meta.phone === "string" ? meta.phone.trim() : "";
  // Never break the unique constraint — duplicate-phone merge is an M3 workflow.
  const phone =
    rawPhone && !(await prisma.user.findUnique({ where: { phone: rawPhone } }))
      ? rawPhone
      : null;
  const locale = typeof meta.locale === "string" && meta.locale === "en" ? "en" : "ar";

  return prisma.user.create({
    data: { authId: authUser.id, email, phone, locale, ...nameFromAuth(authUser) },
  });
}

/** The app-side User for this request (created/linked on first login). */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const authUser = await getAuthUser();
  if (!authUser) return null;
  return syncUserFromAuth(authUser);
});
