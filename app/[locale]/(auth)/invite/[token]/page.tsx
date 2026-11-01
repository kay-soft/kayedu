import { getLocale, getTranslations } from "next-intl/server";

import { AcceptInvitationForm } from "@/app/[locale]/(auth)/invite/[token]/accept-invitation-form";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { AuthCard } from "@/components/shared/auth-card";
import { FormMessage } from "@/components/shared/form-message";
import { Ltr } from "@/components/shared/ltr";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { invitationByToken, isAccessibleCenter } from "@/lib/db/platform";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

/**
 * Staff invite acceptance (docs/02 §3). The unguessable token is the entry
 * point, so this lookup is intentionally not center-scoped — the invitation
 * itself carries the centerId that every later query is scoped to.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const locale = await getLocale();
  const t = await getTranslations("Auth.invite");
  const tErrors = await getTranslations("Auth.errors");
  const tRoles = await getTranslations("Roles");

  const invitation = await invitationByToken(prisma, token);

  const invalidReason = !invitation
    ? "inviteNotFound"
    : invitation.status === "REVOKED"
      ? "inviteNotFound"
      : invitation.status === "ACCEPTED"
        ? "inviteAlreadyAccepted"
        : !isAccessibleCenter(invitation.center)
          ? "centerInactive"
          : invitation.status === "EXPIRED" || invitation.expiresAt < new Date()
            ? "inviteExpired"
            : null;

  if (!invitation || invalidReason) {
    return (
      <AuthCard title={t("title")}>
        {/* Nothing is broken — the link simply no longer works — so the
            warning tone, a next step in the copy, and both ways forward
            (DES, docs/04 §12). */}
        <div className="flex flex-col gap-3">
          <FormMessage tone="warning">{tErrors(invalidReason ?? "inviteNotFound")}</FormMessage>
          <Link
            href={ROUTES.login}
            className={cn(buttonVariants(), "h-11 w-full")}
          >
            {t("goToLogin")}
          </Link>
          <Link
            href={ROUTES.register}
            className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full")}
          >
            {t("createAccount")}
          </Link>
        </div>
      </AuthCard>
    );
  }

  const user = await getCurrentUser();
  const emailMatches =
    user?.email?.toLowerCase() === invitation.email.toLowerCase();
  const nextPath = encodeURIComponent(ROUTES.invite(token));

  return (
    <AuthCard
      title={t("title")}
      description={t("subtitle", { center: invitation.center.name })}
    >
      <div className="flex flex-col gap-4">
        <dl className="flex flex-col gap-2 rounded-lg border border-border bg-surface-subtle p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-text-secondary">{t("centerLabel")}</dt>
            <dd className="font-medium">{invitation.center.name}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-text-secondary">{t("roleLabel")}</dt>
            <dd>
              <Badge variant="neutral">{tRoles(invitation.role)}</Badge>
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-text-secondary">{t("emailLabel")}</dt>
            <dd className="font-medium">
              <Ltr>{invitation.email}</Ltr>
            </dd>
          </div>
        </dl>

        {!user ? (
          <div className="flex flex-col gap-2">
            <FormMessage tone="info">{t("signInToAccept")}</FormMessage>
            <Link
              href={`${ROUTES.register}?next=${nextPath}&email=${encodeURIComponent(invitation.email)}`}
              className={cn(buttonVariants(), "h-11 w-full")}
            >
              {t("createAccount")}
            </Link>
            <Link
              href={`${ROUTES.login}?next=${nextPath}`}
              className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full")}
            >
              {t("signIn")}
            </Link>
          </div>
        ) : emailMatches ? (
          <AcceptInvitationForm token={token} />
        ) : (
          <div className="flex flex-col gap-2">
            <FormMessage>
              {tErrors("inviteEmailMismatch")}
            </FormMessage>
            <p className="text-sm text-text-secondary">
              {t("signedInAs", { email: user.email ?? "" })}
            </p>
            <SignOutButton variant="light" className="rounded-lg border border-border-control" />
          </div>
        )}

        <p className="text-xs text-text-secondary">
          {t("expiresAt", {
            date: formatDate(invitation.expiresAt, locale),
          })}
        </p>
      </div>
    </AuthCard>
  );
}
