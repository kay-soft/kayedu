import { getLocale, getTranslations } from "next-intl/server";

import { AcceptInvitationForm } from "@/app/[locale]/(auth)/invite/[token]/accept-invitation-form";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

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

  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { center: true },
  });

  const invalidReason = !invitation
    ? "inviteNotFound"
    : invitation.status === "REVOKED"
      ? "inviteNotFound"
      : invitation.status === "ACCEPTED"
        ? "inviteAlreadyAccepted"
        : !invitation.center.active
          ? "centerInactive"
          : invitation.status === "EXPIRED" || invitation.expiresAt < new Date()
            ? "inviteExpired"
            : null;

  if (!invitation || invalidReason) {
    return (
      <Card className="p-2 sm:p-4">
        <CardHeader>
          <CardTitle className="text-xl font-bold">{t("title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <FormMessage>{tErrors(invalidReason ?? "inviteNotFound")}</FormMessage>
          <Link
            href={ROUTES.login}
            className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full")}
          >
            {t("goToLogin")}
          </Link>
        </CardContent>
      </Card>
    );
  }

  const user = await getCurrentUser();
  const emailMatches =
    user?.email?.toLowerCase() === invitation.email.toLowerCase();
  const nextPath = encodeURIComponent(ROUTES.invite(token));

  return (
    <Card className="p-2 sm:p-4">
      <CardHeader>
        <CardTitle className="text-xl font-bold">{t("title")}</CardTitle>
        <CardDescription>
          {t("subtitle", { center: invitation.center.name })}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-col gap-2 rounded-lg border border-border bg-surface-subtle p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-text-muted">{t("centerLabel")}</dt>
            <dd className="font-medium">{invitation.center.name}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-text-muted">{t("roleLabel")}</dt>
            <dd>
              <Badge variant="brand">{tRoles(invitation.role)}</Badge>
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-text-muted">{t("emailLabel")}</dt>
            <dd className="font-medium" dir="ltr">
              {invitation.email}
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
            <div className="rounded-xl bg-sidebar p-2">
              <SignOutButton />
            </div>
          </div>
        )}

        <p className="text-xs text-text-muted">
          {t("expiresAt", {
            date: new Intl.DateTimeFormat(
              locale === "ar" ? "ar-EG-u-nu-arab" : "en-US",
              { dateStyle: "medium" },
            ).format(invitation.expiresAt),
          })}
        </p>
      </CardContent>
    </Card>
  );
}
