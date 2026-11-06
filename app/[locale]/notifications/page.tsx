import type { Metadata } from "next";
import { Bell } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { Pagination } from "@/components/center/pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ResultsRegion } from "@/components/shared/results-region";
import { AppShell, type ShellUser } from "@/components/shell/app-shell";
import { shellFrameFor } from "@/components/shell/experience-frame";
import { HubShell } from "@/components/shell/hub-shell";
import { MarkAllReadForm } from "@/components/shell/mark-all-read-form";
import { NotificationRow } from "@/components/shell/notification-row";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveAccountExperience } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { countUnread, listNotifications } from "@/lib/db/notifications";
import { fullName } from "@/lib/identity";
import { personInitials } from "@/lib/initials";
import { presentNotifications } from "@/lib/notifications/present";
import { ensureSoonNotices, notificationReach } from "@/lib/notifications/reach";
import { ACCOUNT_HUB_HINT, notificationsPath } from "@/lib/routes";
import { NOTIFICATIONS_PAGE_SIZE } from "@/lib/validation/notifications";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Notifications");
  return { title: t("title") };
}

/**
 * The notification inbox (W1, D-W12; docs/04 §11.31) — every signed-in
 * person, one route, rendered inside the shell it was opened from (`?from=`,
 * re-checked by `resolveAccountExperience`, the Account settings rule). Reads
 * only the caller's own notices that pass the access re-check, newest first,
 * paged. Opening a row marks it read and follows its link; "Mark all as read"
 * sits in the header while anything is unread.
 */
export default async function NotificationsPage({ searchParams }: PageProps<"/[locale]/notifications">) {
  const { from, page: rawPage } = await searchParams;
  const experience = await resolveAccountExperience(typeof from === "string" ? from : undefined);
  const [frame, user, locale, t] = await Promise.all([
    experience === ACCOUNT_HUB_HINT ? null : shellFrameFor(experience),
    getCurrentUser(),
    getLocale(),
    getTranslations("Notifications"),
  ]);
  // resolveAccountExperience already redirected a signed-out visitor.
  if (!user) return null;

  const requested = Number(typeof rawPage === "string" ? rawPage : 1);
  const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
  await ensureSoonNotices(user.id);
  const reach = await notificationReach(user.id);
  const [{ rows, total }, unread] = await Promise.all([
    listNotifications(prisma, user.id, reach, {
      skip: (page - 1) * NOTIFICATIONS_PAGE_SIZE,
      take: NOTIFICATIONS_PAGE_SIZE,
    }),
    countUnread(prisma, user.id, reach),
  ]);
  const items = await presentNotifications(rows, locale);

  const body = (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          unread > 0 ? <MarkAllReadForm locale={locale} /> : undefined
        }
      />

      <ResultsRegion>
        <div className="flex flex-col gap-4">
          <Card>
            <CardContent className="p-1 sm:p-2">
              {items.length === 0 ? (
                <EmptyState
                  icon={<Bell />}
                  tone="info"
                  title={t("empty.title")}
                  description={t("empty.description")}
                />
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {items.map((item) => (
                    <li key={item.id} className="py-0.5">
                      <NotificationRow item={item} locale={locale} unreadLabel={t("unread")} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Pagination
            page={page}
            pageSize={NOTIFICATIONS_PAGE_SIZE}
            total={total}
            buildHref={(target) => `${notificationsPath(experience)}&page=${target}`}
          />
        </div>
      </ResultsRegion>
    </div>
  );

  // From the branch hub there is no branch: the neutral hub shell (U1).
  if (!frame) {
    const hubUser: ShellUser = {
      name: fullName(user),
      email: user.email,
      initials: personInitials(user.firstName, user.lastName),
      roleKey: "",
    };
    return (
      <HubShell user={hubUser} unreadNotifications={unread}>
        {body}
      </HubShell>
    );
  }

  return <AppShell {...frame.props}>{body}</AppShell>;
}
