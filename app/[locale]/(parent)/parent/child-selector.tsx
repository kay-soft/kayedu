"use client";

/**
 * The child selector (spec §4.5 item 1) — a parent with 2+ verified children
 * switches between them. A plain GET `<select>`, state lives in the URL
 * (`?child=`), the same "no client state" pattern as `ScheduleDateFilter`.
 * Only ever offered options from `session.children` — already filtered to
 * VERIFIED (`requireParentUser`, `lib/auth/tenant.ts`) — so this control
 * itself can never expose an unverified child.
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
      <label htmlFor="parent-child" className="text-xs font-medium text-text-secondary">
        {label}
      </label>
      <select
        id="parent-child"
        name="child"
        defaultValue={selectedId}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </form>
  );
}
