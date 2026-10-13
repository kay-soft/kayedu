"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { lookupPersonByPhoneAction } from "@/app/[locale]/(center)/teachers/actions";
import { ContactFields } from "@/components/center/contact-fields";
import { MatchPanel } from "@/components/center/match-panel";
import { PersonFields } from "@/components/center/person-fields";
import { PhoneLookupField } from "@/components/center/phone-lookup-field";
import { SectionHeader } from "@/components/shared/section-header";
import type { MatchCandidate } from "@/lib/validation/people";

/**
 * The fields of "add a teacher", shared by the Add teacher dialog
 * (`TeacherForm`) and the class dialog's "New teacher" (R6) — one set of
 * components and one zod schema (`teacherCreateSchema`), not a fork: the phone
 * lookup, the local name, the contact fields, and the duplicate-match flow.
 *
 * If the phone or email already belongs to someone on the platform, the
 * action returns the match (`serverMatch`) instead of writing anything: the
 * `MatchPanel` names them, and its "Use this person" button re-submits the
 * enclosing form carrying `linkUserId`, which links a **membership** at this
 * centre to the existing person (spec §5) — never a second identity. The
 * phone lookup does the same up front and pre-fills the form. The parent is
 * told, through `onPendingChange`, while a match is waiting to be confirmed so
 * it can hold its own submit back.
 */
export function NewTeacherFields({
  idPrefix,
  fieldErrors,
  serverMatch,
  showHeader = true,
  onPendingChange,
  pending,
}: {
  idPrefix: string;
  /** Keys under `People.errors`. */
  fieldErrors?: Record<string, string>;
  serverMatch?: MatchCandidate | null;
  showHeader?: boolean;
  onPendingChange?: (pending: boolean) => void;
  /** The enclosing form is submitting — shown on the match panel's button. */
  pending?: boolean;
}) {
  const t = useTranslations("Teachers");
  const [dismissedMatch, setDismissedMatch] = useState<string | null>(null);
  const [linkedMatch, setLinkedMatch] = useState<MatchCandidate | null>(null);

  const match = serverMatch && serverMatch.userId !== dismissedMatch ? serverMatch : null;
  const linkUserId = linkedMatch?.userId ?? match?.userId ?? null;

  useEffect(() => {
    onPendingChange?.(match !== null);
  }, [match, onPendingChange]);

  return (
    <div className="flex flex-col gap-4">
      {/* Present once staff confirm the match — this is what links. */}
      {linkUserId ? <input type="hidden" name="linkUserId" value={linkUserId} /> : null}

      {!linkedMatch ? (
        <PhoneLookupField lookup={lookupPersonByPhoneAction} onMatch={setLinkedMatch} />
      ) : null}

      {showHeader ? (
        <SectionHeader title={t("contactTitle")} description={t("contactDescription")} />
      ) : null}
      <PersonFields
        key={`person-${linkedMatch?.userId ?? "new"}`}
        idPrefix={idPrefix}
        values={
          linkedMatch
            ? {
                firstName: linkedMatch.name.split(" ")[0],
                lastName: linkedMatch.name.split(" ").slice(1).join(" "),
              }
            : undefined
        }
        fieldErrors={fieldErrors}
      />
      <ContactFields
        key={`contact-${linkedMatch?.userId ?? "new"}`}
        idPrefix={idPrefix}
        values={linkedMatch ? { phone: linkedMatch.phone ?? "", email: linkedMatch.email ?? "" } : undefined}
        fieldErrors={fieldErrors}
        atLeastOneRequired
        // R10b: the match reads straight after the phone that produced it.
        belowPhone={
          match ? (
            <MatchPanel
              match={match}
              linkLabel={t("linkAsTeacher")}
              blocked={match.existingHere === "teacher"}
              onCancel={() => setDismissedMatch(match.userId)}
              pending={pending}
            />
          ) : null
        }
      />
    </div>
  );
}
