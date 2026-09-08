"use client";

import { useActionState, useRef, useState } from "react";
import { Plus, RotateCcw, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { saveCardLayoutAction } from "@/app/[locale]/(center)/settings/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CARD_ELEMENT_KEYS,
  DEFAULT_CARD_LAYOUT,
  IMAGE_ELEMENT_KEYS,
  type CardElementKey,
} from "@/lib/card-layout";
import {
  renderIdCardSvg,
  studentQrPayload,
  type CardElement,
} from "@/lib/id-card";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import { cn } from "@/lib/utils";

type ElementMap = Partial<Record<CardElementKey, CardElement>>;

const DEFAULTS = DEFAULT_CARD_LAYOUT.elements as unknown as Record<
  CardElementKey,
  CardElement
>;

/**
 * The visual ID-card layout editor (M18, docs/04 §11.6). A centre never sees
 * JSON at any point — this component drags/resizes/adds/removes elements on
 * a live preview and serializes the result into a hidden field only at
 * submit time; `saveCardLayoutAction`/`cardLayoutSchema` are unchanged, they
 * still just see a JSON string, they simply never render one.
 *
 * Move is a real pointer drag on the preview. Resize is the properties
 * strip's width/font-size field, not a corner handle — text elements have no
 * `width` in this data model at all (`lib/id-card.ts`), so a size handle
 * would have nothing to write to for four of the seven elements; a shared
 * numeric control that already exists per element type covers all seven
 * uniformly.
 */
export function CardLayoutForm({
  initialElements,
  background,
  centerName,
  brandColor,
}: {
  initialElements: ElementMap;
  background: string;
  centerName: string;
  brandColor: string;
}) {
  const t = useTranslations("Settings.card");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const dir = locale === "ar" ? "rtl" : "ltr";

  const [state, formAction] = useActionState(
    saveCardLayoutAction,
    IDLE_ACTION_STATE,
  );
  const [elements, setElements] = useState<ElementMap>(initialElements);
  const [selected, setSelected] = useState<CardElementKey | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const missingKeys = CARD_ELEMENT_KEYS.filter((key) => !elements[key]);

  function updateElement(key: CardElementKey, patch: Partial<CardElement>) {
    setElements((prev) => ({ ...prev, [key]: { ...prev[key]!, ...patch } }));
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
    setElements({ ...DEFAULTS });
    setSelected(null);
  }

  function onHandlePointerDown(key: CardElementKey, event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    setSelected(key);
    const container = containerRef.current;
    const start = elements[key];
    if (!container || !start) return;

    const rect = container.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const sign = dir === "rtl" ? -1 : 1;

    function onMove(moveEvent: PointerEvent) {
      const dxPercent = ((moveEvent.clientX - startX) / rect.width) * 100 * sign;
      const dyPercent = ((moveEvent.clientY - startY) / rect.height) * 100;
      const nextX = clampPercent(snap(start!.x + dxPercent));
      const nextY = clampPercent(snap(start!.y + dyPercent));
      updateElement(key, { x: nextX, y: nextY });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

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
    layout: { background, elements: elements as Record<string, CardElement> },
  });

  const layoutJson = JSON.stringify({
    version: 1,
    background,
    elements: {
      ...Object.fromEntries(CARD_ELEMENT_KEYS.map((key) => [key, null])),
      ...elements,
    },
  });

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="cardLayout" value={layoutJson} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
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
          {/* Desktop/tablet: direct-manipulation drag surface. */}
          <div className="hidden md:block">
            <div
              ref={containerRef}
              dir={dir}
              className="relative mx-auto aspect-[320/202] w-full max-w-[420px] touch-none select-none overflow-hidden rounded-xl shadow-card"
              onClick={() => setSelected(null)}
            >
              <div
                className="absolute inset-0 [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
              {CARD_ELEMENT_KEYS.filter((key) => elements[key]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onPointerDown={(event) => onHandlePointerDown(key, event)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelected(key);
                  }}
                  style={{
                    insetInlineStart: `${elements[key]!.x}%`,
                    top: `${elements[key]!.y}%`,
                  }}
                  className={cn(
                    "absolute flex cursor-grab items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap active:cursor-grabbing",
                    "transition-ui-fast outline-none focus-visible:ring-2 focus-visible:ring-white",
                    selected === key
                      ? "border-brand bg-brand/20 text-white ring-2 ring-brand"
                      : "border-white/40 bg-black/20 text-white/90 hover:border-white/70",
                  )}
                >
                  {t(`elements.${key}`)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-center text-xs text-text-muted">
              {t("dragHint", { locale: t(`localeName.${locale}`) })}
            </p>
          </div>

          {/* Below md: no drag surface — a stacked list with numeric controls. */}
          <div className="flex flex-col gap-3 md:hidden">
            {CARD_ELEMENT_KEYS.filter((key) => elements[key]).map((key) => (
              <ElementRow
                key={key}
                elementKey={key}
                element={elements[key]!}
                label={t(`elements.${key}`)}
                onChange={(patch) => updateElement(key, patch)}
                onRemove={() => removeElement(key)}
                widthLabel={t("width")}
                fontSizeLabel={t("fontSize")}
                xLabel={t("positionX")}
                yLabel={t("positionY")}
                removeLabel={t("remove")}
              />
            ))}
          </div>

          {/* Properties strip for the selected element (desktop/tablet only —
              mobile edits inline in the stacked list above). */}
          {selected ? (
            <div className="hidden items-end gap-3 rounded-lg border border-border bg-surface-subtle p-3 md:flex">
              <span className="text-sm font-medium text-text-primary">
                {t(`elements.${selected}`)}
              </span>
              {IMAGE_ELEMENT_KEYS.includes(selected) ? (
                <NumberField
                  label={t("width")}
                  value={elements[selected]?.width ?? 20}
                  onChange={(value) => updateElement(selected, { width: value })}
                />
              ) : (
                <NumberField
                  label={t("fontSize")}
                  value={elements[selected]?.fontSize ?? 12}
                  onChange={(value) => updateElement(selected, { fontSize: value })}
                  min={8}
                  max={28}
                />
              )}
              <Button
                type="button"
                variant="ghost"
                className="h-9 px-3 text-danger hover:bg-danger-bg"
                onClick={() => removeElement(selected)}
              >
                <X className="size-4" />
                {t("remove")}
              </Button>
            </div>
          ) : null}

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
                  className="h-9 px-3 text-xs"
                  onClick={() => addElement(key)}
                >
                  <Plus className="size-3.5" />
                  {t(`elements.${key}`)}
                </Button>
              ))}
            </div>
          ) : null}

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

