import type { User } from "@prisma/client";

/**
 * Account settings' two named extension points (F2). Each renders **nothing**
 * until the prompt that owns it fills it in — no heading, no empty card:
 *
 * - `StudyDetailsSection` — a student's own study details (F4: account grade
 *   and onboarding);
 * - `FamilySection` — family links (F3: parent onboarding, closing OD-6).
 *
 * They take the signed-in `User` and live on the page between Profile and
 * Sign-in & security, so a later section slots in without moving the others.
 */
export type AccountSectionProps = { user: User };

export async function StudyDetailsSection(props: AccountSectionProps) {
  void props; // F4 reads the student's own records from `props.user`.
  return null;
}

export async function FamilySection(props: AccountSectionProps) {
  void props; // F3 reads the parent's links from `props.user`.
  return null;
}
