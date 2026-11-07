import type { Metadata } from "next";
import { Clock, Sparkles, UserCog } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import {
  EditPermissionsButton,
  InviteAssistantButton,
  RemoveAssistantButton,
  RevokeInviteButton,
} from "@/app/[locale]/(teacher)/teacher/assistants/assistant-controls";
import { AssistantPermissionList } from "@/components/assistants/assistant-permission-list";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { PageSection } from "@/components/shared/page-section";
import { PremiumStatusBadge } from "@/components/shared/premium-status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ASSISTANT_LIMITS } from "@/lib/assistant-catalog";
import { isPremium, premiumStatus } from "@/lib/auth/premium";
import { getTeacherScope } from "@/lib/auth/teacher-scope";
import { teacherAssistantsOverview } from "@/lib/db/assistants";
import { prisma } from "@/lib/db/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { DEFAULT_TIMEZONE } from "@/lib/scheduling";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.teacher");
  return { title: t("title") };
}

/**
 * Teacher → Assistants (W7a, D-W16, D-W17, D-W36; docs/04 §11.36). The teacher
 * portal's gate (`getTeacherScope`) admits a teacher; premium is read from the
 * account on this request. Without premium the page explains it and offers
 * nothing that widens access — but (W7b, D-W37 item 12) the teacher can still
 * revoke a pending invite and remove an assistant, since reducing access is
 * never gated. With premium: invite (choose a preset; the code shown once),
 * pending invites with their expiry and Revoke, and each assistant with their
 * preset (or Custom), their permissions, Edit permissions and Remove. The
 * server re-checks premium, the 5 slots and ownership on every action, so
 * nothing here is the boundary. Not a centre page: no branch scope, no tenant
 * read — the rows belong to the teacher's account.
 */
export default async function TeacherAssistantsPage() {
  const scope = await getTeacherScope();
  const [t, tPresets, locale] = await Promise.all([
    getTranslations("Assistants.teacher"),
    getTranslations("Assistants.presets"),
    getLocale(),
  ]);
  const now = new Date();
  const premium = isPremium(scope.user, now);

  const overview = await teacherAssistantsOverview(prisma, scope.user.id, now);
  const slotsFull = overview.slotsUsed >= ASSISTANT_LIMITS.slotsPerTeacher;
  const status = premiumStatus(scope.user.premiumUntil, now);
  // Without premium only what reduces access is offered, and only when there is something to reduce.
  const showLists = premium || overview.pendingInvites.length > 0 || overview.assistants.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />

      {premium ? (
        <Card>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-text-primary">
                {t("slots", { used: overview.slotsUsed, max: ASSISTANT_LIMITS.slotsPerTeacher })}
              </p>
              <p className="text-xs text-text-secondary">{t("slotsHint")}</p>
            </div>
            <InviteAssistantButton
              disabled={slotsFull}
              disabledReason={t("slotsFull", { max: ASSISTANT_LIMITS.slotsPerTeacher })}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle as="h2" className="flex flex-wrap items-center gap-2">
              <Sparkles className="size-5 shrink-0 text-brand" aria-hidden />
              <span>{t("premiumTitle")}</span>
              <PremiumStatusBadge status={status} />
            </CardTitle>
            <CardDescription>{t("premiumDescription", { max: ASSISTANT_LIMITS.slotsPerTeacher })}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm text-text-secondary">{t("premiumLapsedNote")}</p>
            <p className="text-sm font-medium text-text-primary">{t("premiumContact")}</p>
          </CardContent>
        </Card>
      )}

      {showLists ? (
        <>
          <PageSection title={t("pendingTitle")} description={t("pendingDescription")}>
            {overview.pendingInvites.length === 0 ? (
              <EmptyState compact icon={<Clock />} title={t("noPending")} />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {overview.pendingInvites.map((invite) => (
                  <li
                    key={invite.inviteId}
                    className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-medium text-text-primary">
                        {t("pendingPreset", { preset: tPresets(`${invite.preset}.label`) })}
                      </span>
                      <span className="text-xs text-text-secondary">
                        {t("pendingExpires", { date: formatDateTime(invite.expiresAt, locale, DEFAULT_TIMEZONE) })}
                      </span>
                    </div>
                    <RevokeInviteButton inviteId={invite.inviteId} />
                  </li>
                ))}
              </ul>
            )}
          </PageSection>

          <PageSection title={t("assistantsTitle")} description={t("assistantsDescription")}>
            {overview.assistants.length === 0 ? (
              <EmptyState compact icon={<UserCog />} title={t("noAssistants")} description={t("noAssistantsHint")} />
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2">
                {overview.assistants.map((assistant) => (
                  <li key={assistant.linkId}>
                    <Card size="sm" className="h-full">
                      <CardHeader>
                        <CardTitle as="h3" className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 break-words">{assistant.assistantName}</span>
                          {/* A preset is a label, not a status (docs/04 §14.1). */}
                          <Badge variant="neutral">{tPresets(`${assistant.preset}.label`)}</Badge>
                        </CardTitle>
                        <CardDescription>{t("since", { date: formatDate(assistant.since, locale) })}</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-4">
                        <AssistantPermissionList permissions={assistant.permissions} compact />
                        <div className="grid gap-2 sm:flex sm:justify-end">
                          {premium ? (
                            <EditPermissionsButton
                              linkId={assistant.linkId}
                              name={assistant.assistantName}
                              permissions={assistant.permissions}
                            />
                          ) : null}
                          <RemoveAssistantButton linkId={assistant.linkId} name={assistant.assistantName} />
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </PageSection>
        </>
      ) : null}
    </div>
  );
}
