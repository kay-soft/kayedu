"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  resolveReceptionInputAction,
  resolveReceptionStudentAction,
  searchStudentsForReceptionAction,
  type ReceptionResolution,
} from "@/app/[locale]/(center)/reception/actions";
import {
  CheckInConfirmPanel,
  type CheckInConfirmHandle,
} from "@/components/center/check-in-confirm-panel";
import type { PaymentMethodOption } from "@/components/center/payment-method-selector";
import {
  TypeAheadSearch,
  type TypeAheadHandle,
} from "@/components/center/type-ahead-search";
import { FormMessage } from "@/components/shared/form-message";
import { Ltr } from "@/components/shared/ltr";
import { RECEPTION_SEARCH_INPUT_ID } from "@/app/[locale]/(center)/reception/constants";
import type { SessionActionState } from "@/lib/validation/sessions";

type ReadyResolution = Extract<ReceptionResolution, { kind: "ready" }>;

type Panel =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ready"; ready: ReadyResolution }
  | { kind: "candidates"; students: { id: string; name: string; code: string }[] }
  | { kind: "notice"; tone: "info" | "warning" | "error"; message: string }
  | { kind: "done"; message: string };

/**
 * Session mode (R7): the selected session is fixed, so a scan or a typed
 * student goes straight to the shared **confirm panel**
 * (`components/center/check-in-confirm-panel.tsx` — photo, name, code, whether
 * they are enrolled, the session's price, a payment method) and one Enter or
 * tap records the check-in through the existing `checkInAction`. A scan alone
 * writes nothing: it only resolves who the card belongs to
 * (`resolveReceptionInputAction`), which is also where a duplicate, a blocked
 * student, a card from another branch and an unknown code are told apart.
 *
 * The input keeps the keyboard-wedge contract (`TypeAheadSearch`): the value
 * comes from the element itself, the debounce never swallows a scan, and the
 * input is emptied and refocused the instant a value is taken so the next card
 * can be scanned while the answer is still coming back. A newer scan always
 * replaces an older answer (`latest` token) and removes an open confirm panel
 * immediately — an Enter in the gap can never confirm the previous student.
 *
 * Once something is on the desk (a confirm panel, a candidate list, a notice) a
 * clear (X) control and Escape put it back to its default state; the session
 * is in this component's props, never the URL, so "keeping ?session=" is
 * simply not navigating.
 */
