"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  CARD_BOUNDS,
  CARD_BRANCH_TEXT_MAX,
  CARD_FONT_FAMILY_KEYS,
  CARD_TEXT_ALIGNS,
  CARD_WEIGHT_BOLD,
  CARD_WEIGHT_NORMAL,
  DEFAULT_TEXT_BOX_WIDTH,
  DEFAULT_TEXT_COLOR,
  IMAGE_ELEMENT_KEYS,
  isTextElementKey,
  normalizeHex,
  type CardElementKey,
} from "@/lib/card-layout";
import { formatNumber } from "@/lib/format";
import type { CardElement } from "@/lib/id-card";
import { cn } from "@/lib/utils";

/** Colours offered beside the theme colour — neutral, high-contrast picks. */
const SWATCHES = ["#ffffff", "#cbd5e1", "#0f172a", "#1e293b", "#fbbf24", "#10b981"];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A number the user can type freely. The draft is kept as text while the field
 * is focused (so clearing it to type "14" does not snap to the minimum on the
 * "1"), applied live whenever it is already in range, and clamped on blur — an
 * out-of-range value can therefore never reach the saved layout.
 */
export function NumberField({
  label,
  value,
  onChange,
  min = CARD_BOUNDS.imageWidth.min,
  max = CARD_BOUNDS.imageWidth.max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
      {label}
      <Input
        type="number"
        inputMode="decimal"
        dir="ltr"
        value={draft ?? String(value)}
        min={min}
        max={max}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          setDraft(raw);
          const parsed = Number(raw);
          if (raw !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max) {
            onChange(parsed);
          }
        }}
        onBlur={() => {
          if (draft === null) return;
          const parsed = Number(draft);
          if (draft !== "" && Number.isFinite(parsed)) {
            onChange(clamp(parsed, min, max));
          }
          setDraft(null);
        }}
        className="w-24 px-2"
      />
    </label>
  );
}

/** A small mutually-exclusive choice (Normal/Bold, Start/Center/End). */
function SegmentedField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex gap-1">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "inline-flex h-11 min-w-11 items-center justify-center rounded-lg border px-3 text-sm transition-ui-fast outline-none",
                "focus-visible:ring-3 focus-visible:ring-brand/25",
                active
                  ? "border-brand bg-brand/10 font-medium text-brand"
                  : "border-border bg-background text-text-secondary hover:border-border-strong hover:bg-surface-hover",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A colour: the native picker, a few swatches (the first is the centre's theme
 * colour) and — once a custom value is set — a reset back to the default. The
 * value is `undefined` while the default applies, which is what the layout
 * stores (an absent key), so "reset" removes the key instead of writing a copy.
 */
