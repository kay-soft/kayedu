import { RecordNotFound } from "@/components/shared/record-not-found";
import { ROUTES } from "@/lib/routes";

/** A missing record inside this experience — shown in its own shell (docs/04 §12). */
export default function NotFound() {
  return <RecordNotFound homeHref={ROUTES.centerDashboard} />;
}
