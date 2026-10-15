"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { TeacherForm } from "@/app/[locale]/(center)/teachers/teacher-form";
import { DialogLauncher } from "@/components/shared/dialog-shell";
import { Button } from "@/components/ui/button";

/**
 * The list-first pattern (docs/04 §5 "Dialog"): the teachers screen opens as
 * a dashboard, and "Add teacher" is a primary button that opens this dialog
 * rather than a form embedded in the page. R10b: the shared `DialogShell`
 * (docs/04 §11.15, §11.19), mounted fresh on every open.
 */
export function AddTeacherDialog() {
  const t = useTranslations("Teachers");

  return (
    <DialogLauncher
      button={(openDialog) => (
        <Button className="h-11 px-4" onClick={openDialog}>
          <Plus className="size-4" />
          {t("add")}
        </Button>
      )}
      render={(dialog) => <TeacherForm {...dialog} />}
    />
  );
}
