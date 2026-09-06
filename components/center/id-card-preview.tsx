/**
 * Shows the card exactly as `renderIdCardSvg()` produced it — the same string
 * that is written to Storage and the same one the print view uses, so a center
 * never previews one thing and prints another (docs/04 §5).
 *
 * The SVG is generated server-side from escaped values in lib/id-card.ts; no
 * user input reaches this markup unescaped.
 */
export function IdCardPreview({
  svg,
  className,
}: {
  svg: string;
  className?: string;
}) {
  return (
    <div
      // Landscape credit-card proportions, capped so it stays on a 375px
      // screen and grows to a comfortable size on desktop (docs/04 §6).
      className={`w-full max-w-[420px] [&>svg]:h-auto [&>svg]:w-full ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
