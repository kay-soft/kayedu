"use client";

import { useActionState, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { saveCardLayoutAction } from "@/app/[locale]/(center)/settings/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { defaultCardLayoutJson } from "@/lib/card-layout";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import { MAX_CARD_LAYOUT_CHARS } from "@/lib/validation/settings";

/**
 * ID-card customization is a free-form JSON document (docs/01 §2), so the
 * editor is a JSON textarea with client-side syntax checking and a
 * "start from the default" button. The server re-validates — the client check
 * only saves a round trip.
 */
export function CardLayoutForm({ initialJson }: { initialJson: string }) {
  const t = useTranslations("Settings.card");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    saveCardLayoutAction,
    IDLE_ACTION_STATE,
  );
  const [value, setValue] = useState(initialJson);

  const trimmed = value.trim();
  let localError: string | null = null;
  if (trimmed !== "") {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        localError = "cardLayoutNotObject";
      }
    } catch {
      localError = "invalidJson";
    }
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("editorTitle")}</CardTitle>
          <CardDescription>{t("editorDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cardLayout">{t("jsonLabel")}</Label>
            <Textarea
              id="cardLayout"
              name="cardLayout"
              // JSON is code: it stays LTR and monospaced in both locales.
              dir="ltr"
              spellCheck={false}
              rows={16}
              maxLength={MAX_CARD_LAYOUT_CHARS}
              className="font-mono text-xs leading-relaxed"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={
                localError || state.fieldErrors?.cardLayout ? true : undefined
              }
            />
            {localError ? <FieldError>{tErrors(localError)}</FieldError> : null}
            {!localError && state.fieldErrors?.cardLayout ? (
              <FieldError>{tErrors(state.fieldErrors.cardLayout)}</FieldError>
            ) : null}
            <p className="text-xs text-text-muted">{t("emptyHint")}</p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <SubmitButton className="w-full sm:w-auto">
              {tCommon("save")}
            </SubmitButton>
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full px-4 sm:w-auto"
              onClick={() => setValue(defaultCardLayoutJson())}
            >
              <RotateCcw className="size-4 rtl:-scale-x-100" />
              {t("loadDefault")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-11 w-full px-4 sm:w-auto"
              onClick={() => setValue("")}
            >
              {t("clear")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
