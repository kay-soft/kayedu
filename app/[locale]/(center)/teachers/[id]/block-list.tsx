"use client";

import { useActionState } from "react";
import { Ban, ShieldOff, UserMinus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  blockStudentAction,
  unblockStudentAction,
} from "@/app/[locale]/(center)/teachers/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { EmptyState } from "@/components/shared/empty-state";

export type BlockedStudent = {
  blockId: string;
  studentProfileId: string | null;
  name: string;
  studentCode: string | null;
  reason: string | null;
};

export type BlockCandidate = {
  studentProfileId: string;
  name: string;
  studentCode: string;
};

/**
 * The teacher's block-list (spec §5 "Blocking"): a student blocked here cannot
 * be enrolled with, or added to a session of, this teacher. Enforcement lands
 * with M4/M5 — `studentBlocks.isBlocked()` is the seam it plugs into.
 *
 * Blocking and unblocking are both audited (CLAUDE.md rule 7).
 */
export function BlockList({
  teacherUserId,
  blocked,
  candidates,
  query,
}: {
  teacherUserId: string;
  blocked: BlockedStudent[];
  candidates: BlockCandidate[];
  query: string;
}) {
  const t = useTranslations("Teachers.blocks");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [blockState, blockFormAction] = useActionState(
    blockStudentAction,
    IDLE_PEOPLE_STATE,
  );
  const [unblockState, unblockFormAction] = useActionState(
    unblockStudentAction,
    IDLE_PEOPLE_STATE,
  );

  const error = blockState.error ?? unblockState.error;

  return (
    <div className="flex flex-col gap-4">
      {error ? <FormMessage>{tErrors(error)}</FormMessage> : null}

      {blocked.length === 0 ? (
        <EmptyState compact icon={<ShieldOff />} title={t("empty")} description={t("emptyHint")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {blocked.map((student) => (
            <li
              key={student.blockId}
              className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">
                  {student.studentProfileId ? (
                    <Link
                      href={ROUTES.centerStudent(student.studentProfileId)}
                      className="text-brand hover:underline"
                    >
                      {student.name}
                    </Link>
                  ) : (
                    student.name
                  )}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                  {student.studentCode ? (
                    <span dir="ltr">{student.studentCode}</span>
                  ) : null}
                  {student.reason ? <span>{student.reason}</span> : null}
                </p>
              </div>

              <form action={unblockFormAction} className="shrink-0">
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="blockId" value={student.blockId} />
                <SubmitButton variant="outline" className="w-full sm:w-auto">
                  <UserMinus className="size-4" />
                  {t("unblock")}
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      )}

      {/* Candidates come from the URL search on the page — no client fetching. */}
      {query.trim().length > 0 ? (
        candidates.length === 0 ? (
          <p className="text-sm text-text-muted">{t("noCandidates")}</p>
        ) : (
          <ul className="flex flex-col gap-2 border-t border-border pt-4">
            {candidates.map((candidate) => (
              <li
                key={candidate.studentProfileId}
                className="flex flex-col gap-3 rounded-xl border border-border p-3"
              >
                <form
                  action={blockFormAction}
                  className="flex flex-col gap-3 sm:flex-row sm:items-end"
                >
                  <input type="hidden" name="locale" value={locale} />
                  <input
                    type="hidden"
                    name="teacherUserId"
                    value={teacherUserId}
                  />
                  <input
                    type="hidden"
                    name="studentProfileId"
                    value={candidate.studentProfileId}
                  />

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {candidate.name}
                    </p>
                    <p className="text-xs text-text-muted" dir="ltr">
                      {candidate.studentCode}
                    </p>
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <label
                      htmlFor={`reason-${candidate.studentProfileId}`}
                      className="text-xs font-medium text-text-secondary"
                    >
                      {t("reason")}
                    </label>
                    <Input
                      id={`reason-${candidate.studentProfileId}`}
                      name="reason"
                      maxLength={200}
                      placeholder={t("reasonPlaceholder")}
                    />
                  </div>

                  <SubmitButton variant="destructive" className="w-full sm:w-auto">
                    <Ban className="size-4" />
                    {t("block")}
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
