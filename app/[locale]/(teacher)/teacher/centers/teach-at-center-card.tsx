"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { requestToTeachAction } from "@/app/[locale]/(teacher)/teacher/centers/actions";
import { CatalogPickerFields } from "@/components/center/catalog-picker-fields";
import { TimeRangeFields } from "@/components/center/time-range-fields";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { CatalogPickerData } from "@/lib/catalog-picker";
import { IDLE_TEACHER_STATE } from "@/lib/validation/teacher";
import { Button } from "@/components/ui/button";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

type CenterCard = { id: string; name: string; logoUrl: string | null; themeColor: string };

const DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;

export function TeachAtCenterCard({
  center,
  catalog,
}: {
  center: CenterCard;
  /** The global catalog (U3: system → grade → subject) — a teacher with no branch reads no branch's picks. */
  catalog: CatalogPickerData;
}) {
  const t = useTranslations("TeacherCenters");
  const tDays = useTranslations("Classes");
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3">
        <BrandAvatar
          name={center.name}
          logoUrl={center.logoUrl}
          themeColor={center.themeColor}
          size="lg"
        />
        <CardTitle className="truncate text-base">{center.name}</CardTitle>
      </CardHeader>
      <CardContent>
        {open ? (
          <RequestForm
            centerId={center.id}
            centerName={center.name}
            catalog={catalog}
            dayNames={tDays.raw("dayNames") as string[]}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <Button type="button" onClick={() => setOpen(true)} variant="outline" className="h-11 px-4 border-dashed w-full">
            {t("requestButton")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function RequestForm({
  centerId,
  centerName,
  catalog,
  dayNames,
  onCancel,
}: {
  centerId: string;
  centerName: string;
  catalog: CatalogPickerData;
  dayNames: string[];
  onCancel: () => void;
}) {
  const t = useTranslations("TeacherCenters.request");
  const tErrors = useTranslations("TeacherCenters.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(requestToTeachAction, IDLE_TEACHER_STATE);

  if (state.status === "created") {
    return <FormMessage tone="success">{t("submitted")}</FormMessage>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="centerId" value={centerId} />

      <p className="text-sm font-medium text-text-primary">{t("title", { center: centerName })}</p>
      <p className="text-xs text-text-muted">{t("description")}</p>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      {/* The card is a third of the page wide from `lg`: the three pickers stack. */}
      <div className="grid gap-4">
        <CatalogPickerFields
          idPrefix={centerId}
          data={catalog}
          systemName={null}
          noneLabel={t("none")}
          errors={{
            gradeId: state.fieldErrors?.gradeId ? tErrors(state.fieldErrors.gradeId) : undefined,
            subjectId: state.fieldErrors?.subjectId ? tErrors(state.fieldErrors.subjectId) : undefined,
          }}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id={`${centerId}-dayOfWeek`}
          label={t("day")}
          error={state.fieldErrors?.dayOfWeek ? tErrors(state.fieldErrors.dayOfWeek) : undefined}
        >
          <Select id={`${centerId}-dayOfWeek`} name="dayOfWeek" defaultValue="0">
            {DAY_INDEXES.map((day) => (
              <option key={day} value={day}>
                {dayNames[day]}
              </option>
            ))}
          </Select>
        </Field>

        <TimeRangeFields
          idPrefix={`${centerId}-time`}
          startLabel={t("start")}
          endLabel={t("end")}
          defaultStart="16:00"
          defaultEnd="18:00"
          error={
            state.fieldErrors?.startTime || state.fieldErrors?.endTime
              ? tErrors((state.fieldErrors.startTime ?? state.fieldErrors.endTime)!)
              : undefined
          }
          required
          className="sm:col-span-2"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${centerId}-lateThresholdMinutes`}
          label={t("lateThreshold")}
          error={
            state.fieldErrors?.lateThresholdMinutes
              ? tErrors(state.fieldErrors.lateThresholdMinutes)
              : undefined
          }
        >
          <Input
            id={`${centerId}-lateThresholdMinutes`}
            name="lateThresholdMinutes"
            type="number"
            min={0}
            defaultValue={10}
          />
        </Field>
      </div>

      <Field id={`${centerId}-note`} label={t("note")} optional>
        <Textarea id={`${centerId}-note`} name="note" maxLength={300} rows={2} placeholder={t("notePlaceholder")} />
      </Field>

      <div className="flex gap-2">
        <SubmitButton className="self-start">{t("submit")}</SubmitButton>
        <Button type="button" onClick={onCancel} variant="outline" className="h-11 px-4">
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
