import type { ReactNode } from "react";

import { ListHeader } from "@/components/shared/list-header";
import { cn } from "@/lib/utils";

/**
 * The one layout every Settings list shares (docs/04-design-system.md §14.8).
 *
 * From `md` a row is a table row with explicit columns: the name, the list's
 * own fields, **Status in its own fixed column** (it had been squeezed under
 * the Edit button), then **Actions**. The Actions header and the button group
 * share one width and are both end-aligned, so the header sits over the
 * buttons. Below `md` a row is a card: the name and its status badge on the
 * first line, the fields beneath, then a full-width action bar — two columns
 * on a phone, the odd last button spanning both.
 *
 * Buttons go in a fixed order — Edit, Deactivate / Activate, Delete where the
 * list has it — and every one is `SETTINGS_ACTION_BUTTON` wide-on-phone,
 * natural-width from `md`.
 */

/** Reserve the Actions column for the number of buttons the list shows. */
export type SettingsActionsSize = "narrow" | "default" | "wide";

const ACTIONS_WIDTH: Record<SettingsActionsSize, string> = {
  // One button (a staff member's Deactivate).
  narrow: "md:w-36",
  // Edit + Deactivate / Activate.
  default: "md:w-56",
  // Edit + Deactivate / Activate + Delete.
  wide: "md:w-80",
};

const STATUS_WIDTH = "md:w-24 md:shrink-0";

/** The class every row action button wears: 44px tall, a phone's grid cell. */
export const SETTINGS_ACTION_BUTTON = "h-11 w-full px-4 md:w-auto";

export type SettingsColumn = {
  key: string;
  label: string;
  /** Overrides the default equal `md:flex-1` share (a fixed-width column). */
  className?: string;
};

export type SettingsCell = SettingsColumn & {
  content: ReactNode;
};

export function SettingsList({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col gap-3 md:gap-0">{children}</ul>;
}

export function SettingsListHeader({
  columns,
  statusLabel,
  actionsLabel,
  actionsSize = "default",
}: {
  columns: SettingsColumn[];
  statusLabel: string;
  actionsLabel: string;
  actionsSize?: SettingsActionsSize;
}) {
  return (
    <ListHeader>
      {columns.map((column) => (
        <span key={column.key} className={cn("min-w-0", column.className ?? "flex-1")}>
          {column.label}
        </span>
      ))}
      <span className={STATUS_WIDTH}>{statusLabel}</span>
      <span className={cn("shrink-0 text-end", ACTIONS_WIDTH[actionsSize])}>
        {actionsLabel}
      </span>
    </ListHeader>
  );
}

/**
 * One read-mode row. `cells[0]` is the name: it shares the card's first line
 * with `status`. `actions` are the buttons (or forms wrapping one) in their
 * fixed order; `notice` is a result message that spans the whole row.
 */
export function SettingsListRow({
  cells,
  status,
  actions,
  actionsSize = "default",
  notice,
}: {
  cells: SettingsCell[];
  status: ReactNode;
  actions: ReactNode;
  actionsSize?: SettingsActionsSize;
  notice?: ReactNode;
}) {
  const [primary, ...fields] = cells;

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 rounded-xl border border-border p-3 md:flex md:flex-wrap md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3">
      <div
        className={cn(
          "col-start-1 row-start-1 flex min-w-0 flex-col",
          primary.className ?? "md:flex-1",
        )}
      >
        <span className="sr-only">{primary.label}</span>
        {primary.content}
      </div>

      {fields.map((cell) => (
        <div
          key={cell.key}
          className={cn("col-span-2 flex min-w-0 flex-col", cell.className ?? "md:flex-1")}
        >
          {/* The column label rides along on a card, where headers are gone;
              it stays in the accessibility tree from `md`. */}
          <span className="text-xs text-text-secondary md:sr-only">{cell.label}</span>
          {cell.content}
        </div>
      ))}

      <div
        className={cn("col-start-2 row-start-1 justify-self-end", STATUS_WIDTH, "md:justify-self-auto")}
      >
        {status}
      </div>

      <div
        className={cn(
          "col-span-2 grid grid-cols-2 gap-2 [&>:last-child:nth-child(odd)]:col-span-2",
          "md:flex md:shrink-0 md:justify-end",
          ACTIONS_WIDTH[actionsSize],
        )}
      >
        {actions}
      </div>

      {notice ? <div className="col-span-2 md:w-full md:basis-full">{notice}</div> : null}
    </li>
  );
}
