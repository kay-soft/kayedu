"use client";

import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { UrlFilterForm } from "@/components/shared/url-filters";

/**
 * The child selector (spec §4.5 item 1) — a parent with 2+ (child, branch) options
 * switches between them. A plain GET form (`UrlFilterForm`: a soft navigation with JavaScript, docs/02 §14), state lives in the URL (`?child=`),
 * the same "no client state" pattern as `ParentDateFilter`. Only ever offered
 * options from `session.children` — ACTIVE family links only, each child's
 * active profiles at accessible branches (`requireParentUser`,
 * `lib/auth/tenant.ts`) — so this control itself can never expose a child
 * the parent is not linked to.
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
    <UrlFilterForm className="flex flex-col gap-1.5 sm:w-80">
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
    </UrlFilterForm>
  );
}
