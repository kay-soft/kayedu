import { RecordNotFound } from "@/components/shared/record-not-found";
import { ROUTES } from "@/lib/routes";

/**
 * An unlisted, unknown or not-yet-open branch, class or teacher (F5): the same
 * 404 for each, inside the public shell — a guest can't tell "unlisted" from
 * "does not exist".
 */
export default function NotFound() {
  return <RecordNotFound homeHref={ROUTES.explore} />;
}
