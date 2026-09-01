"use client";

import { useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { Input } from "@/components/ui/input";

/**
 * A person's name **as this center has it on file** — a center-local field on
 * `StudentProfile`/`Membership`, exactly like the contact fields in
 * `components/center/contact-fields.tsx` (docs/01-data-model.md §6). Seeded
 * from the global `User` when this center's record is created, then always
 * editable here, independently of any other center, with no lock of any kind.
 */
export type PersonValues = {
  firstName?: string;
  lastName?: string;
};

export function PersonFields({
  idPrefix,
  values,
  fieldErrors,
  autoFocus,
}: {
  idPrefix: string;
  values?: PersonValues;
  fieldErrors?: Record<string, string>;
  autoFocus?: boolean;
}) {
  const t = useTranslations("People.fields");
  const tErrors = useTranslations("People.errors");

  const error = (name: string) =>
    fieldErrors?.[name] ? tErrors(fieldErrors[name]) : undefined;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        id={`${idPrefix}-firstName`}
        label={t("firstName")}
        error={error("firstName")}
      >
        <Input
          id={`${idPrefix}-firstName`}
          name="firstName"
          defaultValue={values?.firstName ?? ""}
          maxLength={60}
          required
          autoFocus={autoFocus}
          placeholder={t("firstNamePlaceholder")}
          aria-invalid={fieldErrors?.firstName ? true : undefined}
        />
      </Field>

      <Field
        id={`${idPrefix}-lastName`}
        label={t("lastName")}
        error={error("lastName")}
      >
        <Input
          id={`${idPrefix}-lastName`}
          name="lastName"
          defaultValue={values?.lastName ?? ""}
          maxLength={60}
          required
          placeholder={t("lastNamePlaceholder")}
          aria-invalid={fieldErrors?.lastName ? true : undefined}
        />
      </Field>
    </div>
  );
}
