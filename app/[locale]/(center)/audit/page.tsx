import { ScrollText } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { Pagination } from "@/components/center/pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SoftLink } from "@/components/shared/soft-link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { AUDIT_FILTERS, loadAuditFeed, loadUnpaidCheckIns, type AuditFilter } from "@/lib/db/audit-feed";
import { prisma } from "@/lib/db/client";
import { visibilityWindowFloor } from "@/lib/db/visibility";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@/lib/format";
import { fullName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone } from "@/lib/scheduling";
import { cn } from "@/lib/utils";
import { parsePageParam } from "@/lib/validation/people";
import { ResultsRegion } from "@/components/shared/results-region";

const PAGE_SIZE = 50;

/** Money and status fields an audit row may carry, shown as "before → after". */
const DIFF_KEYS = [
  "price",
  "centerShareType",
  "centerShareValue",
  "defaultShareType",
  "defaultShareValue",
  "basePrice",
  "priceSnapshot",
  "status",
  "attendanceStatus",
  "totalAmount",
  "timezone",
] as const;

const MONEY_KEYS = new Set(["price", "defaultShareValue", "basePrice", "priceSnapshot", "totalAmount"]);

/**
 * The centre audit trail (SEC-2b, D-06 (a), SEC-07): who voided what and why,
 * every switch to Absent, every refund, every settlement transition, every
 * price or centre-cut change — and, separately, every present-but-unpaid
 * check-in. `audit.view` (OWNER/MANAGER by default), centre-scoped.
 *
 * The trail is carved out of the data-visibility window (an audit trail you
 * cannot read past last month is not one); the unpaid list is attendance and
 * stays inside it. Rows carry ids and amounts only (D-20): names and reasons
 * come from the records they name. Stacked cards at every width — nothing
 * scrolls sideways (docs/04 §6).
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; page?: string }>;
}) {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "audit.view");

  const params = await searchParams;
  const filter: AuditFilter = (AUDIT_FILTERS as readonly string[]).includes(params.kind ?? "")
    ? (params.kind as AuditFilter)
    : "all";
  const page = parsePageParam(params.page);
  const pageRange = { take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE };

  const t = await getTranslations("Audit");
  const locale = await getLocale();
  const timeZone = centreTimeZone(ctx.settings);

  const feed =
    filter === "unpaid"
      ? null
      : await loadAuditFeed(prisma, ctx.center.id, filter, pageRange);
  const unpaid =
    filter === "unpaid"
      ? await loadUnpaidCheckIns(prisma, ctx.center.id, visibilityWindowFloor(ctx), pageRange)
      : null;
  const total = feed?.total ?? unpaid?.total ?? 0;

  const hrefFor = (kind: AuditFilter, targetPage = 1) => {
    const query = new URLSearchParams();
    if (kind !== "all") query.set("kind", kind);
    if (targetPage > 1) query.set("page", String(targetPage));
    const qs = query.toString();
    return qs ? `${ROUTES.centerAudit}?${qs}` : ROUTES.centerAudit;
  };

  // DES: a status or cut-type value is translated — the trail had shown the
  // raw enum ("CANCELLED"), in English inside the Arabic UI.
  const diffValue = (key: string, value: unknown): string =>
    typeof value === "number" && MONEY_KEYS.has(key)
      ? formatMoney(value, locale)
      : value === null || value === undefined
        ? "—"
        : typeof value === "string" && t.has(`status.${value}`)
          ? t(`status.${value}`)
          : typeof value === "number"
            ? formatNumber(value, locale)
            : String(value);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      {/* Filter tabs: real links, soft-navigated (docs/02 §14) — a tab changes
          the trail in place and Back returns to the previous one. */}
      <nav aria-label={t("filtersLabel")} className="flex flex-wrap gap-2">
        {AUDIT_FILTERS.map((kind) => (
          <SoftLink
            key={kind}
            href={hrefFor(kind)}
            aria-current={kind === filter ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-ui-fast",
              kind === filter
                ? "border-brand bg-brand text-brand-foreground"
                : "border-border bg-surface text-text-secondary hover:border-brand hover:text-text-primary",
            )}
          >
            {t(`filters.${kind}`)}
          </SoftLink>
        ))}
      </nav>

      <ResultsRegion className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t(`filters.${filter}`)}</CardTitle>
            <CardDescription>{filter === "unpaid" ? t("unpaidDescription") : t("trailDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {total === 0 ? (
              <EmptyState icon={<ScrollText />} title={t("empty")} description={t("emptyHint")} />
            ) : null}

            {feed?.entries.map((entry) => {
              const changed = DIFF_KEYS.filter(
                (key) =>
                  (entry.before && key in entry.before) || (entry.after && key in entry.after),
              ).filter((key) => entry.before?.[key] !== entry.after?.[key]);
              return (
                <article key={entry.id} className="flex flex-col gap-1 rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                      {/* Never the raw action key (it had shown "classGroup.deactivate"). */}
                      {t.has(`actions.${entry.action}`) ? t(`actions.${entry.action}`) : t("unknownAction")}
                      {entry.action.endsWith(".void") ? <Badge variant="danger">{t("status.voided")}</Badge> : null}
                      {entry.selfApproved ? <Badge variant="warning">{t("selfApproved")}</Badge> : null}
                    </p>
                    {entry.amount !== null ? (
                      <p className="text-sm font-medium tabular-nums text-text-primary">
                        {formatMoney(entry.amount, locale)}
                      </p>
                    ) : null}
                  </div>
                  <p className="text-xs text-text-secondary">
                    {t("meta", {
                      time: formatDateTime(entry.createdAt, locale, timeZone),
                      name: entry.actorName ? fullName(entry.actorName) : t("system"),
                    })}
                  </p>
                  {entry.subjectName ? (
                    <p className="text-sm text-text-primary" dir="auto">{fullName(entry.subjectName)}</p>
                  ) : null}
                  {entry.reason ? (
                    <p className="text-xs text-text-secondary">{t("reason", { reason: entry.reason })}</p>
                  ) : null}
                  {changed.length > 0 ? (
                    <ul className="flex flex-col gap-0.5 text-xs text-text-secondary">
                      {changed.map((key) => (
                        <li key={key} className="break-words">
                          {entry.before?.[key] === undefined || entry.before?.[key] === null
                            ? t("diffSet", {
                                field: t.has(`fields.${key}`) ? t(`fields.${key}`) : key,
                                after: diffValue(key, entry.after?.[key]),
                              })
                            : t("diff", {
                                field: t.has(`fields.${key}`) ? t(`fields.${key}`) : key,
                                before: diffValue(key, entry.before?.[key]),
                                after: diffValue(key, entry.after?.[key]),
                              })}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {entry.sessionId ? (
                    <Link
                      href={ROUTES.centerSession(entry.sessionId)}
                      className="inline-flex min-h-11 w-fit items-center text-sm font-medium text-brand hover:underline"
                    >
                      {t("openSession")}
                    </Link>
                  ) : null}
                </article>
              );
            })}

            {unpaid?.rows.map((row) => (
              <article key={row.attendeeId} className="flex flex-col gap-1 rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-text-primary">{fullName(row.studentName)}</p>
                  <Badge variant="warning">{t(`status.${row.status}`)}</Badge>
                </div>
                <p className="text-xs text-text-secondary">
                  {t("unpaidMeta", {
                    date: formatDate(row.sessionDate, locale),
                    name: row.recordedByName ? fullName(row.recordedByName) : t("system"),
                    time: formatDateTime(row.recordedAt, locale, timeZone),
                  })}
                </p>
                <Link
                  href={ROUTES.centerSession(row.sessionId)}
                  className="inline-flex min-h-11 w-fit items-center text-sm font-medium text-brand hover:underline"
                >
                  {t("openSession")}
                </Link>
              </article>
            ))}

            <Pagination page={page} pageSize={PAGE_SIZE} total={total} buildHref={(target) => hrefFor(filter, target)} />
          </CardContent>
        </Card>
      </ResultsRegion>
    </div>
  );
}
