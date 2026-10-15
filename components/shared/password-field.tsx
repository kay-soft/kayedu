"use client";

import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A password input with a show/hide toggle (docs/04 §12). The toggle sits on
 * the logical end edge, so it mirrors in Arabic, and is a real 44px button
 * rather than a bare icon. The value is still posted under `name` exactly as
 * before — only the input's `type` flips.
 */
export function PasswordField({
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "type">) {
  const t = useTranslations("Auth.fields");
  const [visible, setVisible] = useState(false);
  const label = visible ? t("hidePassword") : t("showPassword");

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        // A visible password is still not prose: keep it left-to-right and
        // unspell-checked, whichever locale the page is in.
        dir="ltr"
        autoCapitalize="none"
        spellCheck={false}
        className={cn("pe-12 text-start", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((value) => !value)}
        aria-label={label}
        aria-pressed={visible}
        title={label}
        className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-e-lg text-text-muted transition-ui focus-ring hover:text-text-primary active:text-brand"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
