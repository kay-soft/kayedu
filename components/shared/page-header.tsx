import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

import { LinkButton } from "@/components/shared/link-button";
import { cn } from "@/lib/utils";

/**
 * The page header every screen opens with (docs/04-design-system.md §5 "Page
 * header"): a 24px/700 title, an optional one-line description under it, and
 * the page's actions on the end edge.
 *
 * Below `sm` the actions drop under the title and wrap, so a header with two
 * buttons never pushes the title into a sliver at 375px. Actions are passed
 * as a node — a `LinkButton`, a dialog trigger, an `ActionBar` — and are laid
 * out here, so no page hand-rolls its own flex row beside the title.
 *
 * **Detail pages (R10b, §5 "Detail page")** add three optional slots so the
 * four of them open identically: `back` is the way to the list (a ghost
 * arrow-and-label above the title, mirrored in Arabic — navigation is not a
 * verb, so it stays out of the action bar), `leading` is an avatar beside the
 * title, and `meta` is the row of status badges and key facts under the
 * description. The verbs go in `action` as one `ActionBar`.
 */
export function PageHeader({
  title,
  description,
  action,
  leading,
  meta,
  back,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** An avatar or photo drawn beside the title (detail pages). */
  leading?: ReactNode;
  /** Badges and key facts under the description (detail pages). */
  meta?: ReactNode;
  /** The link back to the list, already translated. */
  back?: { href: string; label: string };
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {back ? (
        <LinkButton
          href={back.href}
          variant="ghost"
          className="-ms-3 w-fit text-text-secondary hover:text-text-primary"
        >
          <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
          {back.label}
        </LinkButton>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          {leading}
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl leading-tight font-bold text-balance text-text-primary">
              {title}
            </h1>
            {description ? (
              <p className="mt-1 max-w-prose text-sm text-text-secondary">
                {description}
              </p>
            ) : null}
            {meta ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-secondary">
                {meta}
              </div>
            ) : null}
          </div>
        </div>
        {action ? (
          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            {action}
          </div>
        ) : null}
      </div>
    </div>
  );
}
