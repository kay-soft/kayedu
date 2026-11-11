"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, Circle, Eye, Plus, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { assistantSaveAssessmentAction } from "@/app/[locale]/(assistant)/assistant/[teacherId]/assessments/actions";
import { saveAssessmentAction } from "@/app/[locale]/(teacher)/teacher/assessments/actions";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { TimePicker } from "@/components/ui/time-picker";
import { ASSESSMENT_LIMITS, isReady, newDraftQuestion, readiness, totalPoints, type DraftError } from "@/lib/assessments";
import { TEACHER_SURFACE, assessmentRoutes, surfaceFields, type AssessmentSurface } from "@/lib/routes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";
import {
  IDLE_ASSESSMENT_STATE,
  instantFromFields,
  type AssessmentPayload,
  type DateTimeFields,
} from "@/lib/validation/assessments";
import { cn } from "@/lib/utils";

type Type = "EXAM" | "HOMEWORK";
type DateField = "windowStart" | "windowEnd" | "deadline";
type Toggle = "oneSitting" | "shuffle" | "showScore" | "showCorrectAnswers";

/** A question as the builder holds it: a client key for React, points as typed. */
type EditOption = { key: string; text: string; isCorrect: boolean };
type EditQuestion = { key: string; text: string; points: string; options: EditOption[] };
type EditState = Omit<AssessmentPayload, "questions"> & { questions: EditQuestion[] };

let keySeed = 0;
const nextKey = () => `k${(keySeed += 1)}`;

function toEdit(payload: AssessmentPayload): EditState {
  return {
    ...payload,
    questions: payload.questions.map((question) => ({
      key: nextKey(),
      text: question.text,
      points: String(question.points),
      options: question.options.map((option) => ({ key: nextKey(), ...option })),
    })),
  };
}

function toPayload(state: EditState): AssessmentPayload {
  return {
    ...state,
    questions: state.questions.map((question) => {
      const points = Number(question.points.trim());
      return {
        text: question.text,
        points: Number.isFinite(points) ? points : 0,
        options: question.options.map((option) => ({ text: option.text, isCorrect: option.isCorrect })),
      };
    }),
  };
}

/**
 * The exam / homework builder (W2, docs/04 §11.33). Everything is held in the
 * client until **Save draft** posts it as one `payload` — the server re-reads
 * every limit (lib/assessments.ts `draftErrors`) and the "Ready to publish"
 * list here is the same pure `readiness` it will enforce at publish (W3).
 * A first save creates the draft and lands on its edit page. Leaving with
 * unsaved changes asks the browser to confirm.
 */
