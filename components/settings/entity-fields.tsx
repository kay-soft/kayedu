"use client";

import { useTranslations } from "next-intl";

import { FieldError } from "@/components/shared/form-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectInput } from "@/components/ui/select-input";

/**
 * One field descriptor drives both the create form and every row's edit form,
 * so the five master-data screens share a single rendering path.
 */
export type EntityFieldOption = { value: string; label: string };

export type EntityField =
  | {
      name: string;
      kind: "text";
      label: string;
      required?: boolean;
      maxLength?: number;
      placeholder?: string;
      hint?: string;
    }
  | {
      name: string;
      kind: "number";
      label: string;
      max?: number;
      /** Rendered after the input, e.g. "seats". */
      hint?: string;
    }
  /** An EGP amount. Stored as piastres — the action converts (CLAUDE.md rule 2). */
  | { name: string; kind: "money"; label: string; hint?: string }
  | {
      name: string;
      kind: "select";
      label: string;
      options: EntityFieldOption[];
      /** Label for the "not set" option; omit to make the select required. */
      emptyLabel?: string;
    };

export function EntityFields({
  fields,
  values,
  idPrefix,
  fieldErrors,
  translateError,
}: {
  fields: EntityField[];
  values?: Record<string, string>;
  idPrefix: string;
  fieldErrors?: Record<string, string>;
  translateError: (key: string) => string;
}) {
  const t = useTranslations("Shared");

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.name}`;
        const error = fieldErrors?.[field.name];
        const invalid = error ? true : undefined;
        const defaultValue = values?.[field.name] ?? "";
        // The mandatory form convention (docs/04 §5 "Form fields"): a field
        // that is genuinely always optional gets a dimmed "(optional)" tag.
        const optional =
          field.kind === "text"
            ? !field.required
            : field.kind === "select"
              ? field.emptyLabel !== undefined
              : false;

        return (
          <div key={field.name} className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={id}>
              {field.label}
              {optional ? (
                <span className="font-normal text-text-muted">
                  {t("optional")}
                </span>
              ) : null}
            </Label>

            {field.kind === "select" ? (
              <SelectInput
                id={id}
                name={field.name}
                defaultValue={defaultValue}
                required={field.emptyLabel === undefined}
                aria-invalid={invalid}
              >
                {field.emptyLabel !== undefined ? (
                  <option value="">{field.emptyLabel}</option>
                ) : null}
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SelectInput>
            ) : (
              <Input
                id={id}
                name={field.name}
                defaultValue={defaultValue}
                aria-invalid={invalid}
                {...(field.kind === "text"
                  ? {
                      type: "text",
                      required: field.required,
                      maxLength: field.maxLength ?? 80,
                      placeholder: field.placeholder,
                    }
                  : {
                      type: "number",
                      // Numerals stay LTR in both locales (docs/04 §7).
                      dir: "ltr" as const,
                      inputMode: "decimal" as const,
                      min: 0,
                      ...(field.kind === "money"
                        ? { step: "0.01" }
                        : { step: 1, max: field.max }),
                    })}
              />
            )}

            {field.kind !== "select" && field.hint ? (
              <p className="text-xs text-text-muted">{field.hint}</p>
            ) : null}
            {error ? <FieldError>{translateError(error)}</FieldError> : null}
          </div>
        );
      })}
    </div>
  );
}
