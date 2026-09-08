"use client";

import { useActionState } from "react";
import { Ban, ShieldOff, UserMinus, UserPlus, UserX, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  blockEnrollmentAction,
  enrollStudentAction,
  removeEnrollmentAction,
  unblockEnrollmentAction,
} from "@/app/[locale]/(center)/classes/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";
import { EmptyState } from "@/components/shared/empty-state";

export type RosterRow = {
  enrollmentId: string;
  studentProfileId: string;
  name: string;
  studentCode: string;
};

export type BlockedRow = {
  blockId: string;
  studentProfileId: string | null;
  name: string;
  studentCode: string | null;
  reason: string | null;
};

export type EnrollCandidate = {
  studentProfileId: string;
  name: string;
  studentCode: string;
};

/**
 * A class's roster (spec §5 "Reservations / enrollment", "Blocking"): who is
 * actively enrolled, who is blocked from this specific class, and the
 * search-to-enroll surface — capacity and duplicate-enrollment are enforced
 * server-side in `enrollStudentAction`, never trusted from this form.
 */
export function ClassRoster({
  classGroupId,
  roster,
  blocked,
  candidates,
  query,
}: {
  classGroupId: string;
  roster: RosterRow[];
  blocked: BlockedRow[];
  candidates: EnrollCandidate[];
  query: string;
}) {
  const t = useTranslations("Classes.roster");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();

  const [enrollState, enrollAction] = useActionState(
    enrollStudentAction,
    IDLE_CLASS_STATE,
  );
  const [removeState, removeAction] = useActionState(
    removeEnrollmentAction,
    IDLE_CLASS_STATE,
  );
  const [blockState, blockAction] = useActionState(
    blockEnrollmentAction,
    IDLE_CLASS_STATE,
  );
  const [unblockState, unblockAction] = useActionState(
    unblockEnrollmentAction,
    IDLE_CLASS_STATE,
  );

  const error =
    enrollState.error ?? removeState.error ?? blockState.error ?? unblockState.error;

  return (
    <div className="flex flex-col gap-6">
      {error ? <FormMessage>{tErrors(error)}</FormMessage> : null}

      <div>
        <p className="mb-2 text-sm font-medium text-text-primary">
          {t("activeTitle", { count: roster.length })}
        </p>
        {roster.length === 0 ? (
          <EmptyState compact icon={<Users />} title={t("empty")} description={t("emptyHint")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {roster.map((row) => (
              <li
                key={row.enrollmentId}
                className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <Link
                    href={ROUTES.centerStudent(row.studentProfileId)}
                    className="truncate text-sm font-medium text-brand hover:underline"
                  >
                    {row.name}
                  </Link>
                  <p className="text-xs text-text-muted" dir="ltr">
                    {row.studentCode}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                  <form action={removeAction}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="enrollmentId" value={row.enrollmentId} />
                    <SubmitButton variant="outline" className="w-full sm:w-auto">
                      <UserMinus className="size-4" />
                      {t("remove")}
                    </SubmitButton>
                  </form>

                  <form action={blockAction}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="classGroupId" value={classGroupId} />
                    <input
                      type="hidden"
                      name="studentProfileId"
                      value={row.studentProfileId}
                    />
                    <SubmitButton variant="destructive" className="w-full sm:w-auto">
                      <Ban className="size-4" />
                      {t("block")}
                    </SubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border pt-4">
        <p className="mb-2 text-sm font-medium text-text-primary">
          {t("blockedTitle", { count: blocked.length })}
        </p>
        {blocked.length === 0 ? (
          <EmptyState compact icon={<ShieldOff />} title={t("blockedEmpty")} description={t("blockedEmptyHint")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {blocked.map((row) => (
              <li
                key={row.blockId}
                className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">
                    {row.studentProfileId ? (
                      <Link
                        href={ROUTES.centerStudent(row.studentProfileId)}
                        className="text-brand hover:underline"
                      >
                        {row.name}
                      </Link>
                    ) : (
                      row.name
                    )}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                    {row.studentCode ? <span dir="ltr">{row.studentCode}</span> : null}
                    {row.reason ? <span>{row.reason}</span> : null}
                  </p>
                </div>
                <form action={unblockAction} className="shrink-0">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="blockId" value={row.blockId} />
                  <SubmitButton variant="outline" className="w-full sm:w-auto">
                    <UserX className="size-4" />
                    {t("unblock")}
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Candidates come from the URL search on the page — no client fetching. */}
      {query.trim().length > 0 ? (
        <div className="border-t border-border pt-4">
          <p className="mb-2 text-sm font-medium text-text-primary">
            {t("candidatesTitle")}
          </p>
          {candidates.length === 0 ? (
            <p className="text-sm text-text-muted">{t("noCandidates")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {candidates.map((candidate) => (
                <li
                  key={candidate.studentProfileId}
                  className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {candidate.name}
                    </p>
                    <p className="text-xs text-text-muted" dir="ltr">
                      {candidate.studentCode}
                    </p>
                  </div>
                  <form action={enrollAction} className="shrink-0">
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="classGroupId" value={classGroupId} />
                    <input
                      type="hidden"
                      name="studentProfileId"
                      value={candidate.studentProfileId}
                    />
                    <SubmitButton className="w-full sm:w-auto">
                      <UserPlus className="size-4" />
                      {t("enroll")}
                    </SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
