"use client";

import { startTransition, useState, type FormEvent } from "react";
import { PauseCircle, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  IDLE_BRANCH_ADMIN_STATE,
  type BranchAdminState,
} from "@/app/[locale]/(admin)/admin/centers/branch-action-state";
import {
  deleteBranchAction,
  endBranchPauseAction,
  pauseBranchAction,
  restoreBranchAction,
  updateBranchAction,
} from "@/app/[locale]/(admin)/admin/centers/branch-actions";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { SectionHeader } from "@/components/shared/section-header";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BRANCH_PAUSE_REASON_MAX, BRANCH_THEME_SWATCHES, MAX_PAUSE_DAYS } from "@/lib/branch-setup";
import { formatDate, formatDay, formatNumber } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";
import { cn } from "@/lib/utils";

/**
 * The platform admin's branch tools on `/admin/centers/[id]` and
 * `/admin/organizations/[id]` (U5). Each posts a `branch-actions.ts` Server
 * Action, which re-checks everything in `lib/db/branch-admin.ts` — the forms
 * only make the rules visible before the admin commits.
 */

// ── Edit ───────────────────────────────────────────────────────────────────

export function BranchEditForm({
  centerId,
  name,
  nameEn,
  themeColor,
}: {
  centerId: string;
  name: string;
  nameEn: string | null;
  themeColor: string;
}) {
  const t = useTranslations("AdminBranches.edit");
  const tErrors = useTranslations("AdminBranches.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(updateBranchAction, IDLE_BRANCH_ADMIN_STATE);
  const [color, setColor] = useState(themeColor);
  const fieldErrors = state.fieldErrors;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={centerId} />
      <input type="hidden" name="themeColor" value={color} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="branch-edit-name">{t("name")}</Label>
          <Input
            id="branch-edit-name"
            name="name"
            dir="rtl"
            required
            maxLength={120}
            defaultValue={name}
            aria-invalid={fieldErrors?.name ? true : undefined}
          />
          {fieldErrors?.name ? <FieldError>{tErrors(fieldErrors.name)}</FieldError> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="branch-edit-name-en">{t("nameEn")}</Label>
          <Input
            id="branch-edit-name-en"
            name="nameEn"
            dir="ltr"
            maxLength={120}
            defaultValue={nameEn ?? ""}
            aria-describedby="branch-edit-name-en-hint"
            aria-invalid={fieldErrors?.nameEn ? true : undefined}
          />
          <p id="branch-edit-name-en-hint" className="text-xs text-text-muted">
            {t("nameEnHint")}
          </p>
          {fieldErrors?.nameEn ? <FieldError>{tErrors(fieldErrors.nameEn)}</FieldError> : null}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text-primary">{t("themeColor")}</span>
        <div className="flex flex-wrap items-center gap-1">
          <input
            type="color"
            aria-label={t("themeColor")}
            value={color}
            onChange={(event) => setColor(event.currentTarget.value)}
            className="h-11 w-11 shrink-0 cursor-pointer rounded-lg border border-border bg-background p-1"
          />
          <span dir="ltr" className="px-1 font-mono text-xs text-text-muted">
            {color}
          </span>
          {BRANCH_THEME_SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              title={swatch}
              aria-label={t("useColor", { color: swatch })}
              aria-pressed={color.toLowerCase() === swatch.toLowerCase()}
              onClick={() => setColor(swatch)}
              className="inline-flex size-11 items-center justify-center rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-brand/25"
            >
              <span
                className={cn(
                  "size-6 rounded-full border border-border-strong",
                  color.toLowerCase() === swatch.toLowerCase() && "ring-2 ring-brand ring-offset-2 ring-offset-background",
                )}
                style={{ backgroundColor: swatch }}
              />
            </button>
          ))}
        </div>
        {fieldErrors?.themeColor ? <FieldError>{tErrors(fieldErrors.themeColor)}</FieldError> : null}
      </div>

      <p className="text-xs text-text-muted">{t("fixedNote")}</p>

      <SubmitButton className="w-full sm:w-auto sm:self-start">{t("save")}</SubmitButton>
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? <FormMessage tone="success">{t("saved")}</FormMessage> : null}
    </form>
  );
}

// ── Pause ──────────────────────────────────────────────────────────────────

