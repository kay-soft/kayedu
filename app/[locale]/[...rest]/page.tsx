import { notFound } from "next/navigation";

/**
 * Any path under a locale that no route matches (DES, docs/04 §12). Without
 * this, an unknown URL never reached `app/[locale]/not-found.tsx` — Next only
 * renders that for an explicit `notFound()` — and fell through to its bare
 * English default page with no way back.
 */
export default function UnknownPath() {
  notFound();
}