export function ColorField({
  label,
  value,
  fallback,
  themeColor,
  onChange,
  resetLabel,
}: {
  label: string;
  /** The custom colour, or `undefined` while the built-in one applies. */
  value: string | undefined;
  /** What applies when `value` is `undefined` — shown in the picker. */
  fallback: string;
  themeColor: string;
  onChange: (value: string | undefined) => void;
  resetLabel: string;
}) {
  const t = useTranslations("Settings.card");
  const shown = normalizeHex(value) ?? normalizeHex(fallback) ?? "#000000";
  const theme = normalizeHex(themeColor);
  const swatches = [
    ...(theme ? [{ color: theme, name: t("colors.theme") }] : []),
    ...SWATCHES.map((color) => ({ color, name: color })),
  ];

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      <div className="flex flex-wrap items-center gap-1">
        <input
          type="color"
          aria-label={label}
          value={shown}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="h-11 w-11 shrink-0 cursor-pointer rounded-lg border border-border bg-background p-1"
        />
        <span dir="ltr" className="px-1 font-mono text-xs text-text-muted">
          {shown}
        </span>
        {swatches.map(({ color, name }) => (
          <button
            key={`${name}-${color}`}
            type="button"
            title={name}
            aria-label={t("colors.use", { color: name })}
            aria-pressed={shown === color}
            onClick={() => onChange(color)}
            className="inline-flex size-11 items-center justify-center rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-brand/25"
          >
            <span
              className={cn(
                "size-6 rounded-full border border-border-strong",
                shown === color && "ring-2 ring-brand ring-offset-2 ring-offset-background",
              )}
              style={{ backgroundColor: color }}
            />
          </button>
        ))}
        {value !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 px-3 text-xs"
            onClick={() => onChange(undefined)}
          >
            {resetLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Every control one element has: size/width for the images; for the four text
 * elements also weight, alignment, colour, font and — on the branch name — the
 * custom text. Used by the desktop properties strip and by the below-`md`
 * stacked rows, so the two surfaces can never drift apart.
 */
export function ElementControls({
  elementKey,
  element,
  onChange,
  themeColor,
  centerName,
  showPosition,
}: {
  elementKey: CardElementKey;
  element: CardElement;
  /** `undefined` for a field removes it (back to the default). */
  onChange: (patch: { [K in keyof CardElement]?: CardElement[K] | undefined }) => void;
  themeColor: string;
  /** The real name — shown as the placeholder of the custom branch text. */
  centerName: string;
  /** Below `md` there is no drag surface, so position is edited numerically. */
  showPosition: boolean;
}) {
  const t = useTranslations("Settings.card");
  const locale = useLocale();
  const isImage = IMAGE_ELEMENT_KEYS.includes(elementKey);
  const isText = isTextElementKey(elementKey);
  const fallbackColor = DEFAULT_TEXT_COLOR[elementKey] ?? "#ffffff";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        {showPosition ? (
          <>
            <NumberField
              label={t("positionX")}
              value={element.x}
              onChange={(value) => onChange({ x: value })}
              min={CARD_BOUNDS.position.min}
              max={CARD_BOUNDS.position.max}
            />
            <NumberField
              label={t("positionY")}
              value={element.y}
              onChange={(value) => onChange({ y: value })}
              min={CARD_BOUNDS.position.min}
              max={CARD_BOUNDS.position.max}
            />
          </>
        ) : null}
        {isImage ? (
          <NumberField
            label={t("width")}
            value={element.width ?? 20}
            onChange={(value) => onChange({ width: value })}
          />
        ) : (
          <NumberField
            label={t("fontSize")}
            value={element.fontSize ?? 12}
            onChange={(value) => onChange({ fontSize: value })}
            min={CARD_BOUNDS.fontSize.min}
            max={CARD_BOUNDS.fontSize.max}
          />
        )}
        {isText ? (
          <NumberField
            label={t("style.boxWidth")}
            value={element.width ?? DEFAULT_TEXT_BOX_WIDTH[elementKey] ?? 40}
            onChange={(value) => onChange({ width: value })}
            min={CARD_BOUNDS.textWidth.min}
            max={CARD_BOUNDS.textWidth.max}
          />
        ) : null}
      </div>

      {isText ? (
        <>
          {elementKey === "centerName" ? (
            <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
              {t("style.customText")}
              <Input
                value={element.text ?? ""}
                maxLength={CARD_BRANCH_TEXT_MAX}
                placeholder={centerName}
                onChange={(event) =>
                  onChange({ text: event.currentTarget.value || undefined })
                }
              />
              <span className="font-normal text-text-muted">
                {t("style.customTextHint", { max: formatNumber(CARD_BRANCH_TEXT_MAX, locale) })}
              </span>
            </label>
          ) : null}

          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <SegmentedField
              label={t("style.weight")}
              value={(element.weight ?? CARD_WEIGHT_NORMAL) >= 600 ? "bold" : "normal"}
              options={[
                { value: "normal", label: t("style.weightNormal") },
                { value: "bold", label: t("style.weightBold") },
              ]}
              onChange={(value) =>
                onChange({
                  weight: value === "bold" ? CARD_WEIGHT_BOLD : CARD_WEIGHT_NORMAL,
                })
              }
            />
            <SegmentedField
              label={t("style.align")}
              value={element.align ?? "start"}
              options={CARD_TEXT_ALIGNS.map((value) => ({
                value,
                label: t(`style.align_${value}`),
              }))}
              onChange={(value) => onChange({ align: value })}
            />
            <div className="flex min-w-40 flex-col gap-1">
              <span className="text-xs font-medium text-text-secondary">
                {t("style.family")}
              </span>
              <Select
                aria-label={t("style.family")}
                value={element.family ?? "cairo"}
                onValueChange={(value) =>
                  onChange({ family: value as CardElement["family"] })
                }
                options={CARD_FONT_FAMILY_KEYS.map((value) => ({
                  value,
                  label: t(`families.${value}`),
                }))}
              />
            </div>
          </div>

          <ColorField
            label={t("style.color")}
            value={element.color}
            fallback={fallbackColor}
            themeColor={themeColor}
            onChange={(value) => onChange({ color: value })}
            resetLabel={t("style.resetColor")}
          />
        </>
      ) : null}
    </div>
  );
}

export function RemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-11 px-3 text-danger-fg hover:bg-danger-bg"
      onClick={onClick}
    >
      <X className="size-4" />
      {label}
    </Button>
  );
}
