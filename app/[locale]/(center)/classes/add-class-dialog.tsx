"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  ClassForm,
  type ClassFormDefaults,
} from "@/app/[locale]/(center)/classes/class-form";
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
import type { SelectOption } from "@/components/center/class-fields";

/** The list-first pattern (docs/04 §5 "Dialog"), same as students/teachers. */
export function AddClassDialog({
  teachers,
  subjects,
  grades,
  educationSystems,
  educationSystemDefaultFixedShare,
  rooms,
  noneLabel,
  defaults,
}: {
  teachers: SelectOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  educationSystems: SelectOption[];
  educationSystemDefaultFixedShare: Record<string, number>;
  rooms: SelectOption[];
  noneLabel: string;
  defaults: ClassFormDefaults;
}) {
  const t = useTranslations("Classes");
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
          <ClassForm
            teachers={teachers}
            subjects={subjects}
            grades={grades}
            educationSystems={educationSystems}
            educationSystemDefaultFixedShare={educationSystemDefaultFixedShare}
            rooms={rooms}
            noneLabel={noneLabel}
            defaults={defaults}
            onCreated={() => setOpen(false)}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
