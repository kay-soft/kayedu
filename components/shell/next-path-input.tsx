"use client";

import { usePathname } from "@/lib/i18n/navigation";

/**
 * The page a form was submitted from, locale-less, as `next` (T6): picking a
 * branch on the pick-a-branch screen lands back on the same page. The server
 * accepts it only through `safeNextPath`.
 */
export function NextPathInput() {
  const pathname = usePathname();
  return <input type="hidden" name="next" value={pathname} />;
}
