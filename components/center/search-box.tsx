import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * A plain GET form: search state lives in the URL, so a result list is
 * shareable, survives a refresh, and needs no client JavaScript — which is what
 * a front desk on a poor connection actually wants.
 *
 * Hidden fields carry any other query params the page is already using so a
 * search does not silently drop them.
 */
export function SearchBox({
  name = "q",
  value,
  label,
  placeholder,
  submitLabel,
  keep,
}: {
  name?: string;
  value?: string;
  label: string;
  placeholder?: string;
  submitLabel: string;
  keep?: Record<string, string | undefined>;
}) {
  return (
    <form className="flex flex-col gap-2 sm:flex-row sm:items-end">
      {Object.entries(keep ?? {}).map(([key, keepValue]) =>
        keepValue ? (
          <input key={key} type="hidden" name={key} value={keepValue} />
        ) : null,
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <label
          htmlFor={`search-${name}`}
          className="text-xs font-medium text-text-secondary"
        >
          {label}
        </label>
        <Input
          id={`search-${name}`}
          name={name}
          type="search"
          defaultValue={value ?? ""}
          placeholder={placeholder}
          maxLength={80}
        />
      </div>

      <Button type="submit" variant="outline" className="h-11 px-4">
        <Search className="size-4" />
        {submitLabel}
      </Button>
    </form>
  );
}
