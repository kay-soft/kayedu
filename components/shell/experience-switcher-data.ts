import { getTranslations } from "next-intl/server";

import type { ExperienceEntry, ExperienceIcon, ExperienceKind } from "@/lib/auth/experiences";
import { listExperiences } from "@/lib/auth/tenant";

/** One row of the role switcher, already in the reader's language. */
export type ExperienceRow = {
  key: string;
  kind: ExperienceKind;
  icon: ExperienceIcon;
  title: string;
  subtitle: string | null;
  brand: ExperienceEntry["brand"] | null;
};

export type ExperienceRowGroup = { id: string; label: string; rows: ExperienceRow[] };

export type ExperienceSwitcherData = {
  /** What the header shows now; null on the hub, or on a portal page this account holds no entry for. */
  current: { key: string; icon: ExperienceIcon; label: string } | null;
  groups: ExperienceRowGroup[];
};

/**
 * What the role switcher renders (W5, D-W34), built from `listExperiences`:
 * `undefined` with one experience or none, so the control is not rendered at
 * all. All wording is decided here from messages, and the component names no
 * role. `currentKey` is what the shell's own gate resolved, never the cookie.
 */
export async function shellExperiences(
  userId: string,
  currentKey: string | null,
): Promise<ExperienceSwitcherData | undefined> {
  const entries = await listExperiences(userId);
  if (entries.length <= 1) return undefined;

  const [t, tRoles] = await Promise.all([getTranslations("Experiences"), getTranslations("Roles")]);

  const rolesOf = (entry: ExperienceEntry) => entry.label.roles.map((role) => tRoles(role)).join(t("roleSeparator"));

  const groups: ExperienceRowGroup[] = [];
  let current: ExperienceSwitcherData["current"] = null;

  for (const entry of entries) {
    const row = rowFor(entry, t, rolesOf(entry));
    if (entry.key === currentKey) {
      current = { key: entry.key, icon: entry.icon, label: triggerLabel(entry, t, tRoles) };
    }
    const id = entry.group.kind === "organization" ? `org-${entry.group.organizationId}` : entry.group.kind;
    const existing = groups.find((group) => group.id === id);
    if (existing) existing.rows.push(row);
    else groups.push({ id, label: groupLabel(entry, t), rows: [row] });
  }

  return { current, groups };
}

type Translate = Awaited<ReturnType<typeof getTranslations<"Experiences">>>;
type TranslateRole = Awaited<ReturnType<typeof getTranslations<"Roles">>>;

function groupLabel(entry: ExperienceEntry, t: Translate): string {
  switch (entry.group.kind) {
    case "portals":
      return t("groupPortals");
    case "platform":
      return t("groupPlatform");
    case "organization":
      return entry.group.name ?? t("groupBranches");
  }
}

function rowFor(entry: ExperienceEntry, t: Translate, roles: string): ExperienceRow {
  const base = { key: entry.key, kind: entry.kind, icon: entry.icon, brand: entry.brand ?? null };
  switch (entry.kind) {
    case "staff":
      // Under its organization's heading a branch is told apart by its name.
      return { ...base, title: entry.label.place ?? roles, subtitle: roles };
    case "rollup":
      return {
        ...base,
        title: t("wholeManagement"),
        subtitle: t("wholeManagementPlace", { organization: entry.label.place ?? "", count: entry.branchCount ?? 0 }),
      };
    case "student":
      return { ...base, title: t("student"), subtitle: t("studentPlace") };
    case "teacher":
      return { ...base, title: t("teacher"), subtitle: t("teacherPlace") };
    case "parent":
      return { ...base, title: t("parent"), subtitle: t("parentPlace") };
    case "assistant":
      // W7a: one row per teacher, named — only an effective link is listed.
      return { ...base, title: t("assistantOf", { teacher: entry.label.place ?? "" }), subtitle: t("assistantPlace") };
    case "admin":
      return { ...base, title: t("admin"), subtitle: t("adminPlace") };
  }
}

/**
 * What the closed control says. A role, never a branch: the branch switcher
 * beside it names the branch, and the teacher portal may be narrowed to one.
 */
function triggerLabel(entry: ExperienceEntry, t: Translate, tRoles: TranslateRole): string {
  switch (entry.kind) {
    case "staff":
      return tRoles(entry.label.roles[0]);
    case "rollup":
      return t("wholeManagement");
    default:
      return t(entry.kind);
  }
}