export function AssessmentBuilder({
  mode,
  centerId,
  assessmentId,
  type,
  classGroupId,
  sessionId,
  zone,
  nowMs,
  todayIso,
  deadlineBasis,
  initial,
  surface = TEACHER_SURFACE,
}: {
  mode: "create" | "edit";
  /** The row's branch — re-resolved by the action, never trusted. */
  centerId: string;
  assessmentId?: string;
  type: Type;
  classGroupId?: string;
  sessionId?: string;
  /** The timezone every time here is typed and shown in (the session's, else the branch's). */
  zone: string;
  nowMs: number;
  todayIso: string;
  /** How a new homework's deadline was pre-filled (D-W03), for the muted line under it. */
  deadlineBasis?: "nextSession" | "fallback";
  initial: AssessmentPayload;
  /** W7b: the teacher's own builder, or an assistant's for that teacher (D-W37). */
  surface?: AssessmentSurface;
}) {
  const t = useTranslations("TeacherAssessments.builder");
  const tReady = useTranslations("TeacherAssessments.ready");
  const tDraft = useTranslations("TeacherAssessments.draftErrors");
  const tErrors = useTranslations("TeacherAssessments.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(
    surface.kind === "assistant" ? assistantSaveAssessmentAction : saveAssessmentAction,
    IDLE_ASSESSMENT_STATE,
  );
  const [edit, setEdit] = useState<EditState>(() => toEdit(initial));
  const payloadJson = JSON.stringify(toPayload(edit));

  // The last saved version: the initial one, then whatever was posted when a save answered "saved".
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [posted, setPosted] = useState(baseline);
  const [seenSave, setSeenSave] = useState<number | undefined>(undefined);
  if (state.savedAt !== undefined && state.savedAt !== seenSave) {
    setSeenSave(state.savedAt);
    setBaseline(posted);
  }
  const dirty = payloadJson !== baseline;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const draftErrors = useMemo(() => state.draftErrors ?? [], [state.draftErrors]);
  const errorAt = (path: string) => {
    const hit = draftErrors.find((error: DraftError) => error.path === path);
    return hit ? tDraft(hit.code) : state.fieldErrors?.[path] ? tErrors(state.fieldErrors[path]) : undefined;
  };

  const items = useMemo(() => {
    const instant = (fields: DateTimeFields) => {
      const value = instantFromFields(fields, zone);
      return value === "invalid" ? null : value;
    };
    const payload = toPayload(edit);
    return readiness(
      type,
      {
        windowStart: instant(edit.windowStart),
        windowEnd: instant(edit.windowEnd),
        deadline: instant(edit.deadline),
        questions: payload.questions,
      },
      new Date(nowMs),
    );
  }, [edit, nowMs, type, zone]);

  const L = ASSESSMENT_LIMITS;
  const set = <K extends keyof EditState>(key: K, value: EditState[K]) => setEdit((current) => ({ ...current, [key]: value }));
  const setDate = (field: DateField, part: keyof DateTimeFields, value: string) =>
    setEdit((current) => ({ ...current, [field]: { ...current[field], [part]: value } }));
  const updateQuestion = (index: number, change: (question: EditQuestion) => EditQuestion) =>
    setEdit((current) => ({
      ...current,
      questions: current.questions.map((question, i) => (i === index ? change(question) : question)),
    }));
  const moveQuestion = (index: number, by: -1 | 1) =>
    setEdit((current) => {
      const target = index + by;
      if (target < 0 || target >= current.questions.length) return current;
      const questions = [...current.questions];
      [questions[index], questions[target]] = [questions[target], questions[index]];
      return { ...current, questions };
    });
  const addQuestion = () =>
    setEdit((current) => {
      const fresh = newDraftQuestion();
      return {
        ...current,
        questions: [
          ...current.questions,
          {
            key: nextKey(),
            text: fresh.text,
            points: String(fresh.points),
            options: fresh.options.map((option) => ({ key: nextKey(), ...option })),
          },
        ],
      };
    });

  const total = totalPoints(toPayload(edit).questions.map((question) => ({ points: Math.max(0, question.points) })));

  const dateTimeRow = (field: DateField, label: string) => (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium text-text-primary">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${field}-date`} className="text-xs text-text-secondary">{t("date")}</Label>
          <DatePicker
            id={`${field}-date`}
            name={`${field}-date`}
            defaultValue={edit[field].date}
            todayIso={todayIso}
            clearable
            onValueChange={(value) => setDate(field, "date", value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${field}-time`} className="text-xs text-text-secondary">{t("time")}</Label>
          <TimePicker
            id={`${field}-time`}
            name={`${field}-time`}
            value={edit[field].time}
            onValueChange={(value) => setDate(field, "time", value)}
          />
        </div>
      </div>
      {errorAt(field) ? <FormMessage className="text-xs">{errorAt(field)}</FormMessage> : null}
    </fieldset>
  );

  const toggle = (key: Toggle, label: string, hint: string) => (
    <div className="flex min-h-11 items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col">
        <Label htmlFor={`toggle-${key}`} className="text-sm font-medium text-text-primary">{label}</Label>
        <p id={`toggle-${key}-hint`} className="text-xs text-text-secondary">{hint}</p>
      </div>
      <Switch
        id={`toggle-${key}`}
        aria-describedby={`toggle-${key}-hint`}
        checked={edit[key]}
        onCheckedChange={(checked) => set(key, checked)}
        className="mt-1"
      />
    </div>
  );

  return (
    <form
      action={formAction}
      onSubmit={() => setPosted(payloadJson)}
      className="flex flex-col gap-6"
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="centerId" value={centerId} />
      {Object.entries(surfaceFields(surface)).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="type" value={type} />
      {assessmentId ? <input type="hidden" name="assessmentId" value={assessmentId} /> : null}
      {classGroupId ? <input type="hidden" name="classGroupId" value={classGroupId} /> : null}
      {sessionId ? <input type="hidden" name="sessionId" value={sessionId} /> : null}
      <input type="hidden" name="payload" value={payloadJson} />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("details")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="assessment-title">{t("titleLabel")}</Label>
                <Input
                  id="assessment-title"
                  dir="auto"
                  value={edit.title}
                  maxLength={L.title}
                  placeholder={t(type === "EXAM" ? "titlePlaceholderExam" : "titlePlaceholderHomework")}
                  aria-invalid={errorAt("title") ? true : undefined}
                  onChange={(event) => set("title", event.target.value)}
                />
                {errorAt("title") ? <FormMessage className="text-xs">{errorAt("title")}</FormMessage> : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="assessment-instructions">
                  {t("instructionsLabel")} <span className="font-normal text-text-muted">{t("optional")}</span>
                </Label>
                <Textarea
                  id="assessment-instructions"
                  dir="auto"
                  rows={3}
                  value={edit.instructions}
                  maxLength={L.instructions}
                  onChange={(event) => set("instructions", event.target.value)}
                />
                <p className="text-xs text-text-secondary">{t("instructionsHint")}</p>
                {errorAt("instructions") ? <FormMessage className="text-xs">{errorAt("instructions")}</FormMessage> : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("timing")}</CardTitle>
              <CardDescription>{t("timezoneNote", { zone })}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {type === "EXAM" ? (
                <>
                  {dateTimeRow("windowStart", t("windowStart"))}
                  {dateTimeRow("windowEnd", t("windowEnd"))}
                </>
              ) : (
                <>
                  {dateTimeRow("deadline", t("deadline"))}
                  {deadlineBasis ? (
                    <p className="-mt-2 text-xs text-text-muted">
                      {t(deadlineBasis === "nextSession" ? "deadlineBasisNext" : "deadlineBasisFallback")}
                    </p>
                  ) : null}
                </>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="assessment-duration">
                  {t("duration")}
                  {type === "HOMEWORK" ? <span className="font-normal text-text-muted"> {t("optional")}</span> : null}
                </Label>
                <Input
                  id="assessment-duration"
                  dir="ltr"
                  inputMode="numeric"
                  className="sm:w-40"
                  value={edit.durationMinutes}
                  maxLength={4}
                  aria-describedby="assessment-duration-hint"
                  aria-invalid={errorAt("durationMinutes") ? true : undefined}
                  onChange={(event) => set("durationMinutes", event.target.value)}
                />
                <p id="assessment-duration-hint" className="text-xs text-text-secondary">
                  {t(type === "EXAM" ? "durationHintExam" : "durationHintHomework")}
                </p>
                {errorAt("durationMinutes") ? (
                  <FormMessage className="text-xs">{errorAt("durationMinutes")}</FormMessage>
                ) : null}
              </div>
              {type === "EXAM" ? toggle("oneSitting", t("oneSitting"), t("oneSittingHint")) : null}
            </CardContent>
          </Card>

          <section aria-labelledby="questions-heading" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="questions-heading" className="text-lg font-semibold text-text-primary">{t("questions")}</h2>
              <p className="text-sm text-text-secondary">{t("totalPoints", { count: total })}</p>
            </div>
            {errorAt("questions") ? <FormMessage>{errorAt("questions")}</FormMessage> : null}
            {edit.questions.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-start gap-1">
                  <p className="text-sm font-medium text-text-primary">{t("noQuestions")}</p>
                  <p className="text-sm text-text-secondary">{t("noQuestionsHint")}</p>
                </CardContent>
              </Card>
            ) : null}
            <ol className="flex flex-col gap-4">
              {edit.questions.map((question, index) => {
                const n = index + 1;
                const at = `questions.${index}`;
                return (
                  <li key={question.key}>
                    <Card>
                      <CardContent className="flex flex-col gap-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold text-text-primary">
                            {t("questionNumber", { n })}
                          </h3>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled={index === 0}
                              aria-label={t("moveUp", { n })}
                              title={t("moveUp", { n })}
                              onClick={() => moveQuestion(index, -1)}
                            >
                              <ArrowUp aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled={index === edit.questions.length - 1}
                              aria-label={t("moveDown", { n })}
                              title={t("moveDown", { n })}
                              onClick={() => moveQuestion(index, 1)}
                            >
                              <ArrowDown aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t("deleteQuestion", { n })}
                              title={t("deleteQuestion", { n })}
                              onClick={() =>
                                setEdit((current) => ({ ...current, questions: current.questions.filter((_, i) => i !== index) }))
                              }
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </div>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`${question.key}-text`}>{t("questionText")}</Label>
                            <Textarea
                              id={`${question.key}-text`}
                              dir="auto"
                              rows={2}
                              value={question.text}
                              maxLength={L.questionText}
                              onChange={(event) => updateQuestion(index, (q) => ({ ...q, text: event.target.value }))}
                            />
                            {errorAt(at) ? <FormMessage className="text-xs">{errorAt(at)}</FormMessage> : null}
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`${question.key}-points`}>{t("points")}</Label>
                            <Input
                              id={`${question.key}-points`}
                              dir="ltr"
                              inputMode="numeric"
                              maxLength={3}
                              value={question.points}
                              aria-invalid={errorAt(`${at}.points`) ? true : undefined}
                              onChange={(event) => updateQuestion(index, (q) => ({ ...q, points: event.target.value }))}
                            />
                            {errorAt(`${at}.points`) ? (
                              <FormMessage className="text-xs">{errorAt(`${at}.points`)}</FormMessage>
                            ) : null}
                          </div>
                        </div>

                        <fieldset className="flex flex-col gap-2">
                          <legend className="mb-1 text-sm font-medium text-text-primary">{t("options")}</legend>
                          <p className="text-xs text-text-secondary">{t("optionsHint")}</p>
                          {question.options.map((option, optionIndex) => {
                            const m = optionIndex + 1;
                            const atLeast = question.options.length <= L.minOptions;
                            return (
                              <div key={option.key} className="flex flex-col gap-1">
                                <div className="flex items-center gap-1">
                                  <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-hover">
                                    <input
                                      type="radio"
                                      name={`correct-${question.key}`}
                                      className="size-5 accent-brand"
                                      checked={option.isCorrect}
                                      aria-label={t("markCorrect", { n: m })}
                                      onChange={() =>
                                        updateQuestion(index, (q) => ({
                                          ...q,
                                          options: q.options.map((o, i) => ({ ...o, isCorrect: i === optionIndex })),
                                        }))
                                      }
                                    />
                                  </label>
                                  <Input
                                    dir="auto"
                                    className="min-w-0 flex-1"
                                    value={option.text}
                                    maxLength={L.optionText}
                                    aria-label={t("option", { n: m })}
                                    placeholder={t("option", { n: m })}
                                    onChange={(event) =>
                                      updateQuestion(index, (q) => ({
                                        ...q,
                                        options: q.options.map((o, i) => (i === optionIndex ? { ...o, text: event.target.value } : o)),
                                      }))
                                    }
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    disabled={atLeast}
                                    aria-label={atLeast ? `${t("removeOption", { n: m })} — ${t("removeOptionDisabled")}` : t("removeOption", { n: m })}
                                    title={atLeast ? t("removeOptionDisabled") : t("removeOption", { n: m })}
                                    onClick={() =>
                                      updateQuestion(index, (q) => ({ ...q, options: q.options.filter((_, i) => i !== optionIndex) }))
                                    }
                                  >
                                    <X aria-hidden />
                                  </Button>
                                </div>
                                {option.isCorrect ? (
                                  <p className="ps-12 text-xs font-medium text-success-fg">{t("correct")}</p>
                                ) : null}
                                {errorAt(`${at}.options.${optionIndex}`) ? (
                                  <FormMessage className="ps-12 text-xs">{errorAt(`${at}.options.${optionIndex}`)}</FormMessage>
                                ) : null}
                              </div>
                            );
                          })}
                          {question.options.length <= L.minOptions ? (
                            <p className="text-xs text-text-muted">{t("removeOptionDisabled")}</p>
                          ) : null}
                          {errorAt(`${at}.options`) ? <FormMessage className="text-xs">{errorAt(`${at}.options`)}</FormMessage> : null}
                          {question.options.length < L.maxOptions ? (
                            <Button
                              type="button"
                              variant="outline"
                              className="self-start"
                              onClick={() =>
                                updateQuestion(index, (q) => ({
                                  ...q,
                                  options: [...q.options, { key: nextKey(), text: "", isCorrect: false }],
                                }))
                              }
                            >
                              <Plus aria-hidden />
                              {t("addOption")}
                            </Button>
                          ) : null}
                        </fieldset>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ol>
            {edit.questions.length < L.maxQuestions ? (
              <Button type="button" variant="outline" className="self-start" onClick={addQuestion}>
                <Plus aria-hidden />
                {t("addQuestion")}
              </Button>
            ) : (
              <p className="text-sm text-text-secondary">{t("maxQuestions")}</p>
            )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-20">
          <Card>
            <CardHeader>
              <CardTitle>{t("settings")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {toggle("shuffle", t("shuffle"), t("shuffleHint"))}
              {toggle("showScore", t("showScore"), t("showScoreHint"))}
              {toggle("showCorrectAnswers", t("showCorrect"), t("showCorrectHint"))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{tReady("title")}</CardTitle>
              <CardDescription>{tReady("description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li key={item.key} className="flex items-start gap-2 text-sm">
                    {item.ok ? (
                      <Check className="mt-0.5 size-4 shrink-0 text-success-fg" aria-hidden />
                    ) : (
                      <Circle className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
                    )}
                    <span className={cn("min-w-0", item.ok ? "text-text-primary" : "text-text-secondary")}>
                      {tReady(item.key)}
                      <span className="sr-only"> — {tReady(item.ok ? "done" : "missing")}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs font-medium text-text-secondary">
                {tReady(isReady(items) ? "allDone" : "notYet")}
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t border-border bg-surface px-4 py-3 shadow-card sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 flex-col" aria-live="polite">
          <span className="text-sm font-medium text-text-primary">{t("totalPoints", { count: total })}</span>
          <span className="text-xs text-text-secondary">
            {dirty
              ? t(mode === "edit" ? "unsavedPreview" : "unsaved")
              : state.status === "saved"
                ? t("saved")
                : t("noChanges")}
          </span>
          {state.error ? <FormMessage className="text-xs">{tErrors(state.error)}</FormMessage> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mode === "edit" && assessmentId ? (
            <LinkButton
              href={assessmentRoutes(surface).preview(assessmentId)}
            >
              <Eye className="size-4" aria-hidden />
              {t("preview")}
            </LinkButton>
          ) : null}
          <SubmitButton pendingLabel={t("saving")}>{t("save")}</SubmitButton>
        </div>
      </div>
    </form>
  );
}
