"use client";

import { useState } from "react";
import { Search, UserCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MatchCandidate, PhoneLookupResult } from "@/lib/validation/people";

/**
 * The receptionist phone lookup (M18, spec §5.1): look a phone number up
 * *before* the rest of the add-form is even filled in, reusing the exact
 * same duplicate-match workflow the full form's own submit already runs
 * (`resolveContact`/`describeMatch`) — never a raw "phone → record" fetch.
 * Minimum fields (name + what matched), rate-limited server-side, and
 * finding someone here never links anything by itself: "Use this person"
 * only pre-fills the form below, which still has to be submitted.
 */
export function PhoneLookupField({
  lookup,
  onMatch,
}: {
  lookup: (phone: string) => Promise<PhoneLookupResult>;
  onMatch: (match: MatchCandidate) => void;
}) {
  const t = useTranslations("People.phoneLookup");
  const tMatch = useTranslations("People.match");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PhoneLookupResult | null>(null);
  const [used, setUsed] = useState(false);

  async function runLookup() {
    if (phone.trim().length === 0) return;
    setPending(true);
    setUsed(false);
    try {
      setResult(await lookup(phone));
    } finally {
      setPending(false);
    }
  }

  const match = result?.status === "found" ? result.match : null;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-subtle p-3">
      <span className="text-xs font-medium text-text-secondary">{t("label")}</span>
      <div className="flex gap-2">
        <Input
          type="tel"
          inputMode="tel"
          dir="ltr"
          value={phone}
          onChange={(event) => {
            setPhone(event.currentTarget.value);
            setResult(null);
          }}
          onKeyDown={(event) => {
            // Enter looks the number up — it must not submit the form this sits in
            // (inside the class dialog that would try to create the class).
            if (event.key !== "Enter") return;
            event.preventDefault();
            void runLookup();
          }}
          placeholder="01xxxxxxxxx"
          className="h-10"
        />
        <Button
          type="button"
          variant="outline"
          className="h-10 px-3"
          disabled={pending || phone.trim().length === 0}
          onClick={runLookup}
        >
          <Search className="size-4" />
          {t("submit")}
        </Button>
      </div>

      {result?.status === "rateLimited" ? (
        <p className="text-xs text-danger">{t("rateLimited")}</p>
      ) : null}
      {result?.status === "notFound" ? (
        <p className="text-xs text-text-muted">{t("notFound")}</p>
      ) : null}

      {match && !used ? (
        <div className="flex flex-col gap-2 rounded-lg border border-info/30 bg-info-bg/60 p-3">
          <div className="flex items-start gap-2">
            <UserCheck className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-text-primary">{match.name}</p>
              {match.matchedOn.length > 0 ? (
                <p className="text-xs text-text-muted">
                  {tMatch("matchedBy", {
                    fields: match.matchedOn
                      .map((field) => tMatch(`matchedOn.${field}`))
                      .join(tMatch("matchedOnSeparator")),
                  })}
                </p>
              ) : null}
            </div>
          </div>
          <Button
            type="button"
            className="h-9 w-full sm:w-auto"
            onClick={() => {
              onMatch(match);
              setUsed(true);
            }}
          >
            {t("usePerson")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
