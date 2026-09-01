"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { TeacherForm } from "@/app/[locale]/(center)/teachers/teacher-form";
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

/**
 * The list-first pattern (docs/04 §5 "Dialog"): the teachers screen opens as
 * a dashboard, and "Add teacher" is a primary button that opens this dialog
 * rather than a form embedded in the page.
 */
export function AddTeacherDialog() {
  const t = useTranslations("Teachers");
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
          <TeacherForm onCreated={() => setOpen(false)} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
