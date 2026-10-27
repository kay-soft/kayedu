"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";

import { FormMessage } from "@/components/shared/form-message";
import { Ltr } from "@/components/shared/ltr";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { formatFamilyCodeForDisplay } from "@/lib/family-code";

/**
 * A freshly issued parent code, shown **once** (F3, docs/04 §11.22): the code
 * large, in an LTR run, the "shown only once" warning, and Copy. The caller
 * adds its own second action (WhatsApp for a student, Print for a branch).
 * The code lives only in this component's props — it is never stored, never
 * put in a URL the server sees, and gone when the dialog closes.
 */
export function FamilyCodeReveal({ code, children }: { code: string; children?: ReactNode }) {
  const t = useTranslations("Family.code");
  const [copied, setCopied] = useState(false);
  const display = formatFamilyCodeForDisplay(code);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-2 rounded-xl bg-surface-subtle px-4 py-5 text-center">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <KeyRound className="size-4" aria-hidden />
          {t("label")}
        </span>
        <Ltr className="font-mono text-3xl font-semibold tracking-widest text-text-primary select-all sm:text-4xl">
          {display}
        </Ltr>
        <span className="text-xs text-text-secondary">{t("rules")}</span>
      </div>

      <FormMessage tone="warning">{t("onceWarning")}</FormMessage>

      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <Button
          type="button"
          variant="outline"
          className="w-full sm:w-auto"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(display);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
              notify("error", t("copyFailed"));
            }
          }}
        >
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          <span aria-live="polite">{copied ? t("copied") : t("copy")}</span>
        </Button>
        {children}
      </div>
    </div>
  );
}
