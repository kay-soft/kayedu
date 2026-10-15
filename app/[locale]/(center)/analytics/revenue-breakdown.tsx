import { ListHeader } from "@/components/shared/list-header";
import { formatMoney, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export type RevenueBreakdownRow = {
  id: string;
  name: string;
  collected: number;
  centerShare: number;
  teacherShare: number;
  paymentCount: number;
};

/**
 * The by-teacher and by-branch revenue tables (spec §4.1 item 5), one layout
 * (DES, docs/04 §14.4): every figure end-aligned with two decimals and never
 * truncated — a 112px `truncate` had cut "EGP 120,00…" — and below `md` one
 * card per row, its name as the title and its figures as a two-column
 * definition list. Labels and column headers are already translated.
 */
export function RevenueBreakdown({
  rows,
  showProfit,
  locale,
  labels,
}: {
  rows: RevenueBreakdownRow[];
  showProfit: boolean;
  locale: string;
  labels: {
    name: string;
    collected: string;
    centerShare: string;
    teacherShare: string;
    payments: string;
  };
}) {
  const money = (value: number) => formatMoney(value, locale, { fixed: true });
  const figures = [
    { key: "collected", label: labels.collected, value: (row: RevenueBreakdownRow) => money(row.collected) },
    ...(showProfit
      ? [
          { key: "centerShare", label: labels.centerShare, value: (row: RevenueBreakdownRow) => money(row.centerShare) },
          { key: "teacherShare", label: labels.teacherShare, value: (row: RevenueBreakdownRow) => money(row.teacherShare) },
        ]
      : []),
    {
      key: "payments",
      label: labels.payments,
      value: (row: RevenueBreakdownRow) => formatNumber(row.paymentCount, locale),
    },
  ];
  const columns = showProfit
    ? "md:grid-cols-[minmax(0,1fr)_repeat(3,minmax(8.5rem,auto))_minmax(5rem,auto)]"
    : "md:grid-cols-[minmax(0,1fr)_minmax(8.5rem,auto)_minmax(5rem,auto)]";

  return (
    <ul className="flex flex-col gap-3 md:gap-0">
      <ListHeader className={cn("md:grid md:gap-4", columns)}>
        <span>{labels.name}</span>
        {figures.map((figure) => (
          <span key={figure.key} className="text-end">
            {figure.label}
          </span>
        ))}
      </ListHeader>

      {rows.map((row) => (
        <li
          key={row.id}
          className={cn(
            "flex flex-col gap-3 rounded-xl border border-border p-3",
            "md:grid md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3",
            columns,
          )}
        >
          <span className="truncate text-sm font-medium text-text-primary" dir="auto">
            {row.name}
          </span>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 md:contents">
            {figures.map((figure) => (
              <div key={figure.key} className="flex min-w-0 flex-col md:block md:text-end">
                <dt className="text-xs text-text-secondary md:sr-only">{figure.label}</dt>
                <dd className="text-sm whitespace-nowrap tabular-nums text-text-primary">{figure.value(row)}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