function ImpactSummary({ impact }: { impact: NonNullable<BranchAdminState["impact"]> }) {
  const t = useTranslations("AdminBranches.pause");
  const locale = useLocale();
  return (
    <ul className="flex flex-col gap-1 text-sm text-text-secondary">
      <li>{t("impact.sessions", { count: impact.sessions, value: formatNumber(impact.sessions, locale) })}</li>
      <li>{t("impact.classes", { count: impact.classes, value: formatNumber(impact.classes, locale) })}</li>
      <li>{t("impact.bookings", { count: impact.bookings, value: formatNumber(impact.bookings, locale) })}</li>
      {impact.keptWithPayments > 0 ? (
        <li>
          {t("impact.keptWithPayments", {
            count: impact.keptWithPayments,
            value: formatNumber(impact.keptWithPayments, locale),
          })}
        </li>
      ) : null}
    </ul>
  );
}

type ActionProps = {
  state: BranchAdminState;
  formAction: (formData: FormData) => void;
  pending?: boolean;
};

/**
 * The Pause card. It owns both action states — the pause's and "End pause
 * now"'s — because each one, on success, revalidates the page and the server
 * swaps the form for the status (or back): a state kept inside the swapped
 * component would unmount with it, and the admin would never see what the
 * pause cancelled or which sessions stayed cancelled over a clash.
 */
