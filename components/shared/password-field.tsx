"use client";

import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A password input with a show/hide toggle (docs/04 §12). A password is Latin
 * text, so the whole control is `dir="ltr"` in both locales: the eye sits
 * inside the field at the physical right in English and Arabic, and typed text
 * never runs under it. Only the control is pinned — the label and errors around
 * it (`Field`) keep following the page direction. The toggle is a real 44px
 * button rather than a bare icon. The value is still posted under `name`
 * exactly as before — only the input's `type` flips.
 */
export function PasswordField({
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "type">) {
  const t = useTranslations("Auth.fields");
  const [visible, setVisible] = useState(false);
  const label = visible ? t("hidePassword") : t("showPassword");

  return (
    <div className="relative" dir="ltr">
      <Input
        {...props}
        type={visible ? "text" : "password"}
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
