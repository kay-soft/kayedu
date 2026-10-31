import { getTranslations } from "next-intl/server";

import { formatDate, formatMoney, formatTimeRange } from "@/lib/format";

/**
 * What the student confirms before they join anything (U8, spec §4.3 item 2b):
 * the class, its branch and teacher, when it meets, and what a session costs.
 * Built on the server — already translated and formatted — so the client
 * dialog is only layout (CLAUDE.md rule 10: money and dates format through
 * `lib/format.ts`; nothing here is computed on the client).
 */
export type JoinSummary = {
  /** "Subject · Grade". */
  classLabel: string;
  branch: string;
  teacher: string;
  /** "EGP 50 / session". */
  price: string;
  /** A whole class: its weekly slots ("Sunday 16:00 – 18:00"). */
  schedule?: string[];
  /** A whole class: "1 Nov 2026 to 30 Jan 2027". */
  period?: string;
  /** One session: "Sunday 1 Nov 2026 · 16:00 – 18:00". */
  when?: string;
};

/** The class-level facts, shared by the whole-class and single-session summaries. */
export async function buildJoinSummary(input: {
  locale: string;
  subjectName: string | null;
  gradeName: string | null;
  branch: string;
  teacher: string;
  /** Piastres per session. */
  price: number;
  schedules?: { dayOfWeek: number; startTime: string; endTime: string }[];
  startDate?: Date;
  endDate?: Date;
}): Promise<JoinSummary> {
  const { locale } = input;
  const tClass = await getTranslations("Explore.class");
  const tCard = await getTranslations("Explore.card");
  const tClasses = await getTranslations("Classes");
  const dayNames = tClasses.raw("dayNames") as string[];

  return {
    classLabel: [input.subjectName, input.gradeName].filter(Boolean).join(" · ") || tClass("untitled"),
    branch: input.branch,
    teacher: input.teacher,
    price: tCard("perSession", { price: formatMoney(input.price, locale) }),
    schedule: input.schedules
      ? input.schedules.map((slot) => `${dayNames[slot.dayOfWeek]} ${formatTimeRange(slot.startTime, slot.endTime, locale)}`)
      : undefined,
    period:
      input.startDate && input.endDate
        ? tClass("periodValue", { from: formatDate(input.startDate, locale), to: formatDate(input.endDate, locale) })
        : undefined,
  };
}

/** One session's "when" for a single-session booking. */
export function sessionWhen(locale: string, session: { date: Date; startTime: string; endTime: string }): string {
  return `${formatDate(session.date, locale)} · ${formatTimeRange(session.startTime, session.endTime, locale)}`;
}
