import { getTranslations } from "next-intl/server";

import { GeneralSettingsForm } from "@/app/[locale]/(center)/settings/general-form";
import { SectionHeader } from "@/components/shared/section-header";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { DEFAULT_CENTER_VISIBILITY_DAYS, DEFAULT_TEACHER_VISIBILITY_DAYS } from "@/lib/db/visibility";

/**
 * General center configuration: the default center cut, teacher timeout,
 * default late threshold and timezone. A center created with no settings row
 * still renders — the form saves through an upsert.
 */
export default async function GeneralSettingsPage() {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "center.settings.edit");

  const settings = await scoped(ctx).settings.get();
  const t = await getTranslations("Settings.general");

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <GeneralSettingsForm
        values={{
          // Defaults mirror the schema, so an unconfigured center opens on the
          // documented starting point rather than on blanks.
          defaultShareType: settings?.defaultShareType ?? "PERCENTAGE",
          defaultShareValue: settings?.defaultShareValue ?? 15,
          teacherTimeoutDays: settings?.teacherTimeoutDays ?? null,
          defaultLateThreshold: settings?.defaultLateThreshold ?? 10,
          timezone: settings?.timezone ?? "Africa/Cairo",
          scheduleConflictPolicy: settings?.scheduleConflictPolicy ?? "WARN",
          teacherEditDeadlineHours: settings?.teacherEditDeadlineHours ?? null,
          centerDataVisibilityDays: settings?.centerDataVisibilityDays ?? DEFAULT_CENTER_VISIBILITY_DAYS,
          teacherDataVisibilityDays: settings?.teacherDataVisibilityDays ?? DEFAULT_TEACHER_VISIBILITY_DAYS,
          publicListing: settings?.publicListing ?? true,
        }}
      />
    </div>
  );
}
