"use client";

import type { ComponentProps } from "react";
import { useLinkStatus } from "next/link";

import { Link } from "@/lib/i18n/navigation";
import { useReportUrlPending } from "@/lib/ui/url-pending";

/** Lives inside the `<Link>` — `useLinkStatus` reads the nearest one. */
function LinkPending() {
  const { pending } = useLinkStatus();
  useReportUrlPending(pending);
  return null;
}

/**
 * A link that changes URL state — a pager, a filter tab, a reset
 * (docs/02-architecture.md §14). It is the ordinary next-intl `Link` — still a
 * real `href` (shareable, works without JavaScript, still prefetched) — with
 * the two things URL state needs: `scroll={false}`, so the scroll position is
 * kept, and a pending flag, so `ResultsRegion` dims the results while the next
 * ones load.
 */
export function SoftLink({
  children,
  scroll = false,
  ...props
}: ComponentProps<typeof Link>) {
  return (
    <Link scroll={scroll} {...props}>
      <LinkPending />
      {children}
    </Link>
  );
}
