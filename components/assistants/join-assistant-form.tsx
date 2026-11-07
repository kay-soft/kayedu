"use client";

import { startTransition, useEffect, useState } from "react";
import { Loader2, UserCog } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { previewAssistantCodeAction, redeemAssistantCodeAction } from "@/app/[locale]/account/assistant-actions";
import { AssistantPermissionList } from "@/components/assistants/assistant-permission-list";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_ASSISTANT_JOIN_STATE, type AssistantJoinState } from "@/lib/validation/assistants";

/** Where a code waits while a guest signs in or signs up (this tab only, never a server). */
const PENDING_CODE_KEY = "kayedu.assistantJoinCode";

function readStoredCode(): string {
  try {
    return window.sessionStorage.getItem(PENDING_CODE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Whether the tab kept the code. Blocked storage (a private window) only means typing it again. */
function storeCode(code: string): boolean {
  try {
    if (code) window.sessionStorage.setItem(PENDING_CODE_KEY, code);
    else window.sessionStorage.removeItem(PENDING_CODE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Redeeming an assistant code (W7a, D-W36, docs/04 §11.36) — two steps, and
 * nothing links without the second:
 *
 * 1. **Continue** posts the code to the preview, which writes nothing and
 *    answers the teacher's name and the preset's permissions (or one message
 *    for any unusable code).
 * 2. The confirmation shows them; only **Confirm** posts the code again to the
 *    redemption, which re-checks everything on the server. **Cancel** goes
 *    back with nothing written.
 *
 * `join` — the `/assistant-join` page. The code may arrive in the URL
 * **fragment** (`#CODE`, never sent to a server), is kept in this tab's
 * `sessionStorage` across signing in or creating an account (the links carry
 * only `next=/assistant-join`), and is wiped from the address bar at once. On
 * success it opens the new assistant experience.
 *
 * `account` — Account settings → "Join as an assistant": the same steps,
 * staying on the page.
 */
export function JoinAssistantForm({
  mode,
  signedIn,
  signInHref,
  registerHref,
}: {
  mode: "join" | "account";
  signedIn: boolean;
  /** Locale-less paths with `?next=/assistant-join` (guests only). */
  signInHref?: string;
  registerHref?: string;
}) {
  const t = useTranslations("Assistants.join");
  const tPresets = useTranslations("Assistants.presets");
  const tErrors = useTranslations("Assistants.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [dismissed, setDismissed] = useState<AssistantJoinState | null>(null);
  const [lastStep, setLastStep] = useState<"preview" | "redeem">("preview");
  const [preview, previewAction, previewPending] = useGuardedActionState(previewAssistantCodeAction, IDLE_ASSISTANT_JOIN_STATE);
  const [redeem, redeemAction, redeemPending] = useGuardedActionState(redeemAssistantCodeAction, IDLE_ASSISTANT_JOIN_STATE);
  useActionFeedback(redeem, { success: (status) => (status === "joined" ? tToasts("assistantJoined") : null) });

  useEffect(() => {
    if (mode !== "join") return;
    const fromHash = decodeURIComponent(window.location.hash.replace(/^#/, "")).trim();
    if (fromHash) {
      storeCode(fromHash);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    const initial = fromHash || readStoredCode();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fragment exists only in the browser, after mount
    if (initial) setCode(initial);
  }, [mode]);

  useEffect(() => {
    if (redeem.status !== "joined") return;
    storeCode("");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the field once the link is made
    setCode("");
    if (mode === "join" && redeem.teacherUserId) router.push(ROUTES.assistantHome(redeem.teacherUserId));
  }, [redeem, mode, router]);

  const joined = lastStep === "redeem" && redeem.status === "joined";
  // The confirmation stays up while its Confirm is pending; a refused Confirm
  // goes back to the field with the reason, and a new Continue starts over.
  const confirming =
    !joined &&
    (lastStep === "preview" || redeemPending) &&
    preview.status === "preview" &&
    Boolean(preview.preview) &&
    dismissed !== preview;
  const error = lastStep === "redeem" ? redeem.error : dismissed !== preview ? preview.error : undefined;
  const fieldError = lastStep === "preview" && preview.fieldErrors?.code ? tErrors(preview.fieldErrors.code) : undefined;
  const id = `assistant-code-${mode}`;

  const post = (step: "preview" | "redeem", action: (formData: FormData) => void) => {
    setLastStep(step);
    const formData = new FormData();
    formData.set("locale", locale);
    formData.set("code", code);
    startTransition(() => action(formData));
  };

  if (confirming && preview.preview) {
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-border p-4" role="group" aria-labelledby={`${id}-confirm-title`}>
        <div className="flex flex-col gap-1">
          <h4 id={`${id}-confirm-title`} className="text-base font-semibold break-words text-text-primary">
            {t("confirmTitle", { teacher: preview.preview.teacherName })}
          </h4>
          <p className="text-sm text-text-secondary">{t("confirmDescription")}</p>
        </div>
        <p className="text-sm text-text-primary">
          {t("presetLine", { preset: tPresets(`${preview.preview.preset}.label`) })}
        </p>
        <AssistantPermissionList permissions={preview.preview.permissions} />
        <p className="text-xs text-text-muted">{t("confirmNote")}</p>
        <div className="grid gap-2 sm:flex sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={redeemPending}
            onClick={() => setDismissed(preview)}
          >
            {t("cancel")}
          </Button>
          <Button type="button" className="w-full sm:w-auto" disabled={redeemPending} onClick={() => post("redeem", redeemAction)}>
            {redeemPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserCog className="size-4" aria-hidden />}
            {redeemPending ? t("confirming") : t("confirm")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!signedIn) return;
        setDismissed(null);
        post("preview", previewAction);
      }}
    >
      {error ? <FormMessage>{tErrors(error)}</FormMessage> : null}
      {joined && mode === "account" ? <FormMessage tone="success">{t("joined")}</FormMessage> : null}

      <Field id={id} label={t("codeLabel")} hint={t("codeHint")} error={fieldError}>
        <Input
          id={id}
          name="code"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            if (mode === "join") storeCode(event.target.value.trim());
          }}
          dir="ltr"
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          placeholder="ABCD-EFGH-2345"
          className="font-mono tracking-widest uppercase sm:max-w-sm"
          required
        />
      </Field>

      {signedIn ? (
        <Button type="submit" disabled={previewPending} className="w-full sm:w-fit">
          {previewPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserCog className="size-4" aria-hidden />}
          {previewPending ? t("checking") : t("continue")}
        </Button>
      ) : (
        <div className="flex flex-col gap-3">
          <FormMessage tone="info">{t("signInFirst")}</FormMessage>
          <div className="grid gap-2 sm:flex">
            {signInHref ? (
              <LinkButton href={signInHref} variant="default" className="w-full sm:w-auto">
                {t("signIn")}
              </LinkButton>
            ) : null}
            {registerHref ? (
              <LinkButton href={registerHref} className="w-full sm:w-auto">
                {t("register")}
              </LinkButton>
            ) : null}
          </div>
        </div>
      )}
    </form>
  );
}
