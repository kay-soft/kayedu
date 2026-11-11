"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, Link2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { FormMessage } from "@/components/shared/form-message";
import { Ltr } from "@/components/shared/ltr";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { formatAssistantCodeForDisplay } from "@/lib/assistant-catalog";
import { formatDateTime } from "@/lib/format";
import { assistantJoinUrl } from "@/lib/routes";
import { DEFAULT_TIMEZONE } from "@/lib/scheduling";

/**
 * A freshly created assistant code, shown **once** (W7a, docs/04 §11.36): the
 * code large in an LTR run, when it stops working, the "shown only once"
 * warning, and Copy (the code, or the join link with the code in its
 * fragment). The code lives only in these props — it is stored hashed, never
 * retrievable again, and gone when the dialog closes.
 */
export function AssistantCodeReveal({ code, expiresAt }: { code: string; expiresAt: string }) {
  const t = useTranslations("Assistants.code");
  const locale = useLocale() === "en" ? "en" : "ar";
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const display = formatAssistantCodeForDisplay(code);

  async function copy(kind: "code" | "link") {
    try {
      const value = kind === "code" ? display : assistantJoinUrl(window.location.origin, locale, code);
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
      notify("error", t("copyFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-2 rounded-xl bg-surface-subtle px-4 py-5 text-center">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <KeyRound className="size-4" aria-hidden />
          {t("label")}
        </span>
        <Ltr className="font-mono text-2xl font-semibold tracking-widest break-all text-text-primary select-all sm:text-3xl">
          {display}
        </Ltr>
        <span className="text-xs text-text-secondary">
          {t("expires", { date: formatDateTime(new Date(expiresAt), locale, DEFAULT_TIMEZONE) })}
        </span>
      </div>

      <FormMessage tone="warning">{t("onceWarning")}</FormMessage>

      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => copy("code")}>
          {copied === "code" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          <span aria-live="polite">{copied === "code" ? t("copied") : t("copy")}</span>
        </Button>
        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => copy("link")}>
          {copied === "link" ? <Check className="size-4" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
          <span aria-live="polite">{copied === "link" ? t("copied") : t("copyLink")}</span>
        </Button>
      </div>
    </div>
  );
}
