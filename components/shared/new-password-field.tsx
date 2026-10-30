"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Check, Circle } from "lucide-react";
import { useTranslations } from "next-intl";

import { PasswordField } from "@/components/shared/password-field";
import { PASSWORD_CHECKS, PASSWORD_MIN_LENGTH, passwordChecks } from "@/lib/password-policy";
import { cn } from "@/lib/utils";

/**
 * A `PasswordField` for a password being **set** (sign-up, change password),
 * with the policy's live checklist under it (U1, docs/04 §12). The rules and
 * their numbers come from `lib/password-policy.ts` — the same module the zod
 * schema uses — so what ticks here is exactly what the server accepts.
 * The checklist resets with its form (`form.reset()` after a change).
 */
export function NewPasswordField(props: ComponentProps<typeof PasswordField>) {
  const t = useTranslations("Auth.fields");
  const [value, setValue] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const met = passwordChecks(value);

  useEffect(() => {
    const form = root.current?.closest("form");
    if (!form) return;
    const onReset = () => setValue("");
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  const labels = {
    length: t("policyLength", { min: PASSWORD_MIN_LENGTH }),
    letter: t("policyLetter"),
    digit: t("policyDigit"),
  };

  return (
    <div ref={root} className="flex flex-col gap-2">
      <PasswordField
        {...props}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          props.onChange?.(event);
        }}
      />
      <ul aria-label={t("policyTitle")} className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {PASSWORD_CHECKS.map((check) => (
          <li
            key={check}
            className={cn("flex items-center gap-1.5", met[check] ? "text-success-fg" : "text-text-muted")}
          >
            {met[check] ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Circle className="size-3.5" aria-hidden />
            )}
            <span>{labels[check]}</span>
            <span className="sr-only">{met[check] ? t("policyMet") : t("policyUnmet")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
