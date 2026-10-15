import type { ReactNode } from "react";

import { SectionHeader } from "@/components/shared/section-header";
import { cn } from "@/lib/utils";

/**
 * A titled region of a page (docs/04-design-system.md §4 "Page rhythm", DES):
 * the heading and its content 12px apart, so the heading belongs to what
 * follows it. The page stacks sections 24px apart. Without this, a page's one
 * `gap-6` put every heading the same distance from the block above as from
 * its own — "Today", "Branch" floated between blocks instead of heading them.
 */
export function PageSection({
  title,
  description,
  action,
  className,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <SectionHeader title={title} description={description} action={action} />
      {children}
    </section>
  );
}
