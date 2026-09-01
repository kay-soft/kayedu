"use server";

import { prisma } from "@/lib/db/client";
import { writeAuditLog } from "@/lib/db/audit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser, syncUserFromAuth } from "@/lib/auth/session";
import {
  clearActiveCenterId,
  setActiveCenterId,
} from "@/lib/auth/active-center";
import {
  getUserCenterRelations,
  primaryRole,
  type CenterRelation,
} from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, homePathForRole, safeNextPath } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  acceptInvitationSchema,
  localeSchema,
  selectCenterSchema,
  signInSchema,
  signUpSchema,
} from "@/lib/validation/auth";
import type { User } from "@prisma/client";

export type AuthFormState = {
  /** Message key under `Auth.errors`. */
  error?: string;
  /** field name → message key under `Auth.errors`. */
  fieldErrors?: Record<string, string>;
  /** Set when Supabase requires the user to confirm their email first. */
  status?: "emailConfirmationRequired";
};

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

  if (relations.length === 0) {
    return user.isPlatformAdmin ? ROUTES.adminCenters : ROUTES.selectCenter;
  }

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

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    return { error: "invalidCredentials" };
  }

  const user = await syncUserFromAuth(data.user);
  const target = safeNextPath(next) ?? (await resolveLandingPath(user));

  redirect({ href: target, locale });
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
  const { firstName, lastName, email, password, locale, next } = parsed.data;
  const phone = parsed.data.phone?.trim() || null;

  // Identity is global: one person, one User. A phone already claimed by a
  // different person is a match/merge case (M3), never a silent duplicate.
  if (phone) {
    const phoneOwner = await prisma.user.findUnique({ where: { phone } });
    if (phoneOwner && phoneOwner.email !== email) {
      return { fieldErrors: { phone: "phoneInUse" } };
    }
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        first_name: firstName,
        last_name: lastName,
        phone: phone ?? "",
        locale,
      },
    },
  });

  if (error) {
    return { error: "signUpFailed" };
  }

  // Supabase returns a user with no identities when the email already exists.
  if (!data.user || data.user.identities?.length === 0) {
    return { fieldErrors: { email: "emailInUse" } };
  }

  if (!data.session) {
    return { status: "emailConfirmationRequired" };
  }

  const user = await syncUserFromAuth(data.user);
  await prisma.user.update({
    where: { id: user.id },
    data: { firstName, lastName, phone, locale },
  });

  const target = safeNextPath(next) ?? (await resolveLandingPath(user));

  redirect({ href: target, locale });
  return {};
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

  // Never trust a client-sent centerId — it must be one of the user's own.
  const relations = await getUserCenterRelations(user.id);
  const relation = relations.find(
    (item) => item.center.id === parsed.data.centerId,
  );
  if (!relation) {
    redirect({ href: `${ROUTES.selectCenter}?switch=1`, locale });
    return;
  }

  await setActiveCenterId(relation.center.id);
  redirect({ href: homePathForRole(primaryRole(relation)), locale });
}

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
  if (!invitation.center.active) {
    return { error: "centerInactive" };
  }
  if (invitation.status === "EXPIRED" || invitation.expiresAt < new Date()) {
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    return { error: "inviteExpired" };
  }
  if (
    !user.email ||
    user.email.toLowerCase() !== invitation.email.toLowerCase()
  ) {
    return { error: "inviteEmailMismatch" };
  }

  // Membership creation is a permission change — it is audited (CLAUDE.md §7).
  const membership = await prisma.$transaction(async (tx) => {
    const existing = await tx.membership.findFirst({
      where: {
        userId: user.id,
        centerId: invitation.centerId,
        role: invitation.role,
      },
    });

    const row = existing
      ? await tx.membership.update({
          where: { id: existing.id },
          data: { active: true, joinedAt: new Date() },
        })
      : await tx.membership.create({
          data: {
            userId: user.id,
            centerId: invitation.centerId,
            role: invitation.role,
            joinedAt: new Date(),
          },
        });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED" },
    });

    return row;
  });

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
