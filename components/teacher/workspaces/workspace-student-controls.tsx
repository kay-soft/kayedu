"use client";

import { MailPlus, Plus, UserMinus, UserPlus, Users, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  addWorkspaceStudentAction,
  cancelWorkspaceInvitationAction,
  copyWorkspaceStudentAction,
  enrolWorkspaceStudentAction,
  inviteWorkspaceStudentAgainAction,
  removeWorkspaceEnrollmentAction,
} from "@/app/[locale]/(teacher)/teacher/workspaces/student-actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import {
  IDLE_WORKSPACE_STUDENT_STATE,
  WORKSPACE_STUDENT_NAME_MAX_LENGTH,
} from "@/lib/validation/workspace-students";

/**
 * Teacher → Workspaces → Students and a class's roster (W8b, D-W39; docs/04
 * §11.37). Add student (name, phone, optional grade), Add from my other
 * workspaces, Invite again and Cancel invitation on an unlinked profile, and
 * Enrol / Remove on a class. The add and "Invite again" answer with the same
 * words whether or not an account matched — the server returns no difference
 * to show.
 */

/** One translator: the W8b refusals first, then the workspace's, then the generic line. */
export function useWorkspaceStudentMessage() {
  const t = useTranslations("WorkspaceStudents.errors");
  const tWorkspace = useTranslations("Workspaces.errors");
  return (key: string | undefined): string | undefined => {
    if (!key) return undefined;
    if (t.has(key)) return t(key);
    if (tWorkspace.has(key)) return tWorkspace(key);
    return tWorkspace("generic");
  };
}

export type GradeOption = { id: string; label: string };
export type CopyableGroupOption = {
  workspaceId: string;
  workspaceName: string;
  students: { id: string; label: string }[];
};

/** "Add student" — the D-W39 item 1 form. */
export function AddWorkspaceStudentButton({ workspaceId, grades }: { workspaceId: string; grades: GradeOption[] }) {
  const t = useTranslations("WorkspaceStudents.add");
  return (
    <DialogLauncher
      button={(open) => (
        <Button type="button" onClick={open} className="h-11 w-full px-4 sm:w-fit">
          <UserPlus className="size-4" aria-hidden />
          {t("button")}
        </Button>
      )}
      render={(dialog) => <AddStudentDialog {...dialog} workspaceId={workspaceId} grades={grades} />}
    />
  );
}

