"use client";

import { Toast } from "@base-ui/react/toast";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * The one toast layer (docs/04-design-system.md §14.2) — every mutation
 * answers. Built on Base UI's `Toast` (already a dependency), with a global
 * manager so a toast can be raised from any client component or hook.
 *
 * Bottom-centre on a phone; the bottom **end** corner from `sm` (a logical
 * inset, so it sits on the left in Arabic). Success ~4s, info ~5s, error stays
 * until dismissed — an error that vanishes before it is read is the silence
 * this layer exists to remove. Hover or focus pauses the timer (Base UI).
 */
export const toastManager = Toast.createToastManager();

export type ToastKind = "success" | "error" | "info";

const TIMEOUT: Record<ToastKind, number> = { success: 4000, info: 5000, error: 0 };

export function notify(
  kind: ToastKind,
  title: string,
  options?: { description?: string; action?: { label: string; onClick: () => void } },
) {
  return toastManager.add({
    type: kind,
    title,
    description: options?.description,
    timeout: TIMEOUT[kind],
    priority: kind === "error" ? "high" : "low",
    actionProps: options?.action
      ? { children: options.action.label, onClick: options.action.onClick }
      : undefined,
  });
}

const ICON = {
  success: { Icon: CheckCircle2, className: "text-success-fg" },
  error: { Icon: AlertCircle, className: "text-danger-fg" },
  info: { Icon: Info, className: "text-info-fg" },
} as const;

function ToastList() {
  const { toasts } = Toast.useToastManager();
  const t = useTranslations("Shared.toast");

  return toasts.map((toast) => {
    const kind = (toast.type as ToastKind | undefined) ?? "info";
    const { Icon, className } = ICON[kind] ?? ICON.info;
    return (
      <Toast.Root
        key={toast.id}
        toast={toast}
        className={cn(
          "flex w-full items-start gap-3 rounded-xl border border-border bg-surface p-3 pe-1.5 text-sm text-text-primary shadow-popover",
          "transition-[opacity,translate] duration-(--motion-base) ease-(--ease-out)",
          "data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          "data-[limited]:hidden",
        )}
      >
        <Icon className={cn("mt-0.5 size-5 shrink-0", className)} aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
          <Toast.Title className="font-medium text-pretty" />
          <Toast.Description className="text-text-secondary text-pretty" />
          {toast.actionProps ? (
            <Toast.Action className="mt-1.5 inline-flex h-9 w-fit items-center rounded-lg border border-border-control bg-surface px-3 text-sm font-medium transition-ui focus-ring hover:bg-surface-hover active:bg-surface-active" />
          ) : null}
        </div>
        <Toast.Close
          aria-label={t("close")}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-ui focus-ring hover:bg-surface-hover hover:text-text-primary"
        >
          <X className="size-4" aria-hidden />
        </Toast.Close>
      </Toast.Root>
    );
  });
}

/** Mounted once, in the locale root layout, so every experience shares it. */
export function Toaster() {
  const t = useTranslations("Shared.toast");
  return (
    <Toast.Provider toastManager={toastManager} limit={4}>
      <Toast.Portal>
        <Toast.Viewport
          aria-label={t("region")}
          className="fixed inset-x-4 bottom-4 z-[70] mx-auto flex max-w-[22.5rem] flex-col-reverse gap-2 outline-none sm:inset-x-auto sm:end-6 sm:bottom-6 sm:mx-0 sm:w-[22.5rem]"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
