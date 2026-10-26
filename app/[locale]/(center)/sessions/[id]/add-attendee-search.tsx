"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";

import { searchAddAttendeeCandidatesAction } from "@/app/[locale]/(center)/sessions/actions";
import { useRequestCheckIn } from "@/app/[locale]/(center)/sessions/[id]/session-check-in-provider";
import { TypeAheadSearch, type TypeAheadResult } from "@/components/center/type-ahead-search";

/**
 * The session page's "Add a student" search (T2). Still the shared type-ahead
 * over a plain GET form (`?q=` keeps working with no JavaScript), but choosing
 * a suggestion no longer navigates: it opens reception's confirm panel for that
 * student and writes nothing until the panel's confirm. The search function is
 * wrapped once per session in `useCallback`, so the component sees a stable
 * `search` and a re-render never re-runs the query.
 */
export function AddAttendeeSearch({ sessionId, value }: { sessionId: string; value: string }) {
  const t = useTranslations("Sessions.addAttendee");
  const requestCheckIn = useRequestCheckIn();

  const search = useCallback(
    (query: string) => searchAddAttendeeCandidatesAction(sessionId, query),
    [sessionId],
  );

  function pick(result: TypeAheadResult) {
    requestCheckIn({
      id: result.id,
      name: result.primary,
      code: result.secondary ?? "",
      photoUrl: result.photoUrl ?? null,
      // The search leaves out everyone on the roster and every active
      // enrolment, so whoever is picked here is a drop-in.
      enrolled: false,
    });
  }

  return (
    <TypeAheadSearch
      value={value}
      label={t("searchLabel")}
      placeholder={t("searchPlaceholder")}
      submitLabel={t("searchSubmit")}
      search={search}
      onSelect={pick}
    />
  );
}
