"use server";

import { prisma } from "@/lib/db/client";
import { writeAuditLog } from "@/lib/db/audit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser, syncUserFromAuth } from "@/lib/auth/session";
import { requireEmailConfirmation } from "@/lib/auth/auth-config";
import { clientIp } from "@/lib/auth/request-ip";
import {
  clearActiveCenterId,
  setActiveCenterId,
} from "@/lib/auth/active-center";
import {
  getOwnerOrgGroups,
  getUserCenterRelations,
  landingWithoutBranch,
  primaryRole,
  type CenterRelation,
} from "@/lib/auth/tenant";
import { ACCESSIBLE_LIFECYCLE_STATES } from "@/lib/db/platform";
import { checkRateLimits } from "@/lib/rate-limit";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, authConfirmUrl, homePathForRole, safeNextPath } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  acceptInvitationSchema,
  localeSchema,
  resendConfirmationSchema,
  selectCenterSchema,
  signInSchema,
  signUpSchema,
} from "@/lib/validation/auth";
import type { User } from "@prisma/client";
import { logBestEffort } from "@/lib/log";

export type AuthFormState = {
  /** Message key under `Auth.errors`. */
  error?: string;
  /** field name → message key under `Auth.errors`. */
  fieldErrors?: Record<string, string>;
  /**
   * `emailConfirmationRequired` — the sign-up (or sign-in) has no session yet:
   * show "check your email" with a resend action (SEC-2a). Also returned for
   * an email that already has an account, so the form never tells a stranger
   * which emails are registered (SEC-40). `resent` — the resend was accepted.
   */
  status?: "emailConfirmationRequired" | "resent";
  /** Echoed back for the "check your email" state's resend form. */
  email?: string;
};

/** `User.locale` when it is a locale this app speaks, else the form's (F2). */
function preferredLocale(user: User, fallback: "ar" | "en"): "ar" | "en" {
  const parsed = localeSchema.safeParse(user.locale);
  return parsed.success ? parsed.data : fallback;
}

function readLocale(formData: FormData): "ar" | "en" {
  const parsed = localeSchema.safeParse(formData.get("locale"));
  return parsed.success ? parsed.data : "en";
}

/**
 * Where a user lands after authenticating. Exactly one center → auto-select it
 * (docs/02 §3); more than one → the /select-center hub.
 */
async function resolveLandingPath(user: User): Promise<string> {
  const relations: CenterRelation[] = await getUserCenterRelations(user.id);

  if (relations.length === 1) {
    const relation = relations[0];
    await setActiveCenterId(relation.center.id);
    return homePathForRole(primaryRole(relation));
  }

  // No branch: the admin console, the parent portal (verified children), the
  // person's own onboarding when they declared a sign-up intent (F4), or the hub (SYS).
  if (relations.length === 0) return landingWithoutBranch(user);

  return ROUTES.selectCenter;
}

export async function signInAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error) };
  }
  const { email, password, locale, next } = parsed.data;

  // SEC-27: per email and per client address, in the shared store, before
  // Supabase is ever asked — password spraying stops here, not at GoTrue's
  // per-IP limit (which sees Vercel's address for everyone).
  const allowed = await checkRateLimits([
    { name: "signInPerEmail", key: email },
    { name: "signInPerIp", key: await clientIp() },
  ]);
  if (!allowed) return { error: "rateLimited" };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    return { error: "invalidCredentials" };
  }

  const identity = await syncUserFromAuth(data.user);
  if (identity.kind === "claimPending") {
    redirect({ href: ROUTES.accountPending, locale });
    return {};
  }
  if (identity.kind !== "user") {
    // No app user for this login (an unconfirmed email under
    // REQUIRE_EMAIL_CONFIRMATION, or an email held elsewhere): no session.
    await supabase.auth.signOut();
    return identity.kind === "unconfirmed"
      ? { status: "emailConfirmationRequired", email }
      : { error: "invalidCredentials" };
  }

  const target = safeNextPath(next) ?? (await resolveLandingPath(identity.user));

  // F2: a signed-in person lands in their preferred language (User.locale,
  // set on Account settings), not whichever page the form happened to be on.
  redirect({ href: target, locale: preferredLocale(identity.user, locale) });
  return {};
}

