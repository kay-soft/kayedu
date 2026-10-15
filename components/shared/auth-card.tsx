import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The one card every signed-out screen (login, register, invite,
 * select-center) sits in (docs/04-design-system.md §12). A clear heading and
 * a one-line subtitle on top, the form below — so the four screens read as
 * one flow instead of four differently-padded boxes. The brand mark and the
 * language toggle live in the auth layout around it, not in here.
 */
export function AuthCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-6 rounded-xl border border-border bg-surface p-5 shadow-card sm:p-8",
        className,
      )}
    >
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl leading-tight font-bold text-text-primary">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-text-secondary">{description}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}
