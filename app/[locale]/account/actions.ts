"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";

import { changeEmail, changePassword, type AccountAuthPort, type AccountResult } from "@/lib/auth/account";
import { getAuthUser, getCurrentUser } from "@/lib/auth/session";
import { clientIp } from "@/lib/auth/request-ip";
import { updateAccountProfile } from "@/lib/db/account";
import { prisma } from "@/lib/db/client";
import { redirect } from "@/lib/i18n/navigation";
import { logBestEffort } from "@/lib/log";
import { ROUTES, authConfirmUrl } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { localeSchema } from "@/lib/validation/auth";
import { accountProfileSchema, changeEmailSchema, changePasswordSchema } from "@/lib/validation/account";
import { fieldErrorsFrom } from "@/lib/validation/form";

/** `error` and the `fieldErrors` values are keys under `Account.errors`. */
export type AccountFormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "saved" | Extract<AccountResult, { ok: true }>["status"];
};

function readLocale(formData: FormData): "ar" | "en" {
  const parsed = localeSchema.safeParse(formData.get("locale"));
  return parsed.success ? parsed.data : "en";
}

/** Supabase's error codes, reduced to what the page can say. */
function portError(error: { code?: string } | null): "emailTaken" | "weakPassword" | "failed" {
  if (error?.code === "email_exists") return "emailTaken";
  if (error?.code === "weak_password") return "weakPassword";
  return "failed";
}

/**
 * The real Supabase side of Account settings (F2) — `lib/auth/account.ts`
 * decides, this only performs.
 */
async function supabasePort(authId: string, locale: "ar" | "en"): Promise<AccountAuthPort> {
  const supabase = await createSupabaseServerClient();
  return {
    async verifyPassword(email, password) {
      // A throwaway client with no cookie store: the check must neither replace
      // this session nor leave a second one behind, so its session is revoked.
      const { url, anonKey } = requireSupabaseEnv();
      const probe = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error } = await probe.auth.signInWithPassword({ email, password });
      if (error || !data.session) return false;
      await probe.auth.signOut({ scope: "local" }).catch(logBestEffort("account password probe sign-out"));
      return true;
    },
    async setPassword(password) {
      const { error } = await supabase.auth.updateUser({ password });
      return error ? { ok: false, code: portError(error) } : { ok: true };
    },
    async signOutOthers() {
      const { error } = await supabase.auth.signOut({ scope: "others" });
      if (error) logBestEffort("account sign out other devices")(error);
      return !error;
    },
    async setEmailConfirmed(email) {
      const { data, error } = await createSupabaseAdminClient().auth.admin.updateUserById(authId, {
        email,
        email_confirm: true,
      });
      if (error || !data.user) return { ok: false, code: portError(error) };
      return { ok: true, identity: data.user };
    },
    async requestEmailChange(email) {
      const { error } = await supabase.auth.updateUser({ email }, { emailRedirectTo: authConfirmUrl(locale) });
      return error ? { ok: false, code: portError(error) } : { ok: true };
    },
  };
}

/** The signed-in caller, or a redirect to sign-in. */
async function caller(locale: "ar" | "en") {
  const [authUser, user] = await Promise.all([getAuthUser(), getCurrentUser()]);
  if (!authUser || !user) {
    redirect({ href: ROUTES.login, locale });
    throw new Error("unreachable");
  }
  return { authUser, user, ip: await clientIp() };
}

function revalidateAccount(locale: "ar" | "en") {
  revalidatePath(`/${locale}${ROUTES.account}`);
}

/**
 * Name, contact phone and preferred language — the `User` row only. Never a
 * branch's local record (rule 4), never `User.phone` (D-02).
 */
export async function updateAccountProfileAction(
  _prev: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const locale = readLocale(formData);
  const parsed = accountProfileSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { user } = await caller(locale);

  await updateAccountProfile(prisma, user.id, {
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    contactPhone: parsed.data.contactPhone,
    locale: parsed.data.preferredLocale,
  });
  revalidateAccount(locale);
  return { status: "saved" };
}

export async function changePasswordAction(
  _prev: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const locale = readLocale(formData);
  const parsed = changePasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { authUser, user, ip } = await caller(locale);

  const result = await changePassword(
    prisma,
    await supabasePort(authUser.id, locale),
    { user, authEmail: authUser.email ?? null, ip },
    {
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      signOutOthers: parsed.data.signOutOthers,
    },
  );
  return result.ok ? { status: result.status } : { error: result.error, fieldErrors: result.fieldErrors };
}

export async function changeEmailAction(
  _prev: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const locale = readLocale(formData);
  const parsed = changeEmailSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { authUser, user, ip } = await caller(locale);

  const result = await changeEmail(
    prisma,
    await supabasePort(authUser.id, locale),
    { user, authEmail: authUser.email ?? null, ip },
    { newEmail: parsed.data.newEmail, currentPassword: parsed.data.currentPassword },
  );
  if (!result.ok) return { error: result.error, fieldErrors: result.fieldErrors };
  revalidateAccount(locale);
  return { status: result.status };
}