export async function signUpAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error) };
  }
  const { firstName, lastName, email, password, locale, next, signupIntent } = parsed.data;

  const allowed = await checkRateLimits([
    { name: "signUpPerIp", key: await clientIp() },
    { name: "signUpPerEmail", key: email },
  ]);
  if (!allowed) return { error: "rateLimited" };

  // No phone is collected here (SEC-40, D-02): a phone is never an identity
  // key, so there is nothing to clash and nothing that tells a stranger who
  // holds a number. A contact phone lives only in Account settings.
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: authConfirmUrl(locale),
      // `signup_intent` (F4) rides in the metadata so it survives the
      // confirm-email round trip; `resolveAppIdentity` stores it on the new
      // User. It routes onboarding and authorises nothing.
      data: { first_name: firstName, last_name: lastName, locale, signup_intent: signupIntent },
    },
  });

  if (error || !data.user) {
    return { error: "signUpFailed" };
  }

  // No session: Supabase wants the email confirmed first. The same answer is
  // given when the email already has an account (Supabase then returns a user
  // with no identities) — the form never confirms which emails exist.
  if (!data.session) {
    return { status: "emailConfirmationRequired", email };
  }

  const identity = await syncUserFromAuth(data.user);
  if (identity.kind === "claimPending") {
    redirect({ href: ROUTES.accountPending, locale });
    return {};
  }
  if (identity.kind !== "user") {
    await supabase.auth.signOut();
    return identity.kind === "unconfirmed"
      ? { status: "emailConfirmationRequired", email }
      : { error: "signUpFailed" };
  }

  // F3 (OD-6 decided): a sign-up never originates parent access — a parent
  // links with a one-time code (`/family/join`, lib/db/parents.ts's
  // `acceptFamilyCode`).

  const target = safeNextPath(next) ?? (await resolveLandingPath(identity.user));

  redirect({ href: target, locale });
  return {};
}

/**
 * "Send the confirmation email again" (SEC-2a). Rate-limited per email and per
 * client address, and always answers the same way, so it reveals nothing
 * about which emails have accounts.
 */
export async function resendConfirmationAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = resendConfirmationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { email, locale } = parsed.data;

  const allowed = await checkRateLimits([
    { name: "resendPerIp", key: await clientIp() },
    { name: "resendPerEmail", key: email },
  ]);
  if (!allowed) return { status: "emailConfirmationRequired", email, error: "rateLimited" };

  const supabase = await createSupabaseServerClient();
  await supabase.auth
    .resend({ type: "signup", email, options: { emailRedirectTo: authConfirmUrl(locale) } })
    .catch(logBestEffort("confirmation email resend"));

  return { status: "resent", email };
}

export async function signOutAction(formData: FormData): Promise<void> {
  const locale = readLocale(formData);

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  await clearActiveCenterId();

  redirect({ href: ROUTES.login, locale });
}

