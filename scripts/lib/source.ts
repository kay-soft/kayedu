/**
 * Reads a source file for a static (text-matching) gate, with line endings
 * normalised to "\n". A gate regex may use `\n`, `$` or `^` anchors; on a
 * CRLF checkout (Windows, core.autocrlf) those silently stop matching. Every
 * static check reads source through this — never `readFileSync` directly.
 * `.gitattributes` pins LF as well; this is the second line of defence.
 */
import { readFileSync } from "node:fs";

export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function readSource(path: string): string {
  return normalizeEol(readFileSync(path, "utf8"));
}
