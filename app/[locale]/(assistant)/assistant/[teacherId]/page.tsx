import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { AssistantPermissionList } from "@/components/assistants/assistant-permission-list";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAssistantSession } from "@/lib/auth/assistant-context";
import { formatDate } from "@/lib/format";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.home");
  return { title: t("metaTitle") };
}

/**
 * The assistant's landing page (W7a, D-W36, docs/04 §11.36): the teacher's
 * name and what the teacher granted, as text. Nothing to act on yet — the
 * working pages come with W7b. The name is read only through an effective
 * link of the session's user for this route's teacher (the layout's gate,
 * re-run here from the per-request cache), so nobody else ever sees it.
 */
export default async function AssistantHomePage({ params }: { params: Promise<{ teacherId: string }> }) {
  const { teacherId } = await params;
  const session = await getAssistantSession(teacherId);
  if (!session) notFound();
  const [t, tPresets, locale] = await Promise.all([
    getTranslations("Assistants.home"),
    getTranslations("Assistants.presets"),
    getLocale(),
  ]);
  const { link } = session;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title", { teacher: link.teacherName })} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("permissionsTitle")}</CardTitle>
          <CardDescription>
            {t("permissionsDescription", {
              preset: tPresets(`${link.preset}.label`),
              date: formatDate(link.since, locale),
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <AssistantPermissionList permissions={link.permissions} />
          <p className="text-sm text-text-secondary">{t("nothingYet")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