function AddStudentDialog({
  open,
  onOpenChange,
  workspaceId,
  grades,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  grades: GradeOption[];
}) {
  const t = useTranslations("WorkspaceStudents.add");
  const tPeople = useTranslations("People.fields");
  const message = useWorkspaceStudentMessage();
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(addWorkspaceStudentAction, IDLE_WORKSPACE_STUDENT_STATE);
  useActionFeedback(state, {
    success: () => {
      onOpenChange(false);
      return t("added");
    },
  });
  const errors = state.fieldErrors ?? {};
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={t("title")}
      description={t("description")}
      cancelLabel={t("cancel")}
      submitLabel={t("submit")}
      submitPending={pending}
      formProps={{ action: formAction, noValidate: true }}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <div className="flex flex-col gap-4">
        {state.error ? <FormMessage>{message(state.error)}</FormMessage> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="ws-student-first" label={tPeople("firstName")} error={message(errors.firstName)}>
            <Input id="ws-student-first" name="firstName" required maxLength={WORKSPACE_STUDENT_NAME_MAX_LENGTH} autoComplete="off" />
          </Field>
          <Field id="ws-student-last" label={tPeople("lastName")} error={message(errors.lastName)}>
            <Input id="ws-student-last" name="lastName" required maxLength={WORKSPACE_STUDENT_NAME_MAX_LENGTH} autoComplete="off" />
          </Field>
        </div>
        <Field id="ws-student-phone" label={tPeople("phone")} hint={t("phoneHint")} error={message(errors.phone)}>
          <Input id="ws-student-phone" name="phone" type="tel" inputMode="tel" dir="ltr" required maxLength={20} autoComplete="off" />
        </Field>
        <Field id="ws-student-grade" label={t("grade")} error={message(errors.gradeId)}>
          <Select id="ws-student-grade" name="gradeId" defaultValue="">
            <option value="">{t("noGrade")}</option>
            {grades.map((grade) => (
              <option key={grade.id} value={grade.id}>
                {grade.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </DialogShell>
  );
}

/** "Add from my other workspaces" — the teacher's own profiles elsewhere, copied (D-W39 item 2). */
export function CopyWorkspaceStudentButton({ workspaceId, groups }: { workspaceId: string; groups: CopyableGroupOption[] }) {
  const t = useTranslations("WorkspaceStudents.copy");
  if (groups.length === 0) return null;
  return (
    <DialogLauncher
      button={(open) => (
        <Button type="button" variant="outline" onClick={open} className="h-11 w-full px-4 sm:w-fit">
          <Users className="size-4" aria-hidden />
          {t("button")}
        </Button>
      )}
      render={(dialog) => <CopyStudentDialog {...dialog} workspaceId={workspaceId} groups={groups} />}
    />
  );
}

function CopyStudentDialog({
  open,
  onOpenChange,
  workspaceId,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  groups: CopyableGroupOption[];
}) {
  const t = useTranslations("WorkspaceStudents.copy");
  const message = useWorkspaceStudentMessage();
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(copyWorkspaceStudentAction, IDLE_WORKSPACE_STUDENT_STATE);
  useActionFeedback(state, {
    success: () => {
      onOpenChange(false);
      return t("added");
    },
  });
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={t("title")}
      description={t("description")}
      cancelLabel={t("cancel")}
      submitLabel={t("submit")}
      submitPending={pending}
      formProps={{ action: formAction }}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <div className="flex flex-col gap-4">
        {state.error ? <FormMessage>{message(state.error)}</FormMessage> : null}
        <Field id="ws-student-source" label={t("student")} error={message(state.fieldErrors?.source)}>
          <Select id="ws-student-source" name="source" defaultValue="" required>
            <option value="" disabled>
              {t("pick")}
            </option>
            {/* The product's Select reads plain <option> children only (no groups): each names its workspace. */}
            {groups.flatMap((group) =>
              group.students.map((student) => (
                <option key={`${group.workspaceId}:${student.id}`} value={`${group.workspaceId}:${student.id}`}>
                  {`${student.label} · ${group.workspaceName}`}
                </option>
              )),
            )}
          </Select>
        </Field>
      </div>
    </DialogShell>
  );
}

/** "Invite again" — at most once a day per profile; the same answer whether or not an account matched. */
export function InviteAgainButton({ workspaceId, studentProfileId }: { workspaceId: string; studentProfileId: string }) {
  const t = useTranslations("WorkspaceStudents.row");
  const message = useWorkspaceStudentMessage();
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(inviteWorkspaceStudentAgainAction, IDLE_WORKSPACE_STUDENT_STATE);
  useActionFeedback(state, { success: t("invited"), error: (key) => message(key) ?? null });
  return (
    <form action={formAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="studentProfileId" value={studentProfileId} />
      <Button type="submit" variant="outline" disabled={pending} className="h-11 w-full px-4 sm:w-fit">
        <MailPlus className="size-4" aria-hidden />
        {t("inviteAgain")}
      </Button>
    </form>
  );
}

/** "Cancel invitation" — withdraws whatever is pending; answered the same whether or not anything was. */
export function CancelInvitationButton({ workspaceId, studentProfileId }: { workspaceId: string; studentProfileId: string }) {
  const t = useTranslations("WorkspaceStudents.row");
  const message = useWorkspaceStudentMessage();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(cancelWorkspaceInvitationAction, IDLE_WORKSPACE_STUDENT_STATE);
  useActionFeedback(state, { success: t("cancelled"), error: (key) => message(key) ?? null });
  return (
    <ConfirmAction
      label={t("cancelInvitation")}
      icon={<X className="size-4" aria-hidden />}
      variant="outline"
      triggerClassName="h-11 w-full px-4 sm:w-fit"
      title={t("cancelTitle")}
      description={t("cancelDescription")}
      confirmLabel={t("cancelConfirm")}
      action={formAction}
      fields={{ locale, workspaceId, studentProfileId }}
    />
  );
}

/** A class page's "Enrol student" — one of the workspace's own active profiles (D-W39 item 11). */
export function EnrolStudentForm({
  workspaceId,
  classId,
  students,
}: {
  workspaceId: string;
  classId: string;
  students: { id: string; label: string }[];
}) {
  const t = useTranslations("WorkspaceStudents.roster");
  const message = useWorkspaceStudentMessage();
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(enrolWorkspaceStudentAction, IDLE_WORKSPACE_STUDENT_STATE);
  useActionFeedback(state, { success: t("enrolled") });
  if (students.length === 0) return <p className="text-sm text-text-secondary">{t("nobodyToEnrol")}</p>;
  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-end sm:p-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="classId" value={classId} />
      <div className="min-w-0 flex-1">
        {state.error ? <FormMessage>{message(state.error)}</FormMessage> : null}
        <Field id={`ws-enrol-${classId}`} label={t("student")} error={message(state.fieldErrors?.studentProfileId)}>
          <Select id={`ws-enrol-${classId}`} name="studentProfileId" defaultValue="">
            <option value="" disabled>
              {t("pick")}
            </option>
            {students.map((student) => (
              <option key={student.id} value={student.id}>
                {student.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button type="submit" disabled={pending} className="h-11 w-full px-4 sm:w-fit">
        <Plus className="size-4" aria-hidden />
        {t("enrol")}
      </Button>
    </form>
  );
}

/** Remove from the class (confirmed) — the staff removal's effect. */
export function RemoveEnrollmentButton({
  workspaceId,
  classId,
  enrollmentId,
  studentName,
}: {
  workspaceId: string;
  classId: string;
  enrollmentId: string;
  studentName: string;
}) {
  const t = useTranslations("WorkspaceStudents.roster");
  const message = useWorkspaceStudentMessage();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(removeWorkspaceEnrollmentAction, IDLE_WORKSPACE_STUDENT_STATE);
  useActionFeedback(state, { success: t("removed"), error: (key) => message(key) ?? null });
  return (
    <ConfirmAction
      label={t("remove", { name: studentName })}
      icon={<UserMinus className="size-4" aria-hidden />}
      iconOnly
      triggerClassName="size-11"
      title={t("removeTitle")}
      description={t("removeDescription")}
      confirmLabel={t("removeConfirm")}
      action={formAction}
      fields={{ locale, workspaceId, classId, enrollmentId }}
    />
  );
}
