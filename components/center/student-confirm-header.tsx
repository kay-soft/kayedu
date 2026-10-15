import type { ReactNode } from "react";
import { UserRound } from "lucide-react";

import { Ltr } from "@/components/shared/ltr";

/**
 * Who is being checked in (docs/04 §14.5) — the same identity block on the
 * desk's two paths. The photo is the anti-impersonation control the static
 * QR decision rests on (spec §5.1), so it is 80px and leads; the name is the
 * heading; the code is an isolated LTR run. Student-first had shown a 56px
 * photo and the name inside a muted sentence.
 */
export function StudentConfirmHeader({
  name,
  code,
  codeLabel,
  photoUrl,
  badge,
}: {
  name: string;
  code: string;
  /** Already translated ("Code"). */
  codeLabel: string;
  /** A short-lived signed URL, or null with no photo on file. */
  photoUrl: string | null;
  badge?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4">
      {photoUrl ? (
        // A short-lived signed Storage URL, not a static/remote asset next/image can optimize.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl}
          alt=""
          className="size-20 shrink-0 rounded-full border border-border object-cover"
        />
      ) : (
        <span className="flex size-20 shrink-0 items-center justify-center rounded-full border border-border bg-surface-subtle text-text-muted">
          <UserRound className="size-8" aria-hidden />
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="truncate text-lg font-semibold text-text-primary" dir="auto">
          {name}
        </p>
        <p className="text-sm text-text-secondary">
          {codeLabel}{" "}
          <span className="font-medium tabular-nums text-text-primary">
            <Ltr>{code}</Ltr>
          </span>
        </p>
        {badge}
      </div>
    </div>
  );
}
