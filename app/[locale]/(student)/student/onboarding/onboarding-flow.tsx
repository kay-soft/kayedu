"use client";

import { useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";

import { inviteParentAction } from "@/app/[locale]/account/family-actions";
import { WhatsAppShare } from "@/app/[locale]/account/family-controls";
import {
  IDLE_STUDY_STATE,
  saveStudyDetailsAction,
} from "@/app/[locale]/account/study-actions";
import { FamilyCodeReveal } from "@/components/family/family-code-reveal";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { SubmitButton } from "@/components/shared/submit-button";
import { GradePicker } from "@/components/student/grade-picker";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import type { GradePickerData } from "@/lib/student-grade-options";
import { useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_FAMILY_STATE } from "@/lib/validation/parents";

/**
 * The two onboarding steps (docs/04 §11.23). Step 1 saves the account grade
 * and moves on by itself; step 2 is F3's invite — the same action, one
 * declared parent, the code shown once — and is skippable. Both end at
 * Discover. Nothing here is a gate: the portal around it stays reachable.
 */
export function OnboardingFlow({
  data,
  gradeId,
  canInviteParent,
  studentName,
}: {
  data: GradePickerData;
  gradeId: string;
  canInviteParent: boolean;
  studentName: string;
}) {
  const t = useTranslations("Onboarding.student");
  const tErrors = useTranslations("Account.errors");
  const locale = useLocale();
  const router = useRouter();
  const [state, formAction] = useGuardedActionState(saveStudyDetailsAction, IDLE_STUDY_STATE);

  const gradeSaved = state.status === "saved";
  const step: "grade" | "parent" = gradeSaved && canInviteParent ? "parent" : "grade";

  // Nothing left to ask (no free parent slot): straight to Discover.
  useEffect(() => {
    if (gradeSaved && !canInviteParent) router.push(ROUTES.studentDiscover);
  }, [gradeSaved, canInviteParent, router]);

  const errorText = (key: string | undefined) =>
    key ? (tErrors.has(key) ? tErrors(key) : tErrors("failed")) : undefined;

  if (step === "parent") return <ParentStep studentName={studentName} />;

  return (
    <Card>
      <CardHeader>
        <p className="text-xs font-medium text-text-secondary">
          {t("step", { current: 1, total: canInviteParent ? 2 : 1 })}
        </p>
        <CardTitle>{t("gradeTitle")}</CardTitle>
        <CardDescription>{t("gradeDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="locale" value={locale} />
          {state.error ? <FormMessage>{errorText(state.error)}</FormMessage> : null}
          <GradePicker
            data={data}
            defaultGradeId={gradeId}
            idPrefix="onboarding"
            error={errorText(state.fieldErrors?.gradeId)}
          />
          <SubmitButton className="w-full sm:w-fit" pendingLabel={t("saving")}>
            {t("continue")}
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

function ParentStep({ studentName }: { studentName: string }) {
  const t = useTranslations("Onboarding.student");
  const tInvite = useTranslations("Family.invite");
  const tErrors = useTranslations("Family.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(inviteParentAction, IDLE_FAMILY_STATE);
  const issued = state.status === "issued" && state.code ? state.code : null;
  const fieldError = (name: string) => (state.fieldErrors?.[name] ? tErrors(state.fieldErrors[name]) : undefined);

  if (issued) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{tInvite("issuedTitle")}</CardTitle>
          <CardDescription>{tInvite("issuedDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FamilyCodeReveal code={issued}>
            <WhatsAppShare code={issued} studentName={studentName} />
          </FamilyCodeReveal>
          <LinkButton href={ROUTES.studentDiscover} variant="default" className="w-full sm:w-fit">
            {t("toDiscover")}
          </LinkButton>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <p className="text-xs font-medium text-text-secondary">{t("step", { current: 2, total: 2 })}</p>
        <CardTitle>{t("parentTitle")}</CardTitle>
        <CardDescription>{t("parentDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="locale" value={locale} />
          {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="onboarding-parent-first" label={tInvite("firstName")} error={fieldError("parentFirstName")}>
              <Input id="onboarding-parent-first" name="parentFirstName" autoComplete="off" required maxLength={60} />
            </Field>
            <Field id="onboarding-parent-last" label={tInvite("lastName")} error={fieldError("parentLastName")}>
              <Input id="onboarding-parent-last" name="parentLastName" autoComplete="off" required maxLength={60} />
            </Field>
          </div>
          <Field
            id="onboarding-parent-phone"
            label={tInvite("phone")}
            hint={tInvite("phoneHint")}
            error={fieldError("parentPhone")}
          >
            <Input
              id="onboarding-parent-phone"
              name="parentPhone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              dir="ltr"
              placeholder="01012345678"
              required
              maxLength={20}
            />
          </Field>
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            <SubmitButton className="w-full sm:w-auto" pendingLabel={t("saving")}>
              {tInvite("submit")}
            </SubmitButton>
            <LinkButton href={ROUTES.studentDiscover} className="w-full sm:w-auto">
              {t("skip")}
            </LinkButton>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
