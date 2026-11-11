"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, Link2, MessageCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { FormMessage } from "@/components/shared/form-message";
import { AnchorButton } from "@/components/shared/link-button";
import { Ltr } from "@/components/shared/ltr";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { whatsAppShareUrl, workspaceJoinUrl } from "@/lib/routes";
import { DEFAULT_TIMEZONE } from "@/lib/scheduling";
import { formatWorkspaceShareCodeForDisplay } from "@/lib/workspace-share-code";

/**
 * A freshly created workspace share code, shown **once** (W10, D-W43 item 2;
 * docs/04 §11.37): the code large in an LTR run, when it stops working, the
 * "shown only once" warning, **Copy code**, **Copy link** (the join link with
 * the code in its fragment) and **Share on WhatsApp** (`wa.me` with the link
 * as its text and no phone number, so WhatsApp asks whom to send it to). The
 * code lives only in these props — stored hashed, never retrievable again,
 * gone when the dialog closes.
 */
export function WorkspaceCodeReveal({ code, expiresAt }: { code: string; expiresAt: string }) {
  const t = useTranslations("WorkspaceStudents.shareCode");
  const locale = useLocale() === "en" ? "en" : "ar";
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  // Rendered only after the action answered, so always in the browser.
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const display = formatWorkspaceShareCodeForDisplay(code);
  const link = workspaceJoinUrl(origin, locale, code);

  async function copy(kind: "code" | "link") {
    try {
      await navigator.clipboard.writeText(kind === "code" ? display : link);
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
        <Button type="button" variant="outline" className="h-11 w-full px-4 sm:w-auto" onClick={() => copy("code")}>
          {copied === "code" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          <span aria-live="polite">{copied === "code" ? t("copied") : t("copy")}</span>
        </Button>
        <Button type="button" variant="outline" className="h-11 w-full px-4 sm:w-auto" onClick={() => copy("link")}>
          {copied === "link" ? <Check className="size-4" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
          <span aria-live="polite">{copied === "link" ? t("copied") : t("copyLink")}</span>
        </Button>
        <AnchorButton
          href={whatsAppShareUrl(t("whatsAppText", { link }))}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full sm:w-auto"
        >
          <MessageCircle className="size-4" aria-hidden />
          {t("whatsApp")}
        </AnchorButton>
      </div>
    </div>
  );
}
