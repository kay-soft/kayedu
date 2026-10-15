import type { ReactNode } from "react";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The body of every detail page (R10b, docs/04-design-system.md §5 "Detail
 * page"): a **main** column (two thirds from `lg`) and a **side** column (one
 * third) of cards, one column below `lg`.
 *
 * Reading order below `lg` is main, then side, then `below` — so what a person
 * came to the page to do comes first and the reference cards follow. Put the
 * work in `main` (the record, the roster, the schedule) and the facts and
 * secondary tools in `side`.
 *
 * `below` is a full-width row under both columns for a card that is a long
 * list of its own (a class's roster): it would otherwise make `main` several
 * times taller than `side` and strand the right third blank. `stickySide`
 * keeps the side column in view beside a long `main` (the session page, whose
 * receipt should stay visible while the roster is worked down); the column
 * scrolls itself if it is ever taller than the viewport.
 */
export function DetailLayout({
  main,
  side,
  below,
  stickySide,
  className,
}: {
  main: ReactNode;
  side: ReactNode;
  below?: ReactNode;
  stickySide?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">{main}</div>
        <aside
          className={cn(
            "flex min-w-0 flex-col gap-6",
            // The padding/negative margin give the cards' ring room inside the
            // scroll box, which would otherwise clip it.
            stickySide &&
              "lg:sticky lg:top-24 lg:-m-1 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:p-1",
          )}
        >
          {side}
        </aside>
      </div>
      {below}
    </div>
  );
}

/**
 * One card on a detail page: title, optional one-line description, an optional
 * control on the header's end edge, then the body. Padding, radius and border
 * come from `Card`, so every card on every detail page matches.
 */
export function DetailCard({
  title,
  description,
  icon,
  action,
  children,
  className,
  contentClassName,
}: {
  title: string;
  description?: string;
  /** A lucide icon element; drawn muted beside the title. */
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon ? (
            <span aria-hidden className="text-text-muted [&_svg]:size-4">
              {icon}
            </span>
          ) : null}
          {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className={cn("flex flex-col gap-4", contentClassName)}>
        {children}
      </CardContent>
    </Card>
  );
}
