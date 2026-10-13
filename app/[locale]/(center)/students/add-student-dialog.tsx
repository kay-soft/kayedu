"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { StudentForm } from "@/app/[locale]/(center)/students/student-form";
import { DialogLauncher } from "@/components/shared/dialog-shell";
import { Button } from "@/components/ui/button";
import type { GradeOption } from "@/components/center/student-fields";

/**
 * The list-first pattern (docs/04 §5 "Dialog"): the students screen opens as
 * a dashboard, and "Register student" is a primary button that opens this
 * dialog rather than a form embedded in the page. R10b: it is the shared
 * `DialogShell` (docs/04 §11.15, §11.19) — a wide sectioned dialog, a
 * full-screen sheet on a phone — mounted fresh on every open.
 */
export function AddStudentDialog({
  grades,
  noneLabel,
}: {
  grades: GradeOption[];
  noneLabel: string;
}) {
  const t = useTranslations("Students");

  return (
    <DialogLauncher
      button={(openDialog) => (
        <Button className="h-11 px-4" onClick={openDialog}>
          <Plus className="size-4" />
          {t("add")}
        </Button>
      )}
      render={(dialog) => (
        <StudentForm {...dialog} grades={grades} noneLabel={noneLabel} />
      )}
    />
  );
}
