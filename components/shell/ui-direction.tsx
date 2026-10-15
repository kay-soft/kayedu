"use client";

import type { ReactNode } from "react";
import { DirectionProvider } from "@base-ui/react/direction-provider";

/**
 * Tells Base UI which way the page reads.
 *
 * `<html dir>` alone is not enough: Base UI's positioning defaults to `ltr`
 * and reads its direction from this provider, so without it every popover,
 * select and dropdown in the app anchored to the *left* edge in Arabic while
 * the page around it ran right-to-left (docs/04 §7 — logical, always). One
 * provider at the root, driven by the same locale that sets `dir`.
 */
export function UiDirection({
  direction,
  children,
}: {
  direction: "ltr" | "rtl";
  children: ReactNode;
}) {
  return <DirectionProvider direction={direction}>{children}</DirectionProvider>;
}
