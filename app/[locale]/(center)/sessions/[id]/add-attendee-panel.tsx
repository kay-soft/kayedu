"use client";

import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { addNewAttendeeAction } from "@/app/[locale]/(center)/sessions/actions";
import { useRequestCheckIn } from "@/app/[locale]/(center)/sessions/[id]/session-check-in-provider";
import { ContactFields } from "@/components/center/contact-fields";
import { MatchPanel } from "@/components/center/match-panel";
import { PersonFields } from "@/components/center/person-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_SESSION_STATE } from "@/lib/validation/sessions";
import { Button } from "@/components/ui/button";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

export type AttendeeCandidate = {
  studentProfileId: string;
  name: string;
  studentCode: string;
  /** A short-lived signed URL for the confirm panel, or null. */
  photoUrl: string | null;
};

/**
 * Add a student to this session (spec §4.1 item 7): an existing student found
 * by search, or a brand-new one registered on the spot and added as a
 * drop-in — reusing M3's duplicate-match flow exactly (`components/center/
 * match-panel.tsx`, `components/center/{person,contact}-fields.tsx`).
 *
 * Both paths are a check-in: the server decides Present or Late from the
 * arrival time (R2, `createAttendance`) — there is no status to pick — and
 * staff correct it from the roster (`session-roster.tsx`'s Attendance
 * control) while the session is live if that is wrong.
 *
 * T2: an **existing** student found by search is not added on the spot — the
 * row opens reception's confirm panel (`session-check-in-provider.tsx`) and
 * nothing is written until its confirm. The **new**-student form below is one
 * explicit form with its own Add button, which is its confirm; it registers the
 * person and checks them in as a drop-in, and the payment is then recorded from
 * the roster row ("Record payment").
 */
export function AddAttendeePanel({
  sessionId,
  candidates,
  hasQuery,
  canCheckIn,
}: {
  sessionId: string;
  candidates: AttendeeCandidate[];
  hasQuery: boolean;
  /** `attendance.record` and `reception.use` — what the check-in itself needs. */
  canCheckIn: boolean;
}) {
  const t = useTranslations("Sessions.addAttendee");
  const [showNewForm, setShowNewForm] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {hasQuery && canCheckIn ? (
        candidates.length === 0 ? (
          <p className="text-sm text-text-muted">{t("noCandidates")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {candidates.map((candidate) => (
              <ExistingCandidateRow key={candidate.studentProfileId} candidate={candidate} />
            ))}
          </ul>
        )
      ) : null}

      {showNewForm ? (
        <NewAttendeeForm sessionId={sessionId} onDone={() => setShowNewForm(false)} />
      ) : (
        <Button type="button" onClick={() => setShowNewForm(true)} variant="outline" className="h-11 px-4 border-dashed w-fit">
          <UserPlus className="size-4" aria-hidden />
          {t("registerNew")}
        </Button>
      )}
    </div>
  );
}

function ExistingCandidateRow({ candidate }: { candidate: AttendeeCandidate }) {
  const t = useTranslations("Sessions.addAttendee");
  const requestCheckIn = useRequestCheckIn();

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text-primary">{candidate.name}</p>
        <p className="text-xs text-text-muted" dir="ltr">
          {candidate.studentCode}
        </p>
      </div>
      <Button
        type="button"
        className="h-11 w-full px-4 sm:w-auto"
        onClick={() =>
          // Search results exclude everyone on the roster and every active
          // enrolment, so a pick here is always a drop-in.
          requestCheckIn({
            id: candidate.studentProfileId,
            name: candidate.name,
            code: candidate.studentCode,
            photoUrl: candidate.photoUrl,
            enrolled: false,
          })
        }
      >
        <UserPlus className="size-4" aria-hidden />
        {t("add")}
      </Button>
    </li>
  );
}

function NewAttendeeForm({
  sessionId,
  onDone,
}: {
  sessionId: string;
  onDone: () => void;
}) {
  const t = useTranslations("Sessions.addAttendee");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(addNewAttendeeAction, IDLE_SESSION_STATE);
  const [dismissedMatch, setDismissedMatch] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === "created") onDone();
  }, [state.status, onDone]);

  const match =
    state.status === "matchFound" &&
    state.match &&
    state.match.userId !== dismissedMatch
      ? state.match
      : null;

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-xl border border-border p-4"
      noValidate
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="sessionId" value={sessionId} />
      {match ? <input type="hidden" name="linkUserId" value={match.userId} /> : null}

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <PersonFields idPrefix="new-attendee" fieldErrors={state.fieldErrors} autoFocus />
      <ContactFields idPrefix="new-attendee" fieldErrors={state.fieldErrors} />

      {match ? (
        <MatchPanel
          match={match}
          linkLabel={t("linkAsStudent")}
          blocked={false}
          onCancel={() => setDismissedMatch(match.userId)}
        />
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <SubmitButton className="w-full sm:w-auto">{t("add")}</SubmitButton>
          <Button type="button" onClick={onDone} variant="outline" className="h-11 px-4 sm:w-auto">
            {t("cancel")}
          </Button>
        </div>
      )}
    </form>
  );
}
