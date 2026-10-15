import { RecordNotFound } from "@/components/shared/record-not-found";
import { ROUTES } from "@/lib/routes";

/** A missing record on a signed-out screen — back to sign-in (docs/04 §12). */
export default function NotFound() {
  return <RecordNotFound homeHref={ROUTES.login} />;
}
