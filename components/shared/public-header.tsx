import { LocaleToggle } from "@/components/shared/locale-toggle";
import { ProductMark } from "@/components/shared/product-mark";

/**
 * The chrome of a screen outside every experience shell — the public landing,
 * the 404 and the locale-level error page (docs/04 §12 "DES additions"): the
 * product mark on the start edge, the language toggle on the end edge.
 */
export function PublicHeader() {
  return (
    <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6">
      <ProductMark />
      <LocaleToggle />
    </header>
  );
}
