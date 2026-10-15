"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { Input } from "@/components/ui/input";

/**
 * A person's contact details **as this center has them on file**
 * (docs/01-data-model.md §6). Unlike name, these are center-local columns on
 * `StudentProfile`/`Membership` — always editable here, regardless of
 * whether the person is shared with another center or has claimed their own
 * account. `atLeastOneRequired` renders a hint instead of an "(optional)" tag
 * on `phone`, because "phone or email" is conditionally required, not free.
 *
 * R10b: the phone leads (it is what staff ask for first, and what identifies
 * an existing person), then the alternate number, then `belowPhone` — a
 * full-width slot the add forms put the duplicate-match panel in, so the match
 * reads straight after the number that caused it — then the email.
 */
export type ContactValues = {
  email?: string;
  phone?: string;
  altPhone?: string;
};

export function ContactFields({
  idPrefix,
  values,
  fieldErrors,
  atLeastOneRequired,
  belowPhone,
  ownProfile,
}: {
  idPrefix: string;
  values?: ContactValues;
  fieldErrors?: Record<string, string>;
  /** Teachers need a phone or an email on file; students may have neither. */
  atLeastOneRequired?: boolean;
  /** Full-width content directly under the phone row (the duplicate-match panel). */
  belowPhone?: ReactNode;
  /** See `PersonFields`: autofill only for the person's own profile. */
  ownProfile?: boolean;
}) {
  const t = useTranslations("People.fields");
  const tErrors = useTranslations("People.errors");

  const error = (name: string) =>
    fieldErrors?.[name] ? tErrors(fieldErrors[name]) : undefined;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        id={`${idPrefix}-phone`}
        label={t("phone")}
        optional={!atLeastOneRequired}
        hint={atLeastOneRequired ? t("phoneOrEmailHint") : t("phoneHint")}
        error={error("phone")}
      >
        <Input
          id={`${idPrefix}-phone`}
          name="phone"
          autoComplete={ownProfile ? "tel" : "off"}
          type="tel"
          inputMode="tel"
          dir="ltr"
          defaultValue={values?.phone ?? ""}
          maxLength={20}
          placeholder={t("phonePlaceholder")}
          aria-invalid={fieldErrors?.phone ? true : undefined}
        />
      </Field>

      <Field
        id={`${idPrefix}-altPhone`}
        label={t("altPhone")}
        optional
        error={error("altPhone")}
      >
        <Input
          id={`${idPrefix}-altPhone`}
          name="altPhone"
          autoComplete="off"
          type="tel"
          inputMode="tel"
          dir="ltr"
          defaultValue={values?.altPhone ?? ""}
          maxLength={20}
          placeholder={t("phonePlaceholder")}
          aria-invalid={fieldErrors?.altPhone ? true : undefined}
        />
      </Field>
      {belowPhone ? <div className="sm:col-span-2">{belowPhone}</div> : null}

      <Field
        id={`${idPrefix}-email`}
        label={t("email")}
        optional={!atLeastOneRequired}
        error={error("email")}
      >
        <Input
          id={`${idPrefix}-email`}
          name="email"
          autoComplete={ownProfile ? "email" : "off"}
          type="email"
          spellCheck={false}
          autoCapitalize="none"
          inputMode="email"
          // Addresses and numbers read left-to-right in both locales.
          dir="ltr"
          defaultValue={values?.email ?? ""}
          maxLength={254}
          placeholder={t("emailPlaceholder")}
          aria-invalid={fieldErrors?.email ? true : undefined}
        />
      </Field>
    </div>
  );
}
