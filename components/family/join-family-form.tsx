"use client";

import { startTransition, useEffect, useState } from "react";
import { Loader2, Link2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { acceptFamilyCodeAction } from "@/app/[locale]/account/family-actions";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_FAMILY_STATE } from "@/lib/validation/parents";

/** Where a code waits while a guest signs in (this tab only, never a server). */
const PENDING_CODE_KEY = "kayedu.familyJoinCode";

function readStoredCode(): string {
  try {
    return window.sessionStorage.getItem(PENDING_CODE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeCode(code: string) {
  try {
    if (code) window.sessionStorage.setItem(PENDING_CODE_KEY, code);
    else window.sessionStorage.removeItem(PENDING_CODE_KEY);
  } catch {
    // Storage blocked (private window): the code just has to be typed again.
  }
}

/**
 * Accepting a parent code (F3, docs/04 §11.22).
 *
 * `join` — the `/family/join` page. The code arrives in the URL **fragment**
 * (`#XXXXXXXX`), which the browser never sends to a server: it is read here,
 * kept in this tab's `sessionStorage` so it survives signing in or creating
 * an account (the sign-in links carry only `next=/family/join`), and wiped
 * from the address bar at once. It reaches the server only as the posted
 * form field, and is forgotten once a link is made.
 *
 * `account` — Account → Family's "Link another child": the same form, no
 * fragment, stays on the page.
 */
export function JoinFamilyForm({
  mode,
  signedIn,
  signInHref,
  registerHref,
}: {
  mode: "join" | "account";
  signedIn: boolean;
  /** Locale-less paths with `?next=/family/join` (guests only). */
  signInHref?: string;
  registerHref?: string;
}) {
  const t = useTranslations("Family.join");
  const tErrors = useTranslations("Family.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [state, formAction, pending] = useGuardedActionState(acceptFamilyCodeAction, IDLE_FAMILY_STATE);
  useActionFeedback(state, { success: (status) => (status === "linked" ? tToasts("familyLinked") : null) });

  // Pick the code up from the fragment (or from before a sign-in), then take
  // it out of the address bar and the history entry.
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
    if (state.status !== "linked") return;
    storeCode("");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the field once the link is made
    setCode("");
    if (mode === "join") router.push(ROUTES.parentHome);
  }, [state, mode, router]);

  const fieldError = state.fieldErrors?.code ? tErrors(state.fieldErrors.code) : undefined;
  const id = `family-code-${mode}`;

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!signedIn) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => formAction(formData));
      }}
    >
      <input type="hidden" name="locale" value={locale} />
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

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
          maxLength={32}
          placeholder="ABCD-2345"
          className="font-mono tracking-widest uppercase sm:max-w-xs"
          required
        />
      </Field>

      {signedIn ? (
        <Button type="submit" disabled={pending} className="w-full sm:w-fit">
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
          {pending ? t("submitting") : t("submit")}
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
