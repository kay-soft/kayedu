"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeFamilyCode } from "@/lib/family-code";
import { useRouter } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * The parent portal's "Link your child" (F3). It writes nothing: it carries
 * the typed code to `/family/join` in the URL **fragment**, where the join
 * form posts it — so the read-only parent portal keeps no write path of its
 * own (`check:parent` sweeps `app/[locale]/(parent)/` for "use server").
 */
export function LinkChildPrompt({ label, continueLabel, invalidLabel }: { label: string; continueLabel: string; invalidLabel: string }) {
  const tJoin = useTranslations("Family.join");
  const router = useRouter();
  const [code, setCode] = useState("");
  const [invalid, setInvalid] = useState(false);

  return (
    <form
      noValidate
      className="flex w-full flex-col gap-3 sm:max-w-sm"
      onSubmit={(event) => {
        event.preventDefault();
        const normalized = normalizeFamilyCode(code);
        if (!normalized) {
          setInvalid(true);
          return;
        }
        router.push(`${ROUTES.familyJoin}#${normalized}`);
      }}
    >
      <Field id="parent-link-code" label={label} hint={tJoin("codeHint")} error={invalid ? invalidLabel : undefined}>
        <Input
          id="parent-link-code"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setInvalid(false);
          }}
          dir="ltr"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
          placeholder="ABCD-2345"
          className="font-mono tracking-widest uppercase"
        />
      </Field>
      <Button type="submit" className="w-full sm:w-fit">
        {continueLabel}
        <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
      </Button>
    </form>
  );
}