export async function selectCenterAction(formData: FormData): Promise<void> {
  const parsed = selectCenterSchema.safeParse(Object.fromEntries(formData));
  const locale = readLocale(formData);

  if (!parsed.success) {
    redirect({ href: ROUTES.selectCenter, locale });
    return;
  }

  const user = await getCurrentUser();
  if (!user) {
    redirect({ href: ROUTES.login, locale });
    return;
  }

  // Never trust a client-sent id blindly — it must resolve to one of the
  // user's own branches, or (M11) one of their own multi-branch
  // organizations. One cookie value, two things it can name; this mirrors
  // the exact same resolution `getTenantContext()` does on every later
  // request (lib/auth/active-center.ts).
  const relations = await getUserCenterRelations(user.id);
  const relation = relations.find(
    (item) => item.center.id === parsed.data.selectionId,
  );
  if (relation) {
    await setActiveCenterId(relation.center.id);
    // T6: a pick from the pick-a-branch screen returns to the page it was on;
    // that page still runs its own gate at the chosen branch.
    redirect({ href: safeNextPath(parsed.data.next) ?? homePathForRole(primaryRole(relation)), locale });
    return;
  }

  const orgGroups = await getOwnerOrgGroups(user.id);
  const group = orgGroups.find(
    (item) => item.organizationId === parsed.data.selectionId,
  );
  if (group) {
    const representative = relations.find(
      (item) => item.center.id === group.branches[0].id,
    );
    if (representative) {
      await setActiveCenterId(group.organizationId);
      redirect({ href: homePathForRole(primaryRole(representative)), locale });
      return;
    }
  }

  redirect({ href: `${ROUTES.selectCenter}?switch=1`, locale });
}

class InvitationNoLongerPending extends Error {}

export async function acceptInvitationAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = acceptInvitationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: "invalidToken" };
  }
  const { token, locale } = parsed.data;

  const user = await getCurrentUser();
  if (!user) {
    redirect({
      href: `${ROUTES.login}?next=${encodeURIComponent(ROUTES.invite(token))}`,
      locale,
    });
    return {};
  }

  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { center: true },
  });

  if (!invitation || invitation.status === "REVOKED") {
    return { error: "inviteNotFound" };
  }
  if (invitation.status === "ACCEPTED") {
    return { error: "inviteAlreadyAccepted" };
  }
  if (!ACCESSIBLE_LIFECYCLE_STATES.includes(invitation.center.lifecycleState)) {
    return { error: "centerInactive" };
  }
  if (invitation.status === "EXPIRED" || invitation.expiresAt < new Date()) {
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    return { error: "inviteExpired" };
  }
  // The token is bound to the invited email (D-01): only the login holding
  // that email may use it — and, under REQUIRE_EMAIL_CONFIRMATION, only once
  // Supabase has confirmed that the login controls it.
  if (
    !user.email ||
    user.email.toLowerCase() !== invitation.email.toLowerCase()
  ) {
    return { error: "inviteEmailMismatch" };
  }
  if (requireEmailConfirmation() && !user.emailVerifiedAt) {
    return { error: "emailNotConfirmed" };
  }

  // Membership creation is a permission change — it is audited (CLAUDE.md §7).
  // SEC-42: the invitation is claimed first, conditionally, inside the same
  // transaction — a revoke or a second accept landing between the checks
  // above and this write leaves no membership behind.
  let membership;
  try {
    membership = await prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, status: "PENDING", expiresAt: { gt: new Date() } },
        data: { status: "ACCEPTED" },
      });
      if (claimed.count !== 1) throw new InvitationNoLongerPending();

      const existing = await tx.membership.findFirst({
        where: {
          userId: user.id,
          centerId: invitation.centerId,
          role: invitation.role,
        },
      });

      return existing
        ? tx.membership.update({
            where: { id: existing.id },
            data: { active: true, joinedAt: new Date() },
          })
        : tx.membership.create({
            data: {
              userId: user.id,
              centerId: invitation.centerId,
              role: invitation.role,
              joinedAt: new Date(),
            },
          });
    });
  } catch (error) {
    if (error instanceof InvitationNoLongerPending) return { error: "inviteNotFound" };
    throw error;
  }

  await writeAuditLog({
    centerId: invitation.centerId,
    actorUserId: user.id,
    action: "membership.create",
    entityType: "Membership",
    entityId: membership.id,
    after: {
      userId: user.id,
      role: invitation.role,
      via: "invitation",
      invitationId: invitation.id,
    },
  });

  await setActiveCenterId(invitation.centerId);

  redirect({ href: homePathForRole(invitation.role), locale });
  return {};
}
