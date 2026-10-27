"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

import { searchStudentsForReceptionAction } from "@/app/[locale]/(center)/reception/actions";
import { RECEPTION_SEARCH_INPUT_ID } from "@/app/[locale]/(center)/reception/constants";
import { TypeAheadSearch, type TypeAheadHandle } from "@/components/center/type-ahead-search";
import { useRouter } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * The desk's find / scan field in plain (student-first) mode. It is the shared
 * `TypeAheadSearch` — still a plain GET form underneath, so the scanner's
 * "type fast, press Enter" submit is untouched — plus, **once a student is
 * selected**, a clear (X) control and Escape that return the desk to its
 * default state: the selection lives in the URL (`?studentId=` / `?q=`), so
 * clearing is a navigation to the bare desk.
 *
 * (Session mode never uses this: there the session is fixed and "clear" just
 * drops the confirm panel — `session-check-in.tsx` — without leaving the
 * session.)
 */
export function ReceptionSearch({
  value,
  hasSelection,
}: {
  value: string;
  /** A student is selected — the confirm form is showing. */
  hasSelection: boolean;
}) {
  const t = useTranslations("Reception");
  const router = useRouter();
  const controlRef = useRef<TypeAheadHandle>(null);

  function clearDesk() {
    router.push(ROUTES.centerReception);
  }

  // Escape from anywhere on the desk (the session picker, the method buttons),
  // not only from inside the input — but never one that belongs to an open dialog.
  useEffect(() => {
    if (!hasSelection) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      // Empty the field too (the page keeps this component mounted across the
      // navigation) and hand the keyboard back to it for the next scan.
      controlRef.current?.clear();
      router.push(ROUTES.centerReception);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hasSelection, router]);

  return (
    <TypeAheadSearch
      size="lg"
      hideLabel
      inputId={RECEPTION_SEARCH_INPUT_ID}
      autoFocus
      controlRef={controlRef}
      // The scanner's submit stays the full-page GET it was verified against
      // (docs/04 §11.8 "Scanner contract"); T4's soft submit is not applied here.
      softSubmit={false}
      value={value}
      label={t("searchLabel")}
      placeholder={t("searchPlaceholder")}
      submitLabel={t("searchSubmit")}
      search={searchStudentsForReceptionAction}
      onClear={hasSelection ? clearDesk : undefined}
    />
  );
}
