"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * The add-entity dialog pattern (docs/04-design-system.md §5 "Dialog"):
 * a centered modal from `sm` up, a **full-screen sheet below `sm`** per the
 * existing modal→sheet rule (docs/04 §6). One implementation for every
 * "Add X" flow, so a new entity screen reuses it rather than re-inventing a
 * modal.
 *
 * Wraps Base UI's Dialog primitives — already a dependency (`components/ui/
 * button.tsx` uses the same package) — so no new library is introduced.
 */
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Popup> & {
  showClose?: boolean;
}) {
  const t = useTranslations("Shared");
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className={cn(
          "fixed inset-0 z-50 bg-sidebar/50 transition-opacity duration-200",
          "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
        )}
      />
      <DialogPrimitive.Popup
        className={cn(
          // Mobile: a full-screen sheet — no floating card on a 375px phone.
          "fixed inset-0 z-50 flex flex-col overflow-y-auto bg-surface outline-none",
          // Opacity + scale only (DES, docs/04 §14.1a) — it had been
          // `transition-all`, which also animated the insets on a resize.
          "transition-[opacity,scale] duration-(--motion-slow) ease-(--ease-out)",
          "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
          // Nothing in a dialog that is animating out takes input (DES).
          "data-[ending-style]:pointer-events-none",
          // Desktop: a centered card. Horizontally by symmetric insets and
          // auto margins — direction-agnostic. (SYS: it was `start-1/2` plus a
          // physical `-translate-x-1/2`, which in RTL resolves `start` to
          // `right` and pushed every dialog half its width off-centre.)
          // DES: a 16px gutter until the max width takes over.
          "sm:inset-x-0 sm:bottom-auto sm:top-1/2 sm:mx-auto sm:max-h-[85vh] sm:w-[calc(100%-2rem)]",
          "sm:max-w-lg sm:-translate-y-1/2 sm:rounded-xl",
          "sm:shadow-card-hover sm:ring-1 sm:ring-foreground/10",
          "sm:data-[starting-style]:scale-95 sm:data-[ending-style]:scale-95",
          className,
        )}
        {...props}
      >
        {showClose ? (
          <DialogPrimitive.Close
            className="absolute end-3 top-3 flex size-11 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-ui focus-ring hover:bg-surface-hover hover:text-text-primary active:bg-surface-active sm:size-9"
            aria-label={t("close")}
          >
            <X className="size-5 sm:size-4" aria-hidden />
          </DialogPrimitive.Close>
        ) : null}
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-b border-border px-4 py-4 pe-14 sm:px-6",
        className,
      )}
      {...props}
    />
  );
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex-1 px-4 py-4 sm:px-6", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        // The device's safe area under the stacked buttons on a phone (DES).
        "flex flex-col gap-2 border-t border-border px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:px-6 sm:pb-4",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-lg font-semibold text-text-primary", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm text-text-secondary", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
