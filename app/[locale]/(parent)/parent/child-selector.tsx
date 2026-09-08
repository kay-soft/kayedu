"use client";

import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

/**
 * The child selector (spec §4.5 item 1) — a parent with 2+ verified children
 * switches between them. A plain GET form, state lives in the URL (`?child=`),
 * the same "no client state" pattern as `ParentDateFilter`. Only ever offered
 * options from `session.children` — already filtered to VERIFIED
 * (`requireParentUser`, `lib/auth/tenant.ts`) — so this control itself can
 * never expose an unverified child.
 *
 * The control is the shared `Select` (docs/04 §5), so a parent on a phone
 * gets the same list, sized for a thumb, that staff get on the desk.
 */
export function ChildSelector({
  options,
  selectedId,
  label,
}: {
  options: { id: string; label: string }[];
  selectedId: string;
  label: string;
}) {
  return (
    <form className="flex flex-col gap-1.5 sm:w-80">
      <Label htmlFor="parent-child">{label}</Label>
      <Select
        id="parent-child"
        name="child"
        defaultValue={selectedId}
        submitOnChange
        options={options.map((option) => ({
          value: option.id,
          label: option.label,
        }))}
      />
    </form>
  );
}
