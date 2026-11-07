import { RecordNotFound } from "@/components/shared/record-not-found";
import { ROUTES } from "@/lib/routes";

/**
 * W7a: a teacher this account does not assist — no link, a removed one, or a
 * teacher whose premium has lapsed — reads as "not found", the same answer
 * whichever it is, so a swapped teacherId learns nothing (docs/04 §12).
 */
export default function NotFound() {
  return <RecordNotFound homeHref={ROUTES.selectCenter} />;
}
