import type { ReactNode } from "react";
import {
  BookOpen,
  CalendarPlus,
  GraduationCap,
  UserRoundPlus,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { personInitials } from "@/lib/initials";
import { cn } from "@/lib/utils";

/**
 * One pending request in an approvals queue (docs/04-design-system.md §11.3).
 *
 * The Approvals screen carries four genuinely different asks — a teacher
 * proposing a new class, a teacher asking for a one-off session, a student
 * requesting a place, and a teacher asking to work at this branch at all —
 * and it used to render all four as the same anonymous bordered box. A
 * manager scanning the queue could not tell what kind of decision they were
 * about to make until they read the body text.
 *
 * So the *kind* is the first thing the card says: a distinct icon, a named
 * badge, and a detail grid whose fields are the ones that kind actually turns
 * on. Everything else — requester, requested-on, note, the two actions — is
 * identical across kinds on purpose, because those parts of the decision
 * genuinely are the same and should not have to be re-learned per queue.
 *
 * `kind` is a *category*, not a status, so it does not take a semantic colour
 * (docs/04 §2 reserves those for present/paid/late/absent). The icon and the
 * label carry it; the badge stays neutral.
 */
export type RequestKind =
  | "class"
  | "session"
  | "reservation"
  | "onboarding";

const KIND_ICONS: Record<RequestKind, typeof BookOpen> = {
  class: BookOpen,
  session: CalendarPlus,
  reservation: GraduationCap,
  onboarding: UserRoundPlus,
};

export type RequestDetail = {
  label: string;
  value: string;
  /** Times, dates and phone numbers stay LTR in both locales (docs/04 §7). */
  ltr?: boolean;
};

export function RequestCard({
  kind,
  kindLabel,
  requesterName,
  headline,
  requestedOn,
  details,
  note,
  actions,
}: {
  kind: RequestKind;
  kindLabel: string;
  requesterName: string;
  /** What is being asked for, in one line — subject · grade, or the class name. */
  headline: string;
  /** Already-formatted, already-localized "Requested on …" sentence. */
  requestedOn: string;
  details?: RequestDetail[];
  note?: string | null;
  actions: ReactNode;
}) {
  const Icon = KIND_ICONS[kind];
  const [first, last] = splitName(requesterName);
  const monogram = personInitials(first, last);

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 transition-ui hover:border-border-strong hover:shadow-card lg:flex-row lg:items-start lg:gap-6">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand/10 text-sm font-semibold text-brand"
        >
          {monogram === "?" ? <Icon className="size-5" /> : monogram}
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">
              {requesterName}
            </span>
            <Badge variant="neutral">
              <Icon aria-hidden />
              {kindLabel}
            </Badge>
          </div>

          <p className="text-sm text-text-secondary">{headline}</p>

          {details && details.length > 0 ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              {details.map((detail) => (
                <div key={detail.label} className="min-w-0">
                  <dt className="truncate text-[11px] font-medium text-text-muted">
                    {detail.label}
                  </dt>
                  <dd
                    className="truncate text-sm text-text-primary"
                    dir={detail.ltr ? "ltr" : undefined}
                  >
                    {detail.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          {note ? (
            <p className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-secondary">
              {note}
            </p>
          ) : null}

          <p className="text-xs text-text-muted">{requestedOn}</p>
        </div>
      </div>

      {/* Full-width on a phone so the two actions are thumb-sized; pinned to
          the card's end edge from `lg` up. */}
      <div className={cn("shrink-0 lg:pt-1")}>{actions}</div>
    </article>
  );
}

/** "Mona Kamel" → ["Mona", "Kamel"], so the monogram rule stays in one place. */
function splitName(name: string): [string, string] {
  const parts = name.trim().split(/\s+/);
  return [parts[0] ?? "", parts.length > 1 ? parts[parts.length - 1] : ""];
}
