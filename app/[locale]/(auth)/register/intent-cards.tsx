"use client";

import { GraduationCap, Presentation, Users, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export const SIGNUP_INTENTS = ["STUDENT", "PARENT", "TEACHER"] as const;
export type SignupIntentValue = (typeof SIGNUP_INTENTS)[number];

const ICONS: Record<SignupIntentValue, LucideIcon> = {
  STUDENT: GraduationCap,
  PARENT: Users,
  TEACHER: Presentation,
};

/**
 * "I'm joining as" (F4, docs/04 §11.23): three radio cards, required. A native
 * radio group — arrow keys, one tab stop, a real `legend` — dressed as cards.
 * The choice only routes onboarding after sign-up; it is not a role.
 * Controlled by the form so a refused submit keeps the choice.
 */
export function IntentCards({
  value,
  onChange,
  error,
}: {
  value: SignupIntentValue | null;
  onChange: (value: SignupIntentValue) => void;
  error?: string;
}) {
  const t = useTranslations("Auth.register.intent");

  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={error ? "intent-error" : undefined}>
      <legend className="mb-1 text-sm font-medium text-text-primary">{t("legend")}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {SIGNUP_INTENTS.map((intent) => {
          const Icon = ICONS[intent];
          return (
            <label key={intent} className="block cursor-pointer">
              <input
                type="radio"
                name="signupIntent"
                value={intent}
                checked={value === intent}
                onChange={() => onChange(intent)}
                className="peer sr-only"
                required
              />
              <span
                className={cn(
                  "flex min-h-16 items-center gap-3 rounded-xl border border-border bg-surface p-3 text-start transition-ui",
                  "hover:border-border-strong hover:bg-surface-hover",
                  "peer-checked:border-brand peer-checked:bg-brand/5 peer-checked:ring-2 peer-checked:ring-brand/20",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40",
                  "sm:min-h-28 sm:flex-col sm:justify-center sm:text-center",
                )}
              >
                <span
                  aria-hidden
                  className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand"
                >
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-text-primary">{t(`${intent}.label`)}</span>
                  <span className="block text-xs text-text-secondary">{t(`${intent}.hint`)}</span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p id="intent-error" role="alert" className="text-xs font-medium text-danger-fg">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
