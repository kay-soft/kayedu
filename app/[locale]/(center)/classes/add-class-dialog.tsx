"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  NewClassDialogContent,
  type ClassFormDefaults,
} from "@/app/[locale]/(center)/classes/class-form";
import type { SelectOption } from "@/components/center/class-fields";
import type { TermOption } from "@/components/center/class-period-fields";
import type { RoomOption } from "@/components/center/room-set-picker";
import type { TeacherOption } from "@/components/center/teacher-picker";
import { DialogLauncher } from "@/components/shared/dialog-shell";
import { Button } from "@/components/ui/button";
import type { RoomLinkPair } from "@/lib/rooms";

/** The list-first pattern (docs/04 §5 "Dialog"), same as students/teachers. */
export function AddClassDialog({
  teachers,
  subjects,
  grades,
  educationSystems,
  educationSystemDefaultFixedShare,
  rooms,
  roomLinks,
  terms,
  noneLabel,
  defaults,
}: {
  teachers: TeacherOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  educationSystems: SelectOption[];
  educationSystemDefaultFixedShare: Record<string, number>;
  rooms: RoomOption[];
  roomLinks: RoomLinkPair[];
  terms: TermOption[];
  noneLabel: string;
  defaults: ClassFormDefaults;
}) {
  const t = useTranslations("Classes");

  return (
    <DialogLauncher
      button={(openDialog) => (
        <Button className="h-11 px-4" onClick={openDialog}>
          <Plus className="size-4" />
          {t("add")}
        </Button>
      )}
      render={(dialog) => (
        <NewClassDialogContent
          {...dialog}
          teachers={teachers}
          subjects={subjects}
          grades={grades}
          educationSystems={educationSystems}
          educationSystemDefaultFixedShare={educationSystemDefaultFixedShare}
          rooms={rooms}
          roomLinks={roomLinks}
          terms={terms}
          noneLabel={noneLabel}
          defaults={defaults}
        />
      )}
    />
  );
}
