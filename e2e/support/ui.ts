import type { Locator, Page } from "@playwright/test";

import { formatFullDate } from "@/lib/format";

import { SEED } from "./accounts";
import { expect } from "./fixtures";
import { t, type AppLocale } from "./i18n";

/** Picks a branch on the hub (`/select-center`) — the same form the switcher posts. */
export async function selectBranch(page: Page, locale: AppLocale, branch: string = SEED.downtown) {
  await page.goto(`/${locale}/select-center`);
  await page.getByRole("button", { name: new RegExp(branch) }).click();
  await page.waitForURL((url) => !url.pathname.includes("select-center"));
}

/**
 * A field's accessible name: its label, optionally followed by the dimmed
 * "(optional)" marker the shared `Field` adds (docs/04 §5 "Form fields").
 */
export function field(label: string): RegExp {
  return new RegExp(`^${escapeRegExp(label)}(\\s*\\(.*\\))?$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Chooses `option` in the shared Select / Combobox labelled `label` (both open a listbox). */
export async function choose(scope: Page | Locator, label: string | RegExp, option: string | RegExp) {
  const page = "page" in scope ? scope.page() : scope;
  await scope.getByLabel(typeof label === "string" ? field(label) : label).first().click();
  // The first *enabled* option — a placeholder row ("Choose a room") is disabled.
  await page.getByRole("option", { name: option, exact: typeof option === "string", disabled: false }).first().click();
}

/** A calendar day `offset` days from today (UTC day marker), as the picker labels it. */
export function dayFromToday(offset: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
}

/** Opens the shared DatePicker labelled `label` and picks `date` (navigating months as needed). */
export async function pickDate(scope: Page | Locator, locale: AppLocale, label: string, date: Date) {
  const page = "page" in scope ? scope.page() : scope;
  await scope.getByLabel(field(label)).first().click();
  const cell = page.getByRole("gridcell", { name: formatFullDate(date, locale), exact: true });
  for (let step = 0; step < 24 && !(await cell.isVisible()); step += 1) {
    await page.getByRole("button", { name: t(locale, "Shared.calendar.nextMonth") }).click();
  }
  await cell.click();
}

/** The list row (an `li`) that contains `text`. */
export function rowWith(scope: Page | Locator, text: string): Locator {
  return scope.getByRole("listitem").filter({ hasText: text }).first();
}

/** A dialog that is open now. */
export function openDialog(page: Page): Locator {
  return page.getByRole("dialog").filter({ visible: true }).last();
}

export async function expectGone(page: Page, text: string) {
  await expect(page.getByText(text, { exact: false })).toHaveCount(0);
}

/**
 * Submits a slot-writing dialog under R3's contract: the live conflict
 * preview is debounced, so wait until either the submit is enabled or the
 * "I understand, create anyway" box appears — and tick it (WARN) when it does.
 * Under DENY the submit stays disabled and this fails, as it should.
 */
export async function submitConfirmingConflicts(dialog: Locator, locale: AppLocale, submitName: string) {
  const submit = dialog.getByRole("button", { name: submitName, exact: true });
  // The visible checkbox (base-ui renders a hidden native input beside it).
  const confirm = dialog.getByRole("checkbox", {
    name: new RegExp(`^${escapeRegExp(t(locale, "RoomSets.conflicts.confirm"))}`),
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!(await dialog.isVisible().catch(() => false))) return;
    if ((await confirm.isVisible().catch(() => false)) && !(await confirm.isChecked().catch(() => true))) {
      // The dialog re-centres (animated) as the conflict list renders, so the
      // box may still be moving: a short check, then a forced click.
      await confirm.check({ timeout: 3_000 }).catch(() => confirm.click({ force: true }).catch(() => undefined));
    }
    if (await submit.isEnabled().catch(() => false)) {
      // The tick resets whenever the conflict list changes, so the button can
      // flip back to disabled under us — a short click, then loop again.
      const clicked = await submit.click({ timeout: 3_000 }).then(() => true, () => false);
      if (!clicked) continue;
      // Either the dialog closes, or the server refuses with the conflict list
      // and the box to tick (WARN) — then loop round and tick it.
      await expect(dialog.or(confirm).first()).toBeVisible({ timeout: 1_000 }).catch(() => undefined);
      await dialog.page().waitForTimeout(1_500);
      continue;
    }
    await dialog.page().waitForTimeout(500);
  }
  throw new Error(`"${submitName}" never went through (a DENY conflict, or a refusal)`);
}
