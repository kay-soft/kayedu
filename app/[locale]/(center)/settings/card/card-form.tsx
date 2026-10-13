"use client";

import {
  useActionState,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ChevronDown, Plus, RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { saveCardLayoutAction } from "@/app/[locale]/(center)/settings/actions";
import {
  ColorField,
  ElementControls,
  RemoveButton,
} from "@/app/[locale]/(center)/settings/card/card-style-controls";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ToggleRow } from "@/components/settings/toggle-row";
import { cardContrastIssues } from "@/lib/card-style";
import {
  CARD_BOUNDS,
  CARD_ELEMENT_FIELDS,
  CARD_ELEMENT_KEYS,
  DEFAULT_BACKGROUND_STOPS,
  DEFAULT_CARD_BACKGROUND,
  DEFAULT_CARD_LAYOUT,
  FALLBACK_BRAND_COLOR,
  IMAGE_ELEMENT_KEYS,
  normalizeHex,
  type CardElementKey,
} from "@/lib/card-layout";
import { formatNumber } from "@/lib/format";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  renderIdCardSvg,
  studentQrPayload,
  type CardElement,
  type CardLayout,
} from "@/lib/id-card";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import { cn } from "@/lib/utils";

type ElementMap = Partial<Record<CardElementKey, CardElement>>;
type ElementPatch = { [K in keyof CardElement]?: CardElement[K] | undefined };

/** Where an element landed on the card face, in the SVG's own units. */
type Box = { x: number; y: number; width: number; height: number };

const DEFAULTS = DEFAULT_CARD_LAYOUT.elements as unknown as Record<
  CardElementKey,
  CardElement
>;

/** A pointer must travel this far (px) before a press becomes a drag (R9). */
const DRAG_THRESHOLD = 4;

type DragState = {
  key: CardElementKey;
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  moved: boolean;
};

/**
 * The visual ID-card layout editor (M18, R9; docs/04 §11.6). A centre never
 * sees JSON at any point — this component moves, restyles, adds and removes
 * elements on a live preview and serializes the result into a hidden field only
 * at submit time.
 *
 * **One render path.** The preview is `renderIdCardSvg()` — the same function
 * that produces the print view and the stored file — called with `annotate` so
 * every element's markup sits in a `<g data-card-el>` the editor can measure.
 * The drag targets are transparent boxes laid over those measured bounds, so an
 * element is grabbed by any part of it (a logo or photo as much as a text), and
 * there is no second renderer to drift from the first.
 *
 * **Selection is state, not a side effect of the pointer.** It is set on
 * pointer-down and cleared only by pressing empty card space, pressing another
 * element, or Escape — never by a release, a click, a blur or a hover. (The
 * pre-R9 editor cleared it from the card's `onClick`; after a drag the pointer
 * is no longer over the element that moved under it, so the browser dispatched
 * the click to their common ancestor — the card — which deselected.)
 */
