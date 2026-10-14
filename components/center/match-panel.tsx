"use client";

import { Loader2, UserCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import { ROUTES } from "@/lib/routes";
import { Button } from "@/components/ui/button";
import type { MatchCandidate } from "@/lib/validation/people";
import { LinkButton } from "@/components/shared/link-button";

/**
 * The duplicate-match workflow, made visible (spec §5, docs/02 §3).
 *
 * One person exists once on the platform. When the phone or email typed into an
 * add form already belongs to someone, we surface **who** and **what matched**
 * and wait for staff to confirm — the new membership or student profile is then
 * attached to that existing person. Nothing is ever merged silently, and no
 * second identity is created.
 *
 * R10b: the panel sits full width directly under the phone field that caused
 * it, and its one affirmative action — **Use this person** — is the only solid
 * brand button on screen while the dialog's own submit is held back, with the
 * "different details" way out beside it as a plain outline button.
 */
export function MatchPanel({
  match,
  linkLabel,
  blocked,
  onCancel,
  pending,
}: {
  match: MatchCandidate;
  /** e.g. "Link to this person as a teacher". */
  linkLabel: string;
  /**
   * True when they already hold *this* relationship here — there is nothing
   * left to link. Holding a different one is fine: someone can teach at a
   * center and be registered as a student there too.
   */
  blocked: boolean;
  onCancel: () => void;
  /** The enclosing form is submitting (it submits through a transition). */
  pending?: boolean;
}) {
  const t = useTranslations("People.match");

  const matchedOn = match.matchedOn
    .map((field) => t(`matchedOn.${field}`))
    .join(t("matchedOnSeparator"));

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-info/30 bg-info-bg/60 p-4">
      <div className="flex items-start gap-3">
        <UserCheck className="mt-0.5 size-5 shrink-0 text-info" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">
            {t("title")}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            {match.existingHere
              ? t(`alreadyHere.${match.existingHere}`)
              : t("description")}
          </p>
          {match.existingHere && !blocked ? (
            <p className="mt-1 text-sm text-text-secondary">
              {t("description")}
            </p>
          ) : null}
        </div>
      </div>

      <dl className="rounded-lg bg-surface/80 p-3 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <dt className="text-xs font-medium text-text-muted">{t("person")}</dt>
          <dd className="font-medium text-text-primary">
            {/* D-08 (b): someone known only outside this organisation is
                never named here. */}
            {match.name ?? t("maskedName")}
          </dd>
        </div>
        {match.email ? (
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <dt className="text-xs font-medium text-text-muted">
              {t("matchedOn.email")}
            </dt>
            <dd className="text-text-secondary" dir="ltr">
              {match.email}
            </dd>
          </div>
        ) : null}
        {match.phone ? (
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <dt className="text-xs font-medium text-text-muted">
              {t("matchedOn.phone")}
            </dt>
            <dd className="text-text-secondary" dir="ltr">
              {match.phone}
            </dd>
          </div>
        ) : null}
        {matchedOn ? (
          <p className="mt-2 text-xs text-text-muted">
            {t("matchedBy", { fields: matchedOn })}
          </p>
        ) : null}
      </dl>

      <div className="flex flex-col-reverse gap-2 border-t border-info/20 pt-3 sm:flex-row sm:items-center">
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full px-4 sm:w-auto"
          onClick={onCancel}
        >
          {t("cancel")}
        </Button>

        {blocked ? (
          match.existingProfileId ? (
            <LinkButton href={ROUTES.centerStudent(match.existingProfileId)} variant="default" className="w-full sm:w-auto">
              {t("openProfile")}
            </LinkButton>
          ) : null
        ) : (
          // Submitting the same form again — now carrying linkUserId — is what
          // attaches this center's record to the existing person.
          <Button
            type="submit"
            disabled={pending}
            className="h-11 w-full gap-2 px-5 shadow-card sm:w-auto"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <UserCheck className="size-4" aria-hidden />
            )}
            {linkLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
