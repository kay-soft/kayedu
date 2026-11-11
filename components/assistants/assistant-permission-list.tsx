import { Check } from "lucide-react";
import { useTranslations } from "next-intl";

import type { AssistantPermission } from "@/lib/assistant-catalog";
import { cn } from "@/lib/utils";

/**
 * What an assistant may do, as text (W7a, docs/04 §11.36): one line per
 * granted permission of the fixed catalogue, with its plain-language meaning.
 * Shown on the redemption confirmation, the assistant's landing page, Account
 * settings and the teacher's own assistant cards. A check marks each line,
 * never colour alone; an empty list says so.
 */
export function AssistantPermissionList({
  permissions,
  compact,
  className,
}: {
  permissions: readonly AssistantPermission[];
  /** Labels only, no descriptions (cards). */
  compact?: boolean;
  className?: string;
}) {
  const t = useTranslations("Assistants.permissions");
  if (permissions.length === 0) {
    return <p className={cn("text-sm text-text-secondary", className)}>{t("none")}</p>;
  }
  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {permissions.map((permission) => (
        <li key={permission} className="flex items-start gap-2 text-sm">
          <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="font-medium text-text-primary">{t(`${permission}.label`)}</span>
            {compact ? null : <span className="text-text-secondary">{t(`${permission}.description`)}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
