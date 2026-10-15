import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The app's own message files, so every locator names what a person reads in
 * the active locale — `t("ar", "Nav.dashboard")` — instead of a CSS class or a
 * hard-coded English string (a restyle or a copy edit cannot break a test
 * without breaking the screen too).
 */
export type AppLocale = "en" | "ar";

type Messages = Record<string, unknown>;

const cache = new Map<AppLocale, Messages>();

function messages(locale: AppLocale): Messages {
  let loaded = cache.get(locale);
  if (!loaded) {
    loaded = JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Messages;
    cache.set(locale, loaded);
  }
  return loaded;
}

/** The raw message at `key` ("Nav.dashboard"). Throws on a missing key — a test bug. */
export function raw(locale: AppLocale, key: string): string {
  let node: unknown = messages(locale);
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      throw new Error(`e2e: no message "${key}" in ${locale}.json`);
    }
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "string") throw new Error(`e2e: "${key}" is not a string in ${locale}.json`);
  return node;
}

/** A message with simple `{name}` placeholders filled in (no plural logic). */
export function t(locale: AppLocale, key: string, values: Record<string, string | number> = {}): string {
  return raw(locale, key).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A message as a pattern: plural/select blocks and placeholders match any
 * text. For counts and names a test does not pin.
 */
export function tPattern(locale: AppLocale, key: string): RegExp {
  let message = raw(locale, key);
  // Collapse every top-level ICU block {…{…}…} into a sentinel.
  let out = "";
  let depth = 0;
  for (const char of message) {
    if (char === "{") {
      if (depth === 0) out += "\u0000";
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (depth === 0) {
      out += char;
    }
  }
  message = out;
  return new RegExp(message.split("\u0000").map(escapeRegExp).join(".*?"));
}

/** Every top-level namespace — a raw "Namespace.key" on screen is a missing translation. */
export function namespaces(): string[] {
  return Object.keys(messages("en"));
}
