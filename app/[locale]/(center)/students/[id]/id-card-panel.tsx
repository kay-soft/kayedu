"use client";

import type { ReactNode } from "react";

import { Download } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { generateIdCardAction } from "@/app/[locale]/(center)/students/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * The ID-card panel: the live preview (rendered on the server and passed in as
 * `children`) and "generate" — which writes the same SVG to
 * `id-cards/{centerId}/…` in Supabase Storage and hands back a short-lived
 * signed link (docs/02 §10). R10b: the two print views (card, paper form) moved
 * up to the page header's action bar; this panel keeps the stored-card control.
 */
export function IdCardPanel({
  studentProfileId,
  generatedAt,
  storageEnabled,
  children,
}: {
  studentProfileId: string;
  /** Already localized on the server; null when no card has been stored yet. */
  generatedAt: string | null;
  /** False when SUPABASE_SERVICE_ROLE_KEY is absent — printing still works. */
  storageEnabled: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("Students.card");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(
    generateIdCardAction,
    IDLE_PEOPLE_STATE,
  );

  return (
    <div className="flex flex-col gap-4">
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      {children}

      <p className="text-xs text-text-muted">
        {storageEnabled
          ? generatedAt
            ? t("generatedAt", { date: generatedAt })
            : t("notStored")
          : t("noStorage")}
      </p>

      {storageEnabled ? (
        <form action={formAction}>
          <input type="hidden" name="locale" value={locale} />
          <input
            type="hidden"
            name="studentProfileId"
            value={studentProfileId}
          />
          <SubmitButton variant="outline" className="w-full">
            {t("generate")}
          </SubmitButton>
        </form>
      ) : null}

      {state.status === "generated" && state.downloadUrl ? (
        <FormMessage tone="success">
          <a
            href={state.downloadUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 underline"
          >
            <Download className="size-4" aria-hidden />
            {t("download")}
          </a>
        </FormMessage>
      ) : null}
    </div>
  );
}
