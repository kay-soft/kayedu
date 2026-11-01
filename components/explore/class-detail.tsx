import type { ReactNode } from "react";
import { PausedNote } from "@/components/explore/paused-note";
import { getLocale, getTranslations } from "next-intl/server";
import { Building2, CalendarDays, Clock, GraduationCap, UserRound, Wallet } from "lucide-react";

import { Link } from "@/lib/i18n/navigation";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClassCardBadge } from "@/components/explore/class-card";
import { formatDate, formatMoney, formatRating, formatTimeRange } from "@/lib/format";

export type ClassDetailProps = {
  /** U9 — the class cover, else the teacher's photo at this branch (signing-route path), else null. */
  imageUrl?: string | null;
  gradeName: string | null;
  /** `pausedUntil` (U5): a platform admin's pause covers the branch's today. */
  branch: { name: string; href?: string; logoUrl: string | null; themeColor: string; pausedUntil?: Date | null };
  teacher: { name: string; href?: string; rating: number | null };
  schedules: { dayOfWeek: number; startTime: string; endTime: string }[];
  startDate: Date;
  endDate: Date;
  /** Piastres per session. */
  price: number;
  requiresConfirmation: boolean;
  badge: ClassCardBadge;
  /** Enrol / Request to join / sign in to enrol / a status. */
  action: ReactNode;
};

/**
 * The body of a class page (F5), shared by the public Explore class page and
 * the signed-in Discover class page — the page owns its header and decides
 * the action; this draws the facts. Nothing here is a person's contact, a
 * student or a count: seats arrive as a badge (docs/04 §11.24).
 */
export async function ClassDetail({
  imageUrl,
  gradeName,
  branch,
  teacher,
  schedules,
  startDate,
  endDate,
  price,
  requiresConfirmation,
  badge,
  action,
}: ClassDetailProps) {
  const locale = await getLocale();
  const t = await getTranslations("Explore.class");
  const tCard = await getTranslations("Explore.card");
  const tClasses = await getTranslations("Classes");
  const dayNames = tClasses.raw("dayNames") as string[];

  const linkClass = "rounded-sm font-medium text-text-primary focus-ring hover:text-brand hover:underline";

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="overflow-hidden lg:col-span-2">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- private-media signing route, not optimisable by next/image
          <img src={imageUrl} alt="" className="aspect-[16/9] max-h-72 w-full bg-surface-subtle object-cover object-top" />
        ) : null}
        <CardHeader>
          <CardTitle>{t("detailsTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact icon={<Building2 className="size-4" aria-hidden />} label={t("branch")}>
              <span className="flex items-center gap-2">
                <BrandAvatar name={branch.name} logoUrl={branch.logoUrl} themeColor={branch.themeColor} size="sm" />
                {branch.href ? (
                  <Link href={branch.href} className={linkClass}>
                    {branch.name}
                  </Link>
                ) : (
                  <span className="font-medium">{branch.name}</span>
                )}
              </span>
              {branch.pausedUntil ? <PausedNote until={branch.pausedUntil} className="mt-1" /> : null}
            </Fact>

            <Fact icon={<UserRound className="size-4" aria-hidden />} label={t("teacher")}>
              <span className="flex flex-wrap items-center gap-x-2">
                {teacher.href ? (
                  <Link href={teacher.href} className={linkClass}>
                    {teacher.name}
                  </Link>
                ) : (
                  <span className="font-medium">{teacher.name}</span>
                )}
                {teacher.rating !== null ? (
                  <span className="text-sm text-text-muted">
                    {tCard("rating", { value: formatRating(teacher.rating, locale) })}
                  </span>
                ) : null}
              </span>
            </Fact>

            {gradeName ? (
              <Fact icon={<GraduationCap className="size-4" aria-hidden />} label={t("grade")}>
                {gradeName}
              </Fact>
            ) : null}

            <Fact icon={<CalendarDays className="size-4" aria-hidden />} label={t("period")}>
              {t("periodValue", { from: formatDate(startDate, locale), to: formatDate(endDate, locale) })}
            </Fact>

            <Fact icon={<Clock className="size-4" aria-hidden />} label={t("schedule")} wide>
              {schedules.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {schedules.map((slot) => (
                    <li key={`${slot.dayOfWeek}-${slot.startTime}`}>
                      <span className="font-medium">{dayNames[slot.dayOfWeek]}</span>{" "}
                      <span className="text-text-secondary">
                        {formatTimeRange(slot.startTime, slot.endTime, locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                tCard("noSchedule")
              )}
            </Fact>
          </dl>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>{t("joinTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm text-text-secondary">
              <Wallet className="size-4" aria-hidden />
              {t("price")}
            </span>
            <span className="text-lg font-semibold text-text-primary">
              {tCard("perSession", { price: formatMoney(price, locale) })}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-text-secondary">{t("status")}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
          <p className="text-sm text-text-muted">
            {requiresConfirmation ? t("joinApproval") : t("joinInstant")}
          </p>
          {action}
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({
  icon,
  label,
  wide,
  children,
}: {
  icon: ReactNode;
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? "flex flex-col gap-1 sm:col-span-2" : "flex flex-col gap-1"}>
      <dt className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
        {icon}
        {label}
      </dt>
      <dd className="text-sm text-text-primary">{children}</dd>
    </div>
  );
}
