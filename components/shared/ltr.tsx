import type { ReactNode } from "react";

/**
 * A left-to-right run inside text that follows the page (docs/04 §7, DES).
 *
 * A phone number, a student code, an email or a slug must read left to right
 * in Arabic too — but putting `dir="ltr"` on the *block* that holds it also
 * flips the block's alignment, so in Arabic the value jumped to the far (left)
 * edge, away from its label. Isolate the run instead: the block keeps the page
 * direction and alignment, the value keeps its own order.
 *
 * Times and dates need none of this — `lib/format.ts` returns strings that
 * carry their own direction (§3).
 */
export function Ltr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" translate="no" className={className}>
      {children}
    </bdi>
  );
}
