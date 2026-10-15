"use client";

import { useCallback, useState } from "react";
import type { ZodType } from "zod";

import { fieldErrorsFrom } from "@/lib/validation/form";

/**
 * Client-side validation with the **same** zod schema the Server Action
 * parses (DES, Phase 3; docs/04 §14.2) — the same `Object.fromEntries`
 * of the same `FormData`, so the two can never disagree about what is valid.
 * The server stays authoritative: this only saves a round trip.
 *
 * It refuses a submit only when every failing key is a visible control in the
 * form, i.e. something the person can see and fix. A failure on anything else
 * (a hidden id, the locale) goes to the server, which answers it — the client
 * must never be the thing that silently blocks a submit.
 */
export function useClientValidation(schema: ZodType) {
  const [errors, setErrors] = useState<Record<string, string> | null>(null);

  const check = useCallback(
    (form: HTMLFormElement, formData: FormData): boolean => {
      const parsed = schema.safeParse(Object.fromEntries(formData));
      if (parsed.success) {
        setErrors(null);
        return true;
      }
      const found = fieldErrorsFrom(parsed.error);
      const visible = Object.keys(found).every((name) => {
        const control = form.elements.namedItem(name);
        return control instanceof HTMLElement && !(control instanceof HTMLInputElement && control.type === "hidden");
      });
      if (!visible) {
        setErrors(null);
        return true;
      }
      setErrors(found);
      // After the errors render: the first invalid field takes focus.
      requestAnimationFrame(() => {
        form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return false;
    },
    [schema],
  );

  return { clientErrors: errors, check };
}