export function SessionCheckIn({
  sessionId,
  priceLabel,
  paymentMethods,
}: {
  sessionId: string;
  /** The session's price, formatted on the server from `Session.priceSnapshot`. */
  priceLabel: string | null;
  paymentMethods: PaymentMethodOption[];
}) {
  const t = useTranslations("Reception");
  const tErrors = useTranslations("Sessions.errors");
  const tAttendance = useTranslations("Sessions.attendance");
  const locale = useLocale();

  const controlRef = useRef<TypeAheadHandle>(null);
  const panelRef = useRef<CheckInConfirmHandle>(null);
  const latest = useRef(0);
  const [panel, setPanel] = useState<Panel>({ kind: "idle" });
  const [lastMethodId, setLastMethodId] = useState<string | null>(null);

  // The brief confirmation fades on its own; the next scan replaces it anyway.
  useEffect(() => {
    if (panel.kind !== "done") return;
    const timer = setTimeout(() => setPanel({ kind: "idle" }), 5000);
    return () => clearTimeout(timer);
  }, [panel]);

  /** Back to the default desk: drop whatever is showing and any answer still in flight. */
  const clearDesk = useCallback(() => {
    latest.current += 1;
    setPanel({ kind: "idle" });
  }, []);

  // The confirm panel owns its own Escape; a candidate list or a notice has no
  // focus of its own to carry one, so Escape clears those from here.
  useEffect(() => {
    if (panel.kind !== "candidates" && panel.kind !== "notice") return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) clearDesk();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panel.kind, clearDesk]);

  const cancelConfirm = useCallback(() => {
    setPanel({ kind: "idle" });
    controlRef.current?.focus();
  }, []);

  function saved(result: SessionActionState, methodId: string, name: string) {
    if (methodId) setLastMethodId(methodId);
    const status = tAttendance(result.attendanceStatus ?? "PRESENT");
    setPanel({
      kind: "done",
      message: result.alreadyCheckedIn
        ? t("sessionMode.alreadyCheckedInShort", { name })
        : t("sessionMode.checkedInAs", { name, status }),
    });
    controlRef.current?.clear();
  }

  function apply(resolution: ReceptionResolution) {
    switch (resolution.kind) {
      case "ready":
        setPanel({ kind: "ready", ready: resolution });
        return;
      case "candidates":
        setPanel({ kind: "candidates", students: resolution.students });
        return;
      case "already":
        setPanel({
          kind: "notice",
          tone: "info",
          message: t("sessionMode.alreadyCheckedIn", {
            name: resolution.name,
            time: resolution.time,
          }),
        });
        return;
      case "blocked":
        setPanel({
          kind: "notice",
          tone: "error",
          message: t("sessionMode.blocked", { name: resolution.name }),
        });
        return;
      case "inactive":
        setPanel({
          kind: "notice",
          tone: "warning",
          message: t("sessionMode.inactive", { name: resolution.name }),
        });
        return;
      case "notFound":
        setPanel({ kind: "notice", tone: "warning", message: t("scan.notFound") });
        return;
      case "otherBranch":
        setPanel({ kind: "notice", tone: "error", message: t("scan.otherBranch") });
        return;
      case "unreadable":
        setPanel({ kind: "notice", tone: "warning", message: t("scan.unreadable") });
        return;
      case "sessionInvalid":
        setPanel({ kind: "notice", tone: "error", message: t("sessionMode.sessionUnavailable") });
        return;
      case "forbidden":
        setPanel({ kind: "notice", tone: "error", message: tErrors("forbidden") });
        return;
      case "empty":
        setPanel({ kind: "idle" });
        return;
    }
  }

  function resolveWith(run: () => Promise<ReceptionResolution>) {
    const token = ++latest.current;
    // Whatever was open belongs to the previous scan — drop it now.
    setPanel({ kind: "busy" });
    // Free the input at once: the next card can be scanned while this answer is in flight.
    controlRef.current?.clear();
    run()
      .then((resolution) => {
        if (token === latest.current) apply(resolution);
      })
      .catch(() => {
        if (token === latest.current) {
          setPanel({ kind: "notice", tone: "error", message: t("sessionMode.failed") });
        }
      });
  }

  function onSubmitValue(value: string) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      // An empty Enter is the confirm key — only when a student is waiting.
      if (panel.kind === "ready") panelRef.current?.submit();
      return;
    }
    resolveWith(() => resolveReceptionInputAction(sessionId, trimmed, locale));
  }

  return (
    <div className="flex flex-col gap-4">
      <TypeAheadSearch
        inputId={RECEPTION_SEARCH_INPUT_ID}
        autoFocus
        controlRef={controlRef}
        label={t("searchLabel")}
        placeholder={t("sessionMode.placeholder")}
        submitLabel={t("searchSubmit")}
        size="lg"
        hideLabel
        hint={t("sessionMode.ready")}
        search={searchStudentsForReceptionAction}
        onSubmitValue={onSubmitValue}
        onSelect={(result) =>
          resolveWith(() => resolveReceptionStudentAction(sessionId, result.id, locale))
        }
        onClear={
          panel.kind === "ready" || panel.kind === "candidates" || panel.kind === "notice" || panel.kind === "busy"
            ? clearDesk
            : undefined
        }
      />

      <div aria-live="polite" className="flex flex-col gap-3">
        {panel.kind === "busy" ? (
          <p className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("sessionMode.looking")}
          </p>
        ) : null}

        {panel.kind === "notice" ? (
          <FormMessage tone={panel.tone === "error" ? "error" : panel.tone}>
            {panel.message}
          </FormMessage>
        ) : null}

        {panel.kind === "done" ? <FormMessage tone="success">{panel.message}</FormMessage> : null}

        {panel.kind === "candidates" ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-text-secondary">{t("sessionMode.pickOne")}</p>
            <ul className="flex flex-col gap-2">
              {panel.students.map((student) => (
                <li key={student.id}>
                  <button
                    type="button"
                    onClick={() =>
                      resolveWith(() => resolveReceptionStudentAction(sessionId, student.id, locale))
                    }
                    className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-start transition-ui focus-ring hover:border-border-strong hover:bg-surface-hover active:bg-surface-active"
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-text-primary">
                      {student.name}
                    </span>
                    <span className="shrink-0 text-xs text-text-secondary">
                      <Ltr>{student.code}</Ltr>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {panel.kind === "ready" ? (
        <CheckInConfirmPanel
          // A different student is a different panel (fresh method selection, no stale error).
          key={panel.ready.student.id}
          controlRef={panelRef}
          sessionId={sessionId}
          student={panel.ready.student}
          enrolled={panel.ready.enrolled}
          priceLabel={priceLabel}
          paymentMethods={paymentMethods}
          defaultMethodId={lastMethodId}
          onSaved={(result, methodId) => saved(result, methodId, panel.ready.student.name)}
          onCancel={cancelConfirm}
        />
      ) : null}
    </div>
  );
}
