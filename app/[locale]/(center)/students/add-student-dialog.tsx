"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { StudentForm } from "@/app/[locale]/(center)/students/student-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { GradeOption } from "@/components/center/student-fields";

/**
 * The list-first pattern (docs/04 §5 "Dialog"): the students screen opens as
 * a dashboard, and "Add student" is a primary button that opens this dialog
 * rather than a form embedded in the page.
 */
export function AddStudentDialog({
  grades,
  noneLabel,
}: {
  grades: GradeOption[];
  noneLabel: string;
}) {
  const t = useTranslations("Students");
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button className="h-11 px-4">
            <Plus className="size-4" />
            {t("add")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addTitle")}</DialogTitle>
          <DialogDescription>{t("addDescription")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <StudentForm
            grades={grades}
            noneLabel={noneLabel}
            onCreated={() => setOpen(false)}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
