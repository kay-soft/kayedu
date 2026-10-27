"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Ltr } from "@/components/shared/ltr";
import { formatFamilyCodeForDisplay } from "@/lib/family-code";

/** The slip's fixed wording, in both languages (the page passes them). */
export type SlipTexts = {
  title: string;
  branch: string;
  student: string;
  code: string;
  link: string;
  handOver: string;
  steps: string;
};

/** Marks the document while the slip prints; `app/globals.css` hides everything else. */
const PRINT_FLAG = "data-print-slip";

/**
 * Prints the slip that `ParentCodeSlip` mounts — and only it: the rest of the
 * page (the dialog included) is hidden for this one print, then restored.
 */
export function printParentCodeSlip() {
  const root = document.documentElement;
  root.setAttribute(PRINT_FLAG, "");
  const done = () => {
    root.removeAttribute(PRINT_FLAG);
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
}

/**
 * A small printable slip for a branch-issued parent code (F3, docs/04
 * §11.22): branch, student, the code, the join link, and short Arabic and
 * English instructions, ending "hand this to the parent in person". It is
 * rendered into `document.body`, invisible on screen, and exists only while
 * the code dialog is open — the code is never fetched again or stored.
 */
export function ParentCodeSlip({
  code,
  branchName,
  studentName,
  joinUrl,
  ar,
  en,
}: {
  code: string;
  branchName: string;
  studentName: string;
  /** Built in the browser; the code rides in its fragment. */
  joinUrl: string;
  ar: SlipTexts;
  en: SlipTexts;
}) {
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the portal target exists only after mount
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const display = formatFamilyCodeForDisplay(code);
  return createPortal(
    <div className="family-slip" aria-hidden>
      <div className="mx-auto flex max-w-[14cm] flex-col gap-4 rounded-xl border-2 border-border-strong p-6 text-text-primary">
        <div className="grid grid-cols-2 gap-4">
          <SlipBlock texts={ar} dir="rtl" branchName={branchName} studentName={studentName} />
          <SlipBlock texts={en} dir="ltr" branchName={branchName} studentName={studentName} />
        </div>
        <div className="flex flex-col items-center gap-1 border-y border-border py-4">
          <span className="text-xs text-text-secondary">
            {ar.code} · {en.code}
          </span>
          <Ltr className="font-mono text-3xl font-semibold tracking-widest">{display}</Ltr>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="text-xs text-text-secondary">
            {ar.link} · {en.link}
          </span>
          <Ltr className="text-sm break-all">{joinUrl}</Ltr>
        </div>
        <div className="grid grid-cols-2 gap-4 text-xs font-semibold">
          <p dir="rtl">{ar.handOver}</p>
          <p dir="ltr">{en.handOver}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SlipBlock({
  texts,
  dir,
  branchName,
  studentName,
}: {
  texts: SlipTexts;
  dir: "rtl" | "ltr";
  branchName: string;
  studentName: string;
}) {
  return (
    <div dir={dir} className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">{texts.title}</h2>
      <dl className="flex flex-col gap-1 text-sm">
        <div>
          <dt className="text-xs text-text-secondary">{texts.branch}</dt>
          <dd className="font-medium break-words">{branchName}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">{texts.student}</dt>
          <dd className="font-medium break-words">{studentName}</dd>
        </div>
      </dl>
      <p className="text-xs">{texts.steps}</p>
    </div>
  );
}
