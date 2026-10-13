"use client";

import { Fragment, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The one dialog shell for the class and session dialogs (R6,
 * docs/04-design-system.md §11.15): New class, Edit class, New session,
 * Edit rooms and Reschedule. Desktop: a wide card (`max-w-4xl`, ~896px) whose
 * **body scrolls on its own** between a **fixed header and footer** — the
 * title and the actions never scroll away. Below `md`: a full-screen sheet
 * (docs/04 §6), the same three bands, the footer's buttons stacked full-width
 * at 44px. The footer is the same everywhere: a Cancel (outline) and one
 * primary action, identical size and style — callers pass labels, not
 * markup, so a dialog cannot drift from the others.
 *
 * Wraps the existing `Dialog` primitives; no new library. Pass `formProps` to
 * make header-body-footer one `<form>` (so the footer's submit button submits
 * it); leave it off for a dialog that is only a confirmation.
 */
export function DialogShell({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  size = "wide",
  formProps,
  cancelLabel,
  submitLabel,
  submitPending,
  submitDisabled,
  submitVariant = "default",
  footerExtra,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens it — rendered through `DialogTrigger`. */
  trigger?: ReactElement;
  title: string;
  description?: string;
  size?: "wide" | "narrow";
  formProps?: Omit<ComponentProps<"form">, "className" | "children">;
  cancelLabel: string;
  /** The primary action's label; omit for a dialog with no primary (read-only). */
  submitLabel?: string;
  submitPending?: boolean;
  submitDisabled?: boolean;
  submitVariant?: "default" | "destructive";
  /** Extra footer content on the start side (e.g. a hint beside the buttons). */
  footerExtra?: ReactNode;
  children: ReactNode;
}) {
  const bands = (
    <>
          <DialogHeader className="shrink-0">
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogBody className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</DialogBody>
          <DialogFooter className="shrink-0 flex-col-reverse bg-surface sm:items-center">
            {footerExtra ? <div className="min-w-0 sm:me-auto">{footerExtra}</div> : null}
            <Button
              type="button"
              variant="outline"
              className={DIALOG_ACTION_CLASS}
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel}
            </Button>
            {submitLabel ? (
              <Button
                type="submit"
                variant={submitVariant}
                disabled={submitPending || submitDisabled}
                className={DIALOG_ACTION_CLASS}
              >
                {submitPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {submitLabel}
              </Button>
            ) : null}
          </DialogFooter>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogTrigger render={trigger} /> : null}
      <DialogContent
        className={cn(
          // The popup clips; the body is what scrolls (header/footer stay put).
          "overflow-hidden sm:max-h-[90vh]",
          size === "wide" ? "sm:max-w-4xl" : "sm:max-w-lg",
        )}
      >
        {formProps ? (
          <form {...formProps} className={BANDS_CLASS}>
            {bands}
          </form>
        ) : (
          <div className={BANDS_CLASS}>{bands}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Header, body and footer stack in one flex column; only the body scrolls. */
const BANDS_CLASS = "flex min-h-0 flex-1 flex-col";

/** Both footer buttons: 44px, full-width on a phone, content-width from `sm`. */
export const DIALOG_ACTION_CLASS = "h-11 w-full px-5 sm:w-auto sm:min-w-28";

/**
 * A titled card inside a dialog body (R6 — "Basics", "Teacher", "Room(s)",
 * "Class period", "Weekly schedule", "Pricing & centre cut"). Lay sections in
 * `DialogSections`: one column below `lg`, two from `lg`, a section that needs
 * the full width takes `wide`.
 */
export function FormSection({
  title,
  description,
  icon,
  wide,
  headerAction,
  children,
  className,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  /** Spans both columns from `lg`. */
  wide?: boolean;
  headerAction?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-border p-3 sm:p-4",
        wide && "lg:col-span-2",
        className,
      )}
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            {icon ? <span className="text-text-muted [&_svg]:size-4">{icon}</span> : null}
            {title}
          </h3>
          {description ? <p className="mt-0.5 text-xs text-text-muted">{description}</p> : null}
        </div>
        {headerAction}
      </header>
      {children}
    </section>
  );
}

export function DialogSections({ children }: { children: ReactNode }) {
  return <div className="grid items-start gap-4 lg:grid-cols-2">{children}</div>;
}

/**
 * Opens a dialog that **starts fresh every time** (R6): `button` draws the
 * opener, `render` draws the dialog. Each open mounts a new instance (a new
 * `key`), so a form never shows the last submit's errors or half-typed fields,
 * while closing leaves the same instance mounted just long enough for the
 * exit transition. Used by every class and session dialog.
 */
export function DialogLauncher({
  button,
  render,
}: {
  button: (openDialog: () => void) => ReactNode;
  render: (dialog: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  return (
    <>
      {button(() => {
        setGeneration((current) => current + 1);
        setOpen(true);
      })}
      {generation > 0 ? <Fragment key={generation}>{render({ open, onOpenChange: setOpen })}</Fragment> : null}
    </>
  );
}
