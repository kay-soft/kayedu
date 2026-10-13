"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  checkInAction,
  resolveReceptionInputAction,
  resolveReceptionStudentAction,
  searchStudentsForReceptionAction,
  type ReceptionResolution,
} from "@/app/[locale]/(center)/reception/actions";
import {
  PaymentMethodSelector,
  type PaymentMethodOption,
} from "@/components/center/payment-method-selector";
import {
  TypeAheadSearch,
  type TypeAheadHandle,
} from "@/components/center/type-ahead-search";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RECEPTION_SEARCH_INPUT_ID } from "@/app/[locale]/(center)/reception/constants";
import { IDLE_SESSION_STATE } from "@/lib/validation/sessions";

type ReadyResolution = Extract<ReceptionResolution, { kind: "ready" }>;

type Panel =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ready"; ready: ReadyResolution; error?: string }
  | { kind: "candidates"; students: { id: string; name: string; code: string }[] }
  | { kind: "notice"; tone: "info" | "warning" | "error"; message: string }
  | { kind: "done"; message: string };

/**
 * Session mode (R7): the selected session is fixed, so a scan or a typed
 * student goes straight to a **confirm panel** — photo, name, code, whether
 * they are enrolled, the session's price, a payment method — and one Enter or
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
  const formRef = useRef<HTMLFormElement>(null);
  const latest = useRef(0);
  const confirming = useRef(false);
  const [panel, setPanel] = useState<Panel>({ kind: "idle" });
  const [lastMethodId, setLastMethodId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The brief confirmation fades on its own; the next scan replaces it anyway.
  useEffect(() => {
    if (panel.kind !== "done") return;
    const timer = setTimeout(() => setPanel({ kind: "idle" }), 5000);
    return () => clearTimeout(timer);
  }, [panel]);

  // Escape abandons an open confirm panel and hands the keyboard back to the input.
  useEffect(() => {
    if (panel.kind !== "ready") return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setPanel({ kind: "idle" });
      controlRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panel.kind]);

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
      if (panel.kind === "ready" && !confirming.current) formRef.current?.requestSubmit();
      return;
    }
    resolveWith(() => resolveReceptionInputAction(sessionId, trimmed, locale));
  }

  function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panel.kind !== "ready" || confirming.current) return;
    confirming.current = true;
    const formData = new FormData(event.currentTarget);
    const methodId = String(formData.get("paymentMethodId") ?? "");
    const { ready } = panel;

    startTransition(async () => {
      try {
        const result = await checkInAction(IDLE_SESSION_STATE, formData);
        if (result.error) {
          setPanel({ kind: "ready", ready, error: result.error });
          return;
        }
        if (methodId) setLastMethodId(methodId);
        const status = tAttendance(result.attendanceStatus ?? "PRESENT");
        setPanel({
          kind: "done",
          message: result.alreadyCheckedIn
            ? t("sessionMode.alreadyCheckedInShort", { name: ready.student.name })
            : t("sessionMode.checkedInAs", { name: ready.student.name, status }),
        });
        controlRef.current?.clear();
      } catch {
        setPanel({ kind: "ready", ready, error: "failed" });
      } finally {
        confirming.current = false;
      }
    });
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
        search={searchStudentsForReceptionAction}
        onSubmitValue={onSubmitValue}
        onSelect={(result) =>
          resolveWith(() => resolveReceptionStudentAction(sessionId, result.id, locale))
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
                    <span className="shrink-0 text-xs text-text-muted" dir="ltr">
                      {student.code}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {panel.kind === "ready" ? (
        <form
          ref={formRef}
          onSubmit={confirm}
          className="flex flex-col gap-4 rounded-xl border border-brand/30 bg-brand/5 p-4"
        >
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="sessionId" value={sessionId} />
          <input type="hidden" name="studentProfileId" value={panel.ready.student.id} />

          <div className="flex items-center gap-4">
            {panel.ready.student.photoUrl ? (
              // A short-lived signed Storage URL, not a static/remote asset next/image can optimize.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={panel.ready.student.photoUrl}
                alt=""
                className="size-20 shrink-0 rounded-full border border-border object-cover"
              />
            ) : (
              <span className="flex size-20 shrink-0 items-center justify-center rounded-full border border-border bg-surface-subtle text-text-muted">
                <UserRound className="size-8" aria-hidden />
              </span>
            )}
            <div className="flex min-w-0 flex-col gap-1.5">
              <p className="truncate text-lg font-semibold text-text-primary">
                {panel.ready.student.name}
              </p>
              <p className="text-sm text-text-secondary">
                {t("sessionMode.code")}{" "}
                <span className="font-medium tabular-nums" dir="ltr">
                  {panel.ready.student.code}
                </span>
              </p>
              <Badge variant={panel.ready.enrolled ? "success" : "warning"}>
                {panel.ready.enrolled ? t("sessionMode.enrolled") : t("sessionMode.dropIn")}
              </Badge>
            </div>
          </div>

          {priceLabel ? (
            <p className="flex items-baseline justify-between gap-3 rounded-lg bg-surface px-3 py-2 text-sm">
              <span className="text-text-secondary">{t("sessionMode.price")}</span>
              <span className="font-semibold tabular-nums text-text-primary">{priceLabel}</span>
            </p>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-secondary">{t("methodLabel")}</span>
            <PaymentMethodSelector methods={paymentMethods} defaultMethodId={lastMethodId} />
            <p className="text-xs text-text-muted">{t("statusAuto")}</p>
          </div>

          {panel.error ? (
            <FormMessage>
              {panel.error === "failed" ? t("sessionMode.failed") : tErrors(panel.error)}
            </FormMessage>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            <p className="text-xs text-text-muted sm:me-auto">{t("sessionMode.enterHint")}</p>
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full px-5 sm:w-auto"
              onClick={() => {
                setPanel({ kind: "idle" });
                controlRef.current?.focus();
              }}
            >
              {t("sessionMode.cancel")}
            </Button>
            <Button type="submit" disabled={pending} className="h-11 w-full px-5 sm:w-auto">
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("submit")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