function snap(value: number): number {
  return Math.round(value / 2) * 2;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function NumberField({
  label,
  value,
  onChange,
  min = 5,
  max = 60,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
      {label}
      <Input
        type="number"
        dir="ltr"
        value={value}
        min={min}
        max={max}
        onChange={(event) => {
          const parsed = Number(event.currentTarget.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className="h-9 w-20 px-2"
      />
    </label>
  );
}

/** The below-`md` fallback (docs/04 §11.6): numeric controls, no drag surface. */
function ElementRow({
  elementKey,
  element,
  label,
  onChange,
  onRemove,
  widthLabel,
  fontSizeLabel,
  xLabel,
  yLabel,
  removeLabel,
}: {
  elementKey: CardElementKey;
  element: CardElement;
  label: string;
  onChange: (patch: Partial<CardElement>) => void;
  onRemove: () => void;
  widthLabel: string;
  fontSizeLabel: string;
  xLabel: string;
  yLabel: string;
  removeLabel: string;
}) {
  const isImage = IMAGE_ELEMENT_KEYS.includes(elementKey);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <Button
          type="button"
          variant="ghost"
          className="h-8 px-2 text-danger hover:bg-danger-bg"
          onClick={onRemove}
        >
          <X className="size-4" />
          {removeLabel}
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <NumberField
          label={xLabel}
          value={element.x}
          onChange={(value) => onChange({ x: clampPercent(value) })}
          min={0}
          max={100}
        />
        <NumberField
          label={yLabel}
          value={element.y}
          onChange={(value) => onChange({ y: clampPercent(value) })}
          min={0}
          max={100}
        />
        {isImage ? (
          <NumberField
            label={widthLabel}
            value={element.width ?? 20}
            onChange={(value) => onChange({ width: value })}
          />
        ) : (
          <NumberField
            label={fontSizeLabel}
            value={element.fontSize ?? 12}
            onChange={(value) => onChange({ fontSize: value })}
            min={8}
            max={28}
          />
        )}
      </div>
    </div>
  );
}
