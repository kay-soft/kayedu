"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  approveCatalogSuggestionAction,
  rejectCatalogSuggestionAction,
} from "@/app/[locale]/(admin)/admin/catalog/actions";
import { IDLE_CATALOG_ADMIN_ACTION_STATE } from "@/app/[locale]/(admin)/admin/catalog/action-state";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";

export function SuggestionRow({ suggestionId }: { suggestionId: string }) {
  const t = useTranslations("AdminCatalog");
  const tErrors = useTranslations("AdminCatalog.errors");
  const locale = useLocale();

  const [approveState, approveAction] = useActionState(
    approveCatalogSuggestionAction,
    IDLE_CATALOG_ADMIN_ACTION_STATE,
  );
  const [rejectState, rejectAction] = useActionState(
    rejectCatalogSuggestionAction,
    IDLE_CATALOG_ADMIN_ACTION_STATE,
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <form action={approveAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={suggestionId} />
          <SubmitButton className="h-9 px-3 text-xs">{t("approve")}</SubmitButton>
        </form>
        <form action={rejectAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={suggestionId} />
          <Button type="submit" variant="outline" className="h-9 px-3 text-xs">
            {t("reject")}
          </Button>
        </form>
      </div>
      {approveState.error ? <FormMessage>{tErrors(approveState.error)}</FormMessage> : null}
      {rejectState.error ? <FormMessage>{tErrors(rejectState.error)}</FormMessage> : null}
    </div>
  );
}
