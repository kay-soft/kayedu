"use client";

import { useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import { useFormStatus } from "react-dom";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { switchExperienceAction } from "@/app/[locale]/(auth)/actions";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { ExperienceGlyph } from "@/components/shell/experience-glyph";
import type { ExperienceRow, ExperienceSwitcherData } from "@/components/shell/experience-switcher-data";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { popoverItemClass } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The role switcher (W5, D-W13, D-W34; docs/04-design-system.md §11.32): every
 * experience this account has, next to the user menu in every shell's header.
 *
 * It is one dialog with two layouts in CSS, so nothing depends on measuring the
 * screen on the server: a full-width **bottom sheet** below `sm`, a panel hung
 * from the header at the trigger's own end edge from `sm` up.
 *
 * Choosing a row posts its key to `switchExperienceAction`, which looks it up in
 * the current list and lands on that experience's landing page. Nothing of the
 * old page travels (no `next`, no query). It is separate from the branch
 * switchers: those change the scope inside one experience.
 */
export function ExperienceSwitcher({ data }: { data: ExperienceSwitcherData }) {
  const t = useTranslations("Experiences");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [endOffset, setEndOffset] = useState(24);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstFocusRef = useRef<HTMLButtonElement>(null);

  const rows = data.groups.flatMap((group) => group.rows);
  const focusKey = data.current?.key ?? rows[0]?.key;

  function onOpenChange(next: boolean) {
    if (next && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const rtl = document.documentElement.dir === "rtl";
      setEndOffset(Math.max(8, rtl ? rect.left : window.innerWidth - rect.right));
    }
    setOpen(next);
  }

  /** The menu pattern's keys. The list is vertical, so they need no mirroring in RTL. */
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const targets: Record<string, number> = {
      ArrowDown: (at + 1) % items.length,
      ArrowUp: (at - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    items[target]?.focus();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        ref={triggerRef}
        aria-label={data.current ? t("trigger", { current: data.current.label }) : t("triggerNoCurrent")}
        className={cn(
          "group flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 transition-ui focus-ring",
          "text-sm font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
        )}
      >
        <ExperienceGlyph icon={data.current?.icon ?? null} className="size-5 shrink-0" />
        {/* Below md the mark stands alone: 375px has no room for a word, and
            the accessible name above still says it. */}
        <span className="hidden max-w-32 truncate md:block">{data.current?.label ?? t("triggerNoCurrent")}</span>
        <ChevronDown className="hidden size-4 shrink-0 text-text-muted md:block" aria-hidden />
      </DialogTrigger>

      <DialogContent
        initialFocus={firstFocusRef}
        backdropClassName="sm:bg-transparent"
        style={{ "--experience-end": `${endOffset}px` } as CSSProperties}
        className={cn(
          // Below sm: a full-width sheet on the bottom edge. It mirrors by itself.
          "inset-x-0 top-auto bottom-0 max-h-[85dvh] rounded-t-xl pb-[env(safe-area-inset-bottom)]",
          "transition-[opacity,scale,translate] data-[starting-style]:translate-y-full data-[ending-style]:translate-y-full",
          // From sm: a panel under the header, at the trigger's end edge.
          "sm:inset-x-auto sm:end-(--experience-end) sm:top-[4.25rem] sm:bottom-auto sm:mx-0 sm:w-80 sm:max-w-80",
          "sm:max-h-[min(32rem,calc(100dvh-5.5rem))] sm:translate-y-0 sm:pb-0",
          "sm:data-[starting-style]:translate-y-0 sm:data-[ending-style]:translate-y-0",
        )}
      >
        <DialogHeader className="px-4 py-3 sm:px-4">
          <DialogTitle className="text-base">{t("title")}</DialogTitle>
        </DialogHeader>

        <div
          role="menu"
          aria-label={t("listLabel")}
          aria-orientation="vertical"
          onKeyDown={onMenuKeyDown}
          className="scrollbar-neutral flex flex-col gap-2 overflow-y-auto p-2"
        >
          {data.groups.map((group) => (
            <div key={group.id} role="group" aria-labelledby={`experience-group-${group.id}`} className="flex flex-col gap-0.5">
              <p id={`experience-group-${group.id}`} className="truncate px-2.5 pt-1 pb-0.5 text-xs font-medium text-text-muted">
                {group.label}
              </p>
              {group.rows.map((row) => {
                const initial = row.key === focusKey ? firstFocusRef : undefined;
                return row.key === data.current?.key ? (
                  // Already here: choosing it only closes the sheet.
                  <button
                    key={row.key}
                    ref={initial}
                    type="button"
                    role="menuitem"
                    aria-current="true"
                    onClick={() => setOpen(false)}
                    className={popoverItemClass}
                  >
                    <RowBody row={row} />
                    <span className="flex shrink-0 items-center gap-1 text-xs font-medium">
                      <Check className="size-4" aria-hidden />
                      {t("current")}
                    </span>
                  </button>
                ) : (
                  <form key={row.key} action={switchExperienceAction} role="none">
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="key" value={row.key} />
                    <SwitchRow row={row} buttonRef={initial} />
                  </form>
                );
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SwitchRow({ row, buttonRef }: { row: ExperienceRow; buttonRef?: Ref<HTMLButtonElement> }) {
  const { pending } = useFormStatus();
  return (
    <button ref={buttonRef} type="submit" role="menuitem" disabled={pending} aria-busy={pending || undefined} className={popoverItemClass}>
      <RowBody row={row} />
      {pending ? <Loader2 className="size-4 shrink-0 animate-spin text-text-muted" aria-hidden /> : null}
    </button>
  );
}

function RowBody({ row }: { row: ExperienceRow }) {
  return (
    <>
      {row.brand ? (
        <BrandAvatar name={row.brand.name} logoUrl={row.brand.logoUrl} themeColor={row.brand.themeColor} size="sm" />
      ) : (
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <ExperienceGlyph icon={row.icon} className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{row.title}</span>
        {row.subtitle ? <span className="block truncate text-xs text-text-muted">{row.subtitle}</span> : null}
      </span>
    </>
  );
}
