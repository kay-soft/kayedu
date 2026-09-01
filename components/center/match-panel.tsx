"use client";

import { UserCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/shared/submit-button";
import type { MatchCandidate } from "@/lib/validation/people";

/**
 * The duplicate-match workflow, made visible (spec §5, docs/02 §3).
 *
 * One person exists once on the platform. When the phone or email typed into an
 * add form already belongs to someone, we surface **who** and **what matched**
 * and wait for staff to confirm — the new membership or student profile is then
 * attached to that existing person. Nothing is ever merged silently, and no
 * second identity is created.
 */
export function MatchPanel({
  match,
  linkLabel,
  blocked,
  onCancel,
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
          <dd className="font-medium text-text-primary">{match.name}</dd>
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

      <div className="flex flex-col gap-2 sm:flex-row">
        {blocked ? (
          match.existingProfileId ? (
            <Link
              href={ROUTES.centerStudent(match.existingProfileId)}
              className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground sm:w-auto"
            >
              {t("openProfile")}
            </Link>
          ) : null
        ) : (
          // Submitting the same form again — now carrying linkUserId — is what
          // attaches this center's record to the existing person.
          <SubmitButton className="w-full sm:w-auto">{linkLabel}</SubmitButton>
        )}

        <Button
          type="button"
          variant="outline"
          className="h-11 w-full px-4 sm:w-auto"
          onClick={onCancel}
        >
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}
