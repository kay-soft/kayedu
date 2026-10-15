"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/components/ui/toast";

/**
 * A read-only link with a Copy button — the staff invitation and the admin's
 * founding-owner invitation (DES, Phase 3). A copy the browser refuses
 * (no permission, an insecure origin) had failed silently: it now says so and
 * selects the link, so it can be copied by hand.
 */
export function CopyLinkField({
  id,
  href,
  label,
  hint,
  copyLabel,
  copiedLabel,
  failedLabel,
}: {
  id: string;
  href: string;
  label: string;
  hint: string;
  copyLabel: string;
  copiedLabel: string;
  failedLabel: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          ref={input}
          id={id}
          readOnly
          value={href}
          dir="ltr"
          aria-describedby={`${id}-hint`}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(href);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
              notify("error", failedLabel);
              input.current?.focus();
            }
          }}
        >
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          <span aria-live="polite">{copied ? copiedLabel : copyLabel}</span>
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-xs text-text-secondary">
        {hint}
      </p>
    </div>
  );
}
