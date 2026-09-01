"use client";

import { useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { Input } from "@/components/ui/input";

/**
 * The five fields every person carries on their **global** `User` row: name and
 * contact details (docs/01-data-model.md §2). Teachers and students share this
 * component so the two forms cannot drift apart.
 *
 * When `readOnly` is set the inputs render disabled with an explanation: the
 * person is shared with another center, or has signed in and owns their own
 * profile, so this center may not rewrite their identity (lib/identity.ts).
 */
export type PersonValues = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  altPhone?: string;
};

export function PersonFields({
  idPrefix,
  values,
  fieldErrors,
  readOnly,
  autoFocus,
}: {
  idPrefix: string;
  values?: PersonValues;
  fieldErrors?: Record<string, string>;
  readOnly?: boolean;
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
          disabled={readOnly}
          autoFocus={autoFocus}
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
          disabled={readOnly}
          aria-invalid={fieldErrors?.lastName ? true : undefined}
        />
      </Field>

      <Field id={`${idPrefix}-email`} label={t("email")} error={error("email")}>
        <Input
          id={`${idPrefix}-email`}
          name="email"
          type="email"
          inputMode="email"
          // Addresses and numbers read left-to-right in both locales.
          dir="ltr"
          defaultValue={values?.email ?? ""}
          maxLength={254}
          disabled={readOnly}
          aria-invalid={fieldErrors?.email ? true : undefined}
        />
      </Field>

      <Field
        id={`${idPrefix}-phone`}
        label={t("phone")}
        hint={t("phoneHint")}
        error={error("phone")}
      >
        <Input
          id={`${idPrefix}-phone`}
          name="phone"
          type="tel"
          inputMode="tel"
          dir="ltr"
          defaultValue={values?.phone ?? ""}
          maxLength={20}
          disabled={readOnly}
          aria-invalid={fieldErrors?.phone ? true : undefined}
        />
      </Field>

      <Field
        id={`${idPrefix}-altPhone`}
        label={t("altPhone")}
        error={error("altPhone")}
      >
        <Input
          id={`${idPrefix}-altPhone`}
          name="altPhone"
          type="tel"
          inputMode="tel"
          dir="ltr"
          defaultValue={values?.altPhone ?? ""}
          maxLength={20}
          disabled={readOnly}
          aria-invalid={fieldErrors?.altPhone ? true : undefined}
        />
      </Field>
    </div>
  );
}
