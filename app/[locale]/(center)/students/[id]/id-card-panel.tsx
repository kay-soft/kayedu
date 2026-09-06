"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { Download, IdCard } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { generateIdCardAction } from "@/app/[locale]/(center)/students/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * The ID-card panel: the live preview (rendered on the server and passed in as
 * `children`), the two print views, and "generate" — which writes the same SVG
 * to `id-cards/{centerId}/…` in Supabase Storage and hands back a short-lived
 * signed link (docs/02 §10).
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

  const [state, formAction] = useActionState(
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

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Link
          href={ROUTES.centerStudentCard(studentProfileId)}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/80"
        >
          <IdCard className="size-4" aria-hidden />
          {t("printCard")}
        </Link>

        <Link
          href={ROUTES.centerStudentPaper(studentProfileId)}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-text-primary hover:bg-surface-subtle"
        >
          {t("printPaper")}
        </Link>

        {storageEnabled ? (
          <form action={formAction}>
            <input type="hidden" name="locale" value={locale} />
            <input
              type="hidden"
              name="studentProfileId"
              value={studentProfileId}
            />
            <SubmitButton variant="outline" className="w-full sm:w-auto">
              {t("generate")}
            </SubmitButton>
          </form>
        ) : null}
      </div>

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
