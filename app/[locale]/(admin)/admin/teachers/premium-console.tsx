"use client";

import { useCallback } from "react";
import { Search, UserX } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  IDLE_PREMIUM_ACTION_STATE,
  type PremiumAccountView,
  type PremiumActionState,
} from "@/app/[locale]/(admin)/admin/teachers/action-state";
import {
  extendPremiumAction,
  grantPremiumAction,
  lookupPremiumAccountAction,
  revokePremiumAction,
} from "@/app/[locale]/(admin)/admin/teachers/actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EmptyState } from "@/components/shared/empty-state";
import { DetailRow, Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { PremiumStatusBadge, premiumDayLabel } from "@/components/shared/premium-status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * The Teachers page's one control (W6, D-W35): an exact-email lookup, then the
 * matched account's status and its actions — Grant (not premium now), Extend
 * and Revoke (premium now). One state for the lookup and every write, so the
 * card always shows the account as the server last answered it. No list, no
 * partial search: an unknown email gets the same neutral line every time.
 */
export function PremiumConsole({ todayIso, latestIso }: { todayIso: string; latestIso: string }) {
  const t = useTranslations("AdminPremium");
  const locale = useLocale();

  const run = useCallback(async (previous: PremiumActionState, formData: FormData) => {
    switch (formData.get("intent")) {
      case "grant":
        return grantPremiumAction(previous, formData);
      case "extend":
        return extendPremiumAction(previous, formData);
      case "revoke":
        return revokePremiumAction(previous, formData);
      default:
        return lookupPremiumAccountAction(previous, formData);
    }
  }, []);
  const [state, dispatch] = useGuardedActionState(run, IDLE_PREMIUM_ACTION_STATE);
  useActionFeedback(state, { success: (status) => t(`saved.${status}`) });

  const lookupError = state.fieldErrors?.email;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("lookup.title")}</CardTitle>
          <CardDescription>{t("lookup.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={dispatch} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <input type="hidden" name="intent" value="lookup" />
            <input type="hidden" name="locale" value={locale} />
            <Field
              id="premium-lookup-email"
              label={t("lookup.label")}
              hint={t("lookup.hint")}
              error={lookupError ? t(`errors.${lookupError}`) : undefined}
              className="flex-1"
            >
              <Input
                id="premium-lookup-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                required
              />
            </Field>
            <SubmitButton className="sm:w-auto" pendingLabel={t("lookup.searching")}>
              <Search className="size-4" aria-hidden />
              {t("lookup.submit")}
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      <div aria-live="polite" className="flex flex-col gap-3">
        {state.error && state.account === undefined ? <FormMessage>{t(`errors.${state.error}`)}</FormMessage> : null}
        {state.account === null ? (
          <EmptyState compact icon={<UserX />} title={t("noMatch")} />
        ) : state.account ? (
          <AccountCard
            key={state.account.userId}
            account={state.account}
            state={state}
            dispatch={dispatch}
            todayIso={todayIso}
            latestIso={latestIso}
          />
        ) : null}
      </div>
    </div>
  );
}

function AccountCard({
  account,
  state,
  dispatch,
  todayIso,
  latestIso,
}: {
  account: PremiumAccountView;
  state: PremiumActionState;
  dispatch: (formData: FormData) => void;
  todayIso: string;
  latestIso: string;
}) {
  const t = useTranslations("AdminPremium");
  const locale = useLocale();
  const { status } = account;
  const active = status.kind === "active";
  const dateError = state.fieldErrors?.endDay ?? state.fieldErrors?.userId;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words">{account.name}</span>
          <PremiumStatusBadge status={status} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <dl>
          <DetailRow label={t("account.email")} value={account.email} ltr />
        </dl>

        {/* Grant (not premium now) or Extend (premium now): one end-date form. */}
        <form action={dispatch} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <input type="hidden" name="intent" value={active ? "extend" : "grant"} />
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="userId" value={account.userId} />
          <Field
            id="premium-end-day"
            label={active ? t("extend.label") : t("grant.label")}
            hint={t("endDayHint", { max: premiumDayLabel(latestIso, locale) })}
            error={dateError ? t(`errors.${dateError}`, { max: premiumDayLabel(latestIso, locale) }) : undefined}
            className="flex-1"
          >
            <DatePicker
              id="premium-end-day"
              name="endDay"
              todayIso={todayIso}
              required
              aria-invalid={dateError ? true : undefined}
            />
          </Field>
          <SubmitButton className="sm:w-auto">{active ? t("extend.submit") : t("grant.submit")}</SubmitButton>
        </form>

        {state.error ? <FormMessage>{t(`errors.${state.error}`)}</FormMessage> : null}

        {active ? (
          <div className="flex flex-col gap-2 border-t border-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-text-secondary">{t("revoke.hint")}</p>
            <ConfirmAction
              label={t("revoke.trigger")}
              variant="outline"
              triggerClassName="h-11 w-full sm:w-auto"
              title={t("revoke.title")}
              description={t("revoke.description", { name: account.name })}
              confirmLabel={t("revoke.confirm")}
              action={dispatch}
              fields={{ intent: "revoke", locale, userId: account.userId }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