export function BranchPauseCard({
  centerId,
  todayKey,
  pause,
}: {
  centerId: string;
  todayKey: string;
  pause: { id: string; startDate: Date; endDate: Date; current: boolean } | null;
}) {
  const t = useTranslations("AdminBranches.pause");
  const locale = useLocale();
  const [pauseState, pauseAction, pausePending] = useGuardedActionState(pauseBranchAction, IDLE_BRANCH_ADMIN_STATE);
  const [endState, endAction] = useGuardedActionState(endBranchPauseAction, IDLE_BRANCH_ADMIN_STATE);

  return (
    <div className="flex flex-col gap-4">
      {pause ? (
        <>
          {pauseState.status === "paused" && pauseState.impact ? (
            <FormMessage tone="success">{t("done", { count: pauseState.impact.sessions })}</FormMessage>
          ) : null}
          <BranchPauseStatus centerId={centerId} pause={pause} state={endState} formAction={endAction} />
        </>
      ) : (
        <>
          {endState.status === "pauseEnded" ? (
            <div className="flex flex-col gap-2">
              <FormMessage tone="success">
                {t("ended", { count: endState.restored ?? 0, value: formatNumber(endState.restored ?? 0, locale) })}
              </FormMessage>
              {(endState.keptConflicts ?? 0) > 0 ? (
                <FormMessage tone="warning">
                  {t("keptConflicts", {
                    count: endState.keptConflicts ?? 0,
                    value: formatNumber(endState.keptConflicts ?? 0, locale),
                  })}
                </FormMessage>
              ) : null}
              {(endState.keptOther ?? 0) > 0 ? (
                <p className="text-sm text-text-secondary">
                  {t("keptOther", {
                    count: endState.keptOther ?? 0,
                    value: formatNumber(endState.keptOther ?? 0, locale),
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
          <BranchPauseForm
            centerId={centerId}
            todayKey={todayKey}
            state={pauseState}
            formAction={pauseAction}
            pending={pausePending}
          />
        </>
      )}
    </div>
  );
}

/**
 * No live pause: the range and an optional reason, then **Preview** (nothing
 * is written) — the numbers, and **Pause branch** to commit those same
 * fields. Changing a date clears the preview, so the confirmation always
 * matches what was previewed.
 */
function BranchPauseForm({
  centerId,
  todayKey,
  state,
  formAction,
  pending,
}: { centerId: string; todayKey: string } & ActionProps) {
  const t = useTranslations("AdminBranches.pause");
  const tErrors = useTranslations("AdminBranches.errors");
  const locale = useLocale();
  const [range, setRange] = useState({ start: "", end: "" });
  const [previewedFor, setPreviewedFor] = useState<string | null>(null);
  const rangeKey = `${range.start}|${range.end}`;
  const showPreview = state.status === "previewed" && state.impact && previewedFor === rangeKey;

  function submit(intent: "preview" | "confirm") {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      formData.set("intent", intent);
      if (intent === "preview") setPreviewedFor(rangeKey);
      startTransition(() => formAction(formData));
    };
  }

  const fieldErrors = state.fieldErrors;
  return (
    <form
      onSubmit={submit(showPreview ? "confirm" : "preview")}
      className="flex flex-col gap-4"
      noValidate
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={centerId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="branch-pause-start">{t("start")}</Label>
          <DatePicker
            id="branch-pause-start"
            name="startDate"
            todayIso={todayKey}
            required
            onValueChange={(value) => setRange((current) => ({ ...current, start: value }))}
            aria-invalid={fieldErrors?.startDate ? true : undefined}
          />
          {fieldErrors?.startDate ? <FieldError>{tErrors(fieldErrors.startDate)}</FieldError> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="branch-pause-end">{t("end")}</Label>
          <DatePicker
            id="branch-pause-end"
            name="endDate"
            todayIso={todayKey}
            required
            onValueChange={(value) => setRange((current) => ({ ...current, end: value }))}
            aria-invalid={fieldErrors?.endDate ? true : undefined}
          />
          {fieldErrors?.endDate ? <FieldError>{tErrors(fieldErrors.endDate)}</FieldError> : null}
        </div>
      </div>
      <p className="text-xs text-text-muted">{t("rangeHint", { days: MAX_PAUSE_DAYS })}</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="branch-pause-reason">{t("reason")}</Label>
        <Textarea id="branch-pause-reason" name="reason" rows={2} maxLength={BRANCH_PAUSE_REASON_MAX} />
        <p className="text-xs text-text-muted">{t("reasonHint")}</p>
      </div>

      {showPreview && state.impact ? (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning-bg p-3">
          <p className="text-sm font-medium text-text-primary">{t("previewTitle")}</p>
          <ImpactSummary impact={state.impact} />
          <p className="text-xs text-text-secondary">{t("previewNote")}</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        {showPreview ? (
          <>
            <Button type="submit" className="h-11 w-full sm:w-auto" disabled={pending}>
              <PauseCircle className="size-4" />
              {t("confirm")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full sm:w-auto"
              onClick={() => setPreviewedFor(null)}
            >
              {t("changeDates")}
            </Button>
          </>
        ) : (
          <Button type="submit" variant="outline" className="h-11 w-full sm:w-auto" disabled={pending}>
            {t("preview")}
          </Button>
        )}
      </div>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
    </form>
  );
}

/** A live pause: when it runs, and "End pause now" (bookings are not restored — the dialog says so). */
function BranchPauseStatus({
  centerId,
  pause,
  state,
  formAction,
}: {
  centerId: string;
  pause: { id: string; startDate: Date; endDate: Date; current: boolean };
} & ActionProps) {
  const t = useTranslations("AdminBranches.pause");
  const tErrors = useTranslations("AdminBranches.errors");
  const locale = useLocale();
  const from = formatDay(pause.startDate, locale);
  const to = formatDay(pause.endDate, locale);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-primary">
        {pause.current ? t("activeNow", { from, to }) : t("scheduled", { from, to })}
      </p>
      <ConfirmAction
        label={t("endNow")}
        variant="outline"
        tone="default"
        triggerClassName="h-11 w-full sm:w-auto sm:self-start"
        title={t("endTitle")}
        description={t("endDescription")}
        action={formAction}
        fields={{ locale, id: centerId, pauseId: pause.id }}
      />
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
    </div>
  );
}

// ── Delete / restore ───────────────────────────────────────────────────────

/**
 * Delete (soft). The dialog lists what disappears for the centre and waits for
 * the branch's name, typed exactly; a known blocker (the only branch, a live
 * session, an open settlement) disables the trigger with its reason. The
 * server re-checks all of it under the organization lock.
 */
export function BranchDeleteDialog({
  centerId,
  branchName,
  blocker,
}: {
  centerId: string;
  branchName: string;
  blocker: string | null;
}) {
  const t = useTranslations("AdminBranches.delete");
  const tErrors = useTranslations("AdminBranches.errors");
  return (
    <div className="flex flex-col gap-2">
      <DialogLauncher
        button={(openDialog) => (
          <Button
            variant="outline"
            className="h-11 w-full border-danger/30 text-danger-fg hover:bg-danger-bg sm:w-auto sm:self-start"
            onClick={openDialog}
            disabled={blocker !== null}
            aria-describedby={blocker ? "branch-delete-blocker" : undefined}
          >
            <Trash2 className="size-4" />
            {t("open")}
          </Button>
        )}
        render={(dialog) => <DeleteForm {...dialog} centerId={centerId} branchName={branchName} />}
      />
      {blocker ? (
        <p id="branch-delete-blocker" className="text-sm text-text-secondary">
          {tErrors(blocker)}
        </p>
      ) : null}
    </div>
  );
}

function DeleteForm({
  open,
  onOpenChange,
  centerId,
  branchName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  centerId: string;
  branchName: string;
}) {
  const t = useTranslations("AdminBranches.delete");
  const tErrors = useTranslations("AdminBranches.errors");
  const tShared = useTranslations("Shared");
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(deleteBranchAction, IDLE_BRANCH_ADMIN_STATE);
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === branchName.trim();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={t("title", { branch: branchName })}
      description={t("description")}
      formProps={{ onSubmit, noValidate: true }}
      cancelLabel={tShared("keep")}
      submitLabel={t("confirm")}
      submitVariant="destructive"
      submitPending={pending}
      submitDisabled={!matches}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={centerId} />
      <div className="flex flex-col gap-4">
        <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-text-secondary">
          <li>{t("lose.branch")}</li>
          <li>{t("lose.classes")}</li>
          <li>{t("lose.students")}</li>
          <li>{t("lose.staff")}</li>
        </ul>
        <p className="text-sm text-text-secondary">{t("restoreNote")}</p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="branch-delete-confirm">{t("typeName", { branch: branchName })}</Label>
          <Input
            id="branch-delete-confirm"
            name="confirmName"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            aria-invalid={state.fieldErrors?.confirmName ? true : undefined}
          />
          {state.fieldErrors?.confirmName ? <FieldError>{tErrors(state.fieldErrors.confirmName)}</FieldError> : null}
        </div>
        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      </div>
    </DialogShell>
  );
}

export type DeletedBranchRow = {
  id: string;
  name: string;
  themeColor: string;
  deletedAt: Date;
  restorableUntil: Date | null;
  restorable: boolean;
};

/**
 * `/admin/organizations/[id]` → Deleted branches, with Restore while the
 * window lasts. One client section owns the restore result: a restored branch
 * leaves this list on the revalidated render, and its success (or the reason
 * it was refused) must outlive its card — so the message sits above the list,
 * and the section still renders for it after the last card has gone.
 */
export function DeletedBranches({ rows }: { rows: DeletedBranchRow[] }) {
  const t = useTranslations("AdminBranches");
  const tErrors = useTranslations("AdminBranches.errors");
  const tCenters = useTranslations("AdminCenters");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(restoreBranchAction, IDLE_BRANCH_ADMIN_STATE);

  if (rows.length === 0 && state.status !== "restored") return null;
  return (
    <section className="flex flex-col gap-4">
      <SectionHeader title={t("deleted.title")} description={t("deleted.description")} />
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "restored" ? <FormMessage tone="success">{t("restore.done")}</FormMessage> : null}
      {rows.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((branch) => (
            <li key={branch.id}>
              <Card className="h-full">
                <CardContent className="flex h-full flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <BrandAvatar name={branch.name} themeColor={branch.themeColor} size="sm" />
                    <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{branch.name}</span>
                    <Badge variant="danger">{t("deleted.badge")}</Badge>
                  </div>
                  <span className="text-sm text-text-secondary">
                    {t("deleted.on", { date: formatDate(branch.deletedAt, locale) })}
                  </span>
                  <span className="text-sm text-text-muted">
                    {branch.restorable && branch.restorableUntil
                      ? t("deleted.until", { date: formatDate(branch.restorableUntil, locale) })
                      : t("deleted.expired")}
                  </span>
                  <div className="mt-auto flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap">
                    {branch.restorable ? (
                      <ConfirmAction
                        label={t("restore.open")}
                        variant="outline"
                        tone="default"
                        triggerClassName="h-11 w-full sm:w-auto"
                        title={t("restore.title", { branch: branch.name })}
                        description={t("restore.description")}
                        action={formAction}
                        fields={{ locale, id: branch.id }}
                      />
                    ) : null}
                    <LinkButton href={ROUTES.adminCenter(branch.id)} variant="ghost" size="sm">
                      {tCenters("openDetail")}
                    </LinkButton>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