export function CardLayoutForm({
  initialElements,
  background: initialBackground,
  accent: initialAccent,
  footer: initialFooter,
  headerBand: initialHeaderBand,
  centerName,
  brandColor,
}: {
  initialElements: ElementMap;
  background: string;
  accent?: string;
  footer?: string;
  headerBand?: boolean;
  centerName: string;
  brandColor: string;
}) {
  const t = useTranslations("Settings.card");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const dir = locale === "ar" ? "rtl" : "ltr";
  const theme = normalizeHex(brandColor) ?? FALLBACK_BRAND_COLOR;

  const [state, formAction] = useActionState(
    saveCardLayoutAction,
    IDLE_ACTION_STATE,
  );
  const [elements, setElements] = useState<ElementMap>(initialElements);
  // A solid colour, or the built-in gradient. A stored value the schema would
  // refuse (a 3-digit hex, a name from before the editor) is normalized here so
  // that saving an old layout never fails on a field the user did not touch.
  const [background, setBackground] = useState<string>(
    normalizeHex(initialBackground) ?? DEFAULT_CARD_BACKGROUND,
  );
  const [accent, setAccent] = useState<string | undefined>(
    normalizeHex(initialAccent) ?? undefined,
  );
  const [footer, setFooter] = useState<string | undefined>(
    normalizeHex(initialFooter) ?? undefined,
  );
  const [headerBand, setHeaderBand] = useState<boolean>(initialHeaderBand === true);
  const [selected, setSelected] = useState<CardElementKey | null>(null);
  const [boxes, setBoxes] = useState<Partial<Record<CardElementKey, Box>>>({});

  const containerRef = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const missingKeys = CARD_ELEMENT_KEYS.filter((key) => !elements[key]);

  function updateElement(key: CardElementKey, patch: ElementPatch) {
    setElements((prev) => {
      const next: Record<string, unknown> = { ...prev[key]! };
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) delete next[field];
        else next[field] = value;
      }
      return { ...prev, [key]: next as CardElement };
    });
  }

  function addElement(key: CardElementKey) {
    setElements((prev) => ({ ...prev, [key]: { ...DEFAULTS[key] } }));
    setSelected(key);
  }

  function removeElement(key: CardElementKey) {
    setElements((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setSelected((current) => (current === key ? null : current));
  }

  function resetToDefault() {
    setElements(
      Object.fromEntries(
        CARD_ELEMENT_KEYS.map((key) => [key, { ...DEFAULTS[key] }]),
      ) as ElementMap,
    );
    setBackground(DEFAULT_CARD_BACKGROUND);
    setAccent(undefined);
    setFooter(undefined);
    setHeaderBand(false);
    setSelected(null);
  }

  // ── The one preview ───────────────────────────────────────────────────────
  const layout: CardLayout = {
    background,
    ...(accent ? { accent } : {}),
    ...(footer ? { footer } : {}),
    ...(headerBand ? { headerBand: true } : {}),
    elements: elements as Record<string, CardElement>,
  };

  const sampleCode = "1000";
  const svg = renderIdCardSvg({
    centerName,
    brandColor,
    studentName: t("sample.studentName"),
    gradeName: t("sample.grade"),
    studentCode: sampleCode,
    qrPayload: studentQrPayload("preview", sampleCode),
    labels: { code: t("sample.codeLabel") },
    dir,
    layout,
    annotate: true,
  });

  // Where each element landed — read back from the rendered SVG, so the drag
  // target of a text is exactly its glyphs and of an image exactly its picture.
  function measure() {
    const face = faceRef.current;
    if (!face) return;
    const next: Partial<Record<CardElementKey, Box>> = {};
    face.querySelectorAll<SVGGElement>("[data-card-el]").forEach((node) => {
      try {
        const bounds = node.getBBox();
        if (bounds.width > 0 && bounds.height > 0) {
          next[node.dataset.cardEl as CardElementKey] = {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          };
        }
      } catch {
        // getBBox throws while the card is display:none (the stacked mobile
        // layout has no drag surface) — nothing to measure then.
      }
    });
    setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
  }

  useLayoutEffect(measure, [svg]);
  useEffect(() => {
    // Glyph widths change once the card font has actually loaded.
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
    };
  }, []);

  // Escape deselects — the only keyboard way out besides picking another.
  useEffect(() => {
    if (!selected) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  // ── Dragging ──────────────────────────────────────────────────────────────
  function onElementPointerDown(
    key: CardElementKey,
    event: React.PointerEvent<HTMLElement>,
  ) {
    if (event.button !== 0) return;
    // This press belongs to the element — the card's "empty space" handler
    // must not see it and deselect.
    event.stopPropagation();
    const start = elements[key];
    const container = containerRef.current;
    if (!start || !container) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(key);

    const rect = container.getBoundingClientRect();
    dragRef.current = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: start.x,
      originY: start.y,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
  }

  function onElementPointerMove(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;

    // `x` is a logical start offset, so a drag to the right moves it the other
    // way on an Arabic card.
    const sign = dir === "rtl" ? -1 : 1;
    updateElement(drag.key, {
      x: clampPercent(snap(drag.originX + (dx / drag.width) * 100 * sign)),
      y: clampPercent(snap(drag.originY + (dy / drag.height) * 100)),
    });
  }

  function endDrag(event: React.PointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  function onElementKeyDown(
    key: CardElementKey,
    event: React.KeyboardEvent<HTMLElement>,
  ) {
    const step = event.shiftKey ? 5 : 1;
    const logical = dir === "rtl" ? -1 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowRight: [logical, 0],
      ArrowLeft: [-logical, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1],
    };
    const move = moves[event.key];
    const current = elements[key];
    if (!move || !current) return;
    event.preventDefault();
    updateElement(key, {
      x: clampPercent(current.x + move[0] * step),
      y: clampPercent(current.y + move[1] * step),
    });
  }

  // ── What is posted ────────────────────────────────────────────────────────
  const layoutJson = JSON.stringify({
    version: 1,
    background,
    ...(accent ? { accent } : {}),
    ...(footer ? { footer } : {}),
    ...(headerBand ? { headerBand: true } : {}),
    elements: Object.fromEntries(
      CARD_ELEMENT_KEYS.map((key) => [key, serializeElement(key, elements[key])]),
    ),
  });

  const contrastIssues = cardContrastIssues(layout, brandColor);
  const selectedElement = selected ? elements[selected] : undefined;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="cardLayout" value={layoutJson} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.fieldErrors?.cardLayout ? (
        <FormMessage>{tErrors(state.fieldErrors.cardLayout)}</FormMessage>
      ) : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("editorTitle")}</CardTitle>
          <CardDescription>
            {t("editorDescription", { locale: t(`localeName.${locale}`) })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {/* The card — drag surface from md up, plain preview below it. */}
          <div>
            <div
              ref={containerRef}
              dir={dir}
              className="relative mx-auto aspect-[320/202] w-full max-w-[420px] select-none overflow-hidden rounded-xl shadow-card md:touch-none"
              // Pressing empty card space deselects. Elements stop their own
              // presses (`onElementPointerDown`), so only a miss lands here.
              onPointerDown={() => setSelected(null)}
            >
              <div
                ref={faceRef}
                className="absolute inset-0 [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
              {CARD_ELEMENT_KEYS.filter((key) => elements[key] && boxes[key]).map(
                (key) => {
                  const box = boxes[key]!;
                  const inlineStart =
                    dir === "rtl"
                      ? 100 - ((box.x + box.width) / CARD_WIDTH) * 100
                      : (box.x / CARD_WIDTH) * 100;
                  const isSelected = selected === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      title={t(`elements.${key}`)}
                      aria-label={t(`elements.${key}`)}
                      aria-pressed={isSelected}
                      onPointerDown={(event) => onElementPointerDown(key, event)}
                      onPointerMove={onElementPointerMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      onLostPointerCapture={endDrag}
                      onKeyDown={(event) => onElementKeyDown(key, event)}
                      onClick={() => setSelected(key)}
                      style={{
                        insetInlineStart: `${inlineStart}%`,
                        top: `${(box.y / CARD_HEIGHT) * 100}%`,
                        width: `${(box.width / CARD_WIDTH) * 100}%`,
                        height: `${(box.height / CARD_HEIGHT) * 100}%`,
                      }}
                      className={cn(
                        "absolute hidden min-h-3 min-w-3 cursor-grab touch-none rounded-sm border border-dashed md:block",
                        "transition-colors outline-none active:cursor-grabbing",
                        "focus-visible:ring-2 focus-visible:ring-white",
                        isSelected
                          ? "z-10 border-white bg-white/10 ring-2 ring-brand"
                          : "border-transparent hover:border-white/70",
                      )}
                    />
                  );
                },
              )}
            </div>
            <p className="mt-2 text-center text-xs text-text-muted">{t("sample.caption")}</p>
            <p className="mt-1 hidden text-center text-xs text-text-muted md:block">
              {t("dragHint", { locale: t(`localeName.${locale}`) })}
            </p>
          </div>

          {contrastIssues.length > 0 ? (
            <div className="flex flex-col gap-2">
              {contrastIssues.map((issue) => (
                <FormMessage key={issue.key} tone="warning">
                  {t("contrastWarning", {
                    element: t(`elements.${issue.key}`),
                    ratio: formatNumber(Math.floor(issue.ratio * 10) / 10, locale),
                    required: formatNumber(issue.required, locale),
                  })}
                </FormMessage>
              ))}
            </div>
          ) : null}

          {/* Properties strip for the selected element (md and up). It stays
              until the selection is cleared on purpose — see the note above. */}
          {selected && selectedElement ? (
            <div
              role="group"
              aria-label={t(`elements.${selected}`)}
              className="hidden flex-col gap-4 rounded-lg border border-border bg-surface-subtle p-3 md:flex"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-text-primary">
                  {t(`elements.${selected}`)}
                </span>
                <RemoveButton
                  label={t("remove")}
                  onClick={() => removeElement(selected)}
                />
              </div>
              <ElementControls
                elementKey={selected}
                element={selectedElement}
                onChange={(patch) => updateElement(selected, patch)}
                themeColor={theme}
                centerName={centerName}
                showPosition={false}
              />
            </div>
          ) : null}

          {/* Below md: no drag surface — a stacked list with the same controls. */}
          <div className="flex flex-col gap-3 md:hidden">
            {CARD_ELEMENT_KEYS.filter((key) => elements[key]).map((key) => (
              <details
                key={key}
                className="group rounded-lg border border-border"
              >
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium text-text-primary [&::-webkit-details-marker]:hidden">
                  {t(`elements.${key}`)}
                  <ChevronDown className="size-4 text-text-muted transition-transform group-open:rotate-180" />
                </summary>
                <div className="flex flex-col gap-4 border-t border-border p-3">
                  <ElementControls
                    elementKey={key}
                    element={elements[key]!}
                    onChange={(patch) => updateElement(key, patch)}
                    themeColor={theme}
                    centerName={centerName}
                    showPosition
                  />
                  <RemoveButton
                    label={t("remove")}
                    onClick={() => removeElement(key)}
                  />
                </div>
              </details>
            ))}
          </div>

          {/* Palette — add back an element that was removed. */}
          {missingKeys.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-text-secondary">
                {t("paletteLabel")}
              </span>
              {missingKeys.map((key) => (
                <Button
                  key={key}
                  type="button"
                  variant="outline"
                  className="h-11 px-3 text-xs"
                  onClick={() => addElement(key)}
                >
                  <Plus className="size-3.5" />
                  {t(`elements.${key}`)}
                </Button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("colors.title")}</CardTitle>
          <CardDescription>{t("colors.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <ColorField
            label={t("colors.background")}
            value={background === DEFAULT_CARD_BACKGROUND ? undefined : background}
            fallback={DEFAULT_BACKGROUND_STOPS[0]}
            themeColor={theme}
            onChange={(value) => setBackground(value ?? DEFAULT_CARD_BACKGROUND)}
            resetLabel={t("colors.resetBackground")}
          />

          <div className="flex flex-col gap-3">
            <ToggleRow
              name="headerBand"
              label={t("colors.headerBand")}
              description={t("colors.headerBandHint")}
              checked={headerBand}
              onCheckedChange={setHeaderBand}
            />
            {headerBand ? (
              <ColorField
                label={t("colors.accent")}
                value={accent}
                fallback={theme}
                themeColor={theme}
                onChange={setAccent}
                resetLabel={t("colors.resetToTheme")}
              />
            ) : null}
          </div>

          <ColorField
            label={t("colors.footer")}
            value={footer}
            fallback={theme}
            themeColor={theme}
            onChange={setFooter}
            resetLabel={t("colors.resetToTheme")}
          />

          <div className="flex flex-col gap-2 sm:flex-row">
            <SubmitButton className="w-full sm:w-auto">
              {tCommon("save")}
            </SubmitButton>
            <Button
              type="button"
              variant="ghost"
              className="h-11 w-full px-4 sm:w-auto"
              onClick={resetToDefault}
            >
              <RotateCcw className="size-4 rtl:-scale-x-100" />
              {t("resetDefault")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

/**
 * One element as stored: only the fields that element is allowed to carry
 * (`CARD_ELEMENT_FIELDS` — the same list the schema is built from), `null` for
 * a removed element, and a blank custom branch text left out.
 */
function serializeElement(
  key: CardElementKey,
  element: CardElement | undefined,
): Record<string, unknown> | null {
  if (!element) return null;
  const source = element as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of CARD_ELEMENT_FIELDS[key]) {
    const value = source[field];
    if (value === undefined) continue;
    if (field === "text") {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed) out.text = trimmed;
      continue;
    }
    // An older layout may hold a size the schema now bounds (the pre-R9 number
    // fields only advised min/max) — clamp rather than fail the save on a field
    // the user never touched.
    const bounds = boundsFor(key, field);
    out[field] =
      bounds && typeof value === "number"
        ? Math.min(bounds.max, Math.max(bounds.min, value))
        : value;
  }
  return out;
}

function boundsFor(
  key: CardElementKey,
  field: string,
): { min: number; max: number } | null {
  switch (field) {
    case "x":
    case "y":
      return CARD_BOUNDS.position;
    case "width":
      return IMAGE_ELEMENT_KEYS.includes(key)
        ? CARD_BOUNDS.imageWidth
        : CARD_BOUNDS.textWidth;
    case "fontSize":
      return CARD_BOUNDS.fontSize;
    case "weight":
      return CARD_BOUNDS.weight;
    default:
      return null;
  }
}

function sameBoxes(
  a: Partial<Record<CardElementKey, Box>>,
  b: Partial<Record<CardElementKey, Box>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<CardElementKey>;
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (!left || !right) return false;
    if (
      left.x !== right.x ||
      left.y !== right.y ||
      left.width !== right.width ||
      left.height !== right.height
    ) {
      return false;
    }
  }
  return true;
}

function snap(value: number): number {
  return Math.round(value / 2) * 2;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
