/**
 * Account settings gate (F2) — static, no database:
 *
 *   npm run check:account
 *
 * Proves the shape the account page must keep: `User.contactPhone` is never
 * an identity key (D-02 (a)) — no matching, linking, origination or refusal
 * function reads it; the account writes only the `User` row (rule 4) and
 * never `User.phone`; email changes never open a claim (D-01) and are audited
 * ids-only (D-20); the ALLOW_UNVERIFIED_EMAIL_CHANGE override is off by
 * default and refused in production beside REQUIRE_EMAIL_CONFIRMATION; and
 * every experience reaches the page from its user menu.
 *
 * The behaviour against a database (wrong password, collisions, a
 * staff-created email, the flag off) is `check:security`'s F2 block.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { profileFromMetadata } from "../lib/auth/identity-link.ts";
import { onboardingPath } from "../lib/auth/onboarding.ts";
import { PROMOTION_UNDO_DAYS, isWithinUndoWindow, undoDeadline } from "../lib/promotion.ts";
import { gradePickerData } from "../lib/student-grade-options.ts";
import {
  allowUnverifiedEmailChange,
  emailChangeMode,
  productionAuthProblems,
} from "../lib/auth/auth-config.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Comments blanked — a doc comment may *name* the field; code may not read it. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The body of `export (async )?function <name>(` up to the next top-level export. */
function exportedBody(path: string, name: string): string {
  const source = code(path);
  const start = source.search(new RegExp(`export (async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in ${path}`);
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

/** The body of a module-level `(async )?function <name>(`. */
function functionBody(path: string, name: string): string {
  const source = code(path);
  const start = source.search(new RegExp(`(^|\\n)(export )?(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in ${path}`);
  const next = source.slice(start + 10).search(/\n(export |async function |function )/);
  return source.slice(start, next < 0 ? undefined : start + 10 + next);
}

console.log("check:account — Account settings (F2)\n");

// ── 1. contactPhone is never an identity key (D-02 (a)) ─────────────────────
console.log("contactPhone is not an identity key");
const IDENTITY_MODULES = [
  "lib/db/identity.ts",
  "lib/auth/identity-link.ts",
  "lib/db/parents.ts",
  "lib/identity.ts",
  "lib/db/account-claims.ts",
];
for (const path of IDENTITY_MODULES) {
  check(`${path} never reads contactPhone`, !/contactPhone/.test(code(path)));
}
const readers = ["lib/db/account.ts", "app/[locale]/account/page.tsx"];
check(
  "contactPhone is read only by the account module and page (plus its form and schema)",
  readers.every((path) => /contactPhone/.test(code(path))),
);

// ── 2. The account writes the User row only, never User.phone (rule 4, D-02) ─
console.log("\nThe account writes only its own User");
const profileWrite = exportedBody("lib/db/account.ts", "updateAccountProfile");
check("updateAccountProfile writes db.user only", /db\.user\.update\(/.test(profileWrite) && !/membership|studentProfile/i.test(profileWrite));
check("updateAccountProfile never writes User.phone or email", !/\b(phone|altPhone|email)\s*:/.test(profileWrite));
check("updateAccountProfile is keyed on the caller's own id", /where:\s*\{\s*id:\s*userId\s*\}/.test(profileWrite));
const actions = code("app/[locale]/account/actions.ts");
check("Account actions never touch a branch record", !/\.(membership|studentProfile)\./.test(actions));
check("Account actions take the user from the session, never from the form", !/formData\.get\(["'](userId|id)["']\)/.test(actions) && /getCurrentUser\(\)/.test(actions));

// ── 3. Credential changes: password first, no claim, audited ids-only ───────
console.log("\nPassword and email changes");
const account = code("lib/auth/account.ts");
const verify = functionBody("lib/auth/account.ts", "verifyCurrentPassword");
check(
  "the current password is rate-limited per account and per IP before Supabase is asked",
  /accountVerifyPerUser/.test(verify) && /accountVerifyPerIp/.test(verify) && verify.indexOf("checkRateLimits") < verify.indexOf("verifyPassword("),
);
const changeEmailBody = exportedBody("lib/auth/account.ts", "changeEmail");
check(
  "changeEmail checks the password before it looks at who holds the address (no oracle)",
  changeEmailBody.indexOf("verifyCurrentPassword") > 0 && changeEmailBody.indexOf("verifyCurrentPassword") < changeEmailBody.indexOf("db.user.findUnique"),
);
check("changeEmail refuses a staff-created person's email (\"ask that branch\")", /emailOnBranchRecord/.test(changeEmailBody));
check("Account settings never opens or touches an AccountClaim (D-01)", !/accountClaim/i.test(account) && !/accountClaim/i.test(actions));
check("changeEmail refuses with the mode off", /mode === "off"[\s\S]{0,80}emailChangeDisabled/.test(changeEmailBody));
check("User.email changes only through resolveAppIdentity (the one sync)", !/user\.update\(/.test(account) && /resolveAppIdentity\(/.test(changeEmailBody));
const sync = functionBody("lib/auth/identity-link.ts", "syncLinkedUser");
check("the email sync audits account.email.change with the write", /"account\.email\.change"/.test(sync) && /\$transaction/.test(sync));
check("account.email.change carries no address (D-20)", !/after:\s*\{[^}]*\bemail\b/.test(sync));
check("changePassword audits account.password.change, centerId null", /"account\.password\.change"/.test(account) && /centerId:\s*null/.test(account));
check("The password probe never uses this session's cookie client", /persistSession:\s*false/.test(actions));

// ── 4. The ALLOW_UNVERIFIED_EMAIL_CHANGE override ───────────────────────────
console.log("\nALLOW_UNVERIFIED_EMAIL_CHANGE");
const prod = { VERCEL_ENV: "production" };
check("off by default → email is read-only (mode off)", emailChangeMode({}) === "off" && !allowUnverifiedEmailChange({}));
check("only the exact value \"yes\" turns it on", !allowUnverifiedEmailChange({ ALLOW_UNVERIFIED_EMAIL_CHANGE: "true" }));
check("=yes → direct mode", emailChangeMode({ ALLOW_UNVERIFIED_EMAIL_CHANGE: "yes" }) === "direct");
check(
  "never applies under REQUIRE_EMAIL_CONFIRMATION=true (the confirmation flow runs)",
  emailChangeMode({ ALLOW_UNVERIFIED_EMAIL_CHANGE: "yes", REQUIRE_EMAIL_CONFIRMATION: "true" }) === "confirm",
);
check(
  "production refuses it beside REQUIRE_EMAIL_CONFIRMATION=true",
  productionAuthProblems(
    { ...prod, REQUIRE_EMAIL_CONFIRMATION: "true", ALLOW_UNVERIFIED_EMAIL_CHANGE: "yes" },
    { mailer_autoconfirm: false },
  ).length > 0,
);
check(
  "production with a confirming project and no override still passes",
  productionAuthProblems({ ...prod, REQUIRE_EMAIL_CONFIRMATION: "true" }, { mailer_autoconfirm: false }).length === 0,
);
const guard = code("lib/auth/production-guard.ts");
check("the start-up guard warns loudly when it is on", /ALLOW_UNVERIFIED_EMAIL_CHANGE=yes/.test(guard) && /console\.warn/.test(guard));
check("the start-up guard throws for the combination", /unverifiedEmailChangeRequested\(env\) && requireEmailConfirmation\(env\)[\s\S]{0,120}throw new AuthMisconfiguredError/.test(guard));

// ── 5. Every experience reaches it from the user menu ───────────────────────
console.log("\nEvery experience reaches Account settings");
const menu = code("components/shell/user-menu.tsx");
check(
  "the user menu links Account settings above Sign out",
  /accountPath\(experience\)/.test(menu) && menu.indexOf("accountPath(") < menu.indexOf("signOutAction}"),
);
check("AppShell hands its experience to the user menu", /<UserMenu user=\{user\} experience=\{experience\} \/>/.test(code("components/shell/app-shell.tsx")));
for (const [group, file, builder, experience] of [
  ["(center)", "center-shell.tsx", "centerShell", "center"],
  ["(teacher)", "teacher-shell.ts", "teacherShell", "teacher"],
  ["(student)", "student-shell.tsx", "studentShell", "student"],
  ["(parent)", "parent-shell.ts", "parentShell", "parent"],
  ["(admin)", "admin-shell.ts", "adminShell", "admin"],
] as const) {
  const shellPath = `app/[locale]/${group}/${file}`;
  const shellCode = existsSync(join(ROOT, shellPath)) ? code(shellPath) : "";
  const frames = shellCode.match(/\bprops:\s*\{/g)?.length ?? 0;
  const tagged = shellCode.match(new RegExp(`experience: "${experience}"`, "g"))?.length ?? 0;
  check(`${group}: every frame ${builder}() returns is tagged "${experience}"`, frames > 0 && frames === tagged);
  const layout = code(`app/[locale]/${group}/layout.tsx`);
  check(`${group}: the layout renders ${builder}()'s frame`, layout.includes(`await ${builder}()`) && /<AppShell \{\.\.\.frame\.props\}>/.test(layout));
}
const page = code("app/[locale]/account/page.tsx");
check(
  "the account page renders every experience's shared frame",
  ["centerShell()", "teacherShell()", "studentShell({ interruptions: false })", "parentShell()", "adminShell()"].every((call) => page.includes(call)) &&
    /<AppShell \{\.\.\.frame\.props\}>/.test(page),
);
check("the account page keeps both named extension points", /<StudyDetailsSection\b/.test(page) && /<FamilySection\b/.test(page));

// ── F4: sign-up intent, account grade, promotion — the static shape ─────────
console.log("\nF4 - sign-up intent routes, never authorises");
const walkSources = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : walkSources(rel);
    return /\.(ts|tsx)$/.test(entry.name) ? [rel] : [];
  });
const sources = ["app", "lib", "components"].flatMap(walkSources);

check(
  "onboardingPath: STUDENT without a grade -> Your studies; with one -> the hub; PARENT -> the parent portal; TEACHER -> the directory; none -> today's behaviour",
  onboardingPath({ signupIntent: "STUDENT", gradeId: null }) === "/student/onboarding" &&
    onboardingPath({ signupIntent: "STUDENT", gradeId: "g" }) === null &&
    onboardingPath({ signupIntent: "PARENT", gradeId: null }) === "/parent" &&
    onboardingPath({ signupIntent: "TEACHER", gradeId: null }) === "/teacher/centers" &&
    onboardingPath({ signupIntent: null, gradeId: null }) === null,
);
check(
  "sign-up metadata: only STUDENT / PARENT / TEACHER survive; anything else is dropped to null (never stored)",
  profileFromMetadata({ id: "x", email: "a@b.c", user_metadata: { signup_intent: "TEACHER" } }).signupIntent === "TEACHER" &&
    profileFromMetadata({ id: "x", email: "a@b.c", user_metadata: { signup_intent: "OWNER" } }).signupIntent === null &&
    profileFromMetadata({ id: "x", email: "a@b.c", user_metadata: { signup_intent: 7 } }).signupIntent === null &&
    profileFromMetadata({ id: "x", email: "a@b.c", user_metadata: {} }).signupIntent === null,
);
const intentReaders = sources.filter((file) => /\bsignupIntent\b/.test(code(file))).sort();
const NEVER_READ_INTENT = [
  "lib/auth/permissions.ts",
  "lib/auth/relations.ts",
  "lib/db/permissions.ts",
  "lib/db/scoped.ts",
  "lib/db/tenant-scope.ts",
];
check(
  "no permission, relation-resolution or scoping module reads signupIntent — it grants nothing and is checked by no permission",
  NEVER_READ_INTENT.every((file) => !intentReaders.includes(file)) && !intentReaders.some((file) => /\/actions\.ts$/.test(file) && file.includes("(center)")),
  intentReaders.join(", "),
);
check(
  "the only readers of signupIntent are sign-up, routing, onboarding display, the account study gate and the student-account refusal",
  intentReaders.every((file) =>
    [
      "app/[locale]/(auth)/actions.ts",
      "app/[locale]/(auth)/register/intent-cards.tsx",
      "app/[locale]/(auth)/register/register-form.tsx",
      "app/[locale]/(auth)/select-center/page.tsx",
      "lib/auth/identity-link.ts",
      "lib/auth/onboarding.ts",
      "lib/auth/tenant.ts",
      "lib/db/account-study.ts",
      "lib/db/parents.ts",
      "lib/validation/auth.ts",
    ].includes(file),
  ),
  intentReaders.join(", "),
);
const signUpAction = exportedBody("app/[locale]/(auth)/actions.ts", "signUpAction");
check(
  "signUpAction carries the intent in the auth metadata and writes no User row itself",
  /signup_intent:\s*signupIntent/.test(signUpAction) && !/prisma\.user\./.test(signUpAction),
);
check("the register form requires an intent (a required radio group)", /name="signupIntent"[\s\S]*required/.test(code("app/[locale]/(auth)/register/intent-cards.tsx")));

console.log("\nF4 - the account grade never reaches a branch record");
const study = code("lib/db/account-study.ts");
const setGrade = functionBody("lib/db/account-study.ts", "setAccountGrade");
check("setAccountGrade writes User.gradeId and nothing else", /user\.update\(/.test(setGrade) && !/studentProfile|enrollment|payment/i.test(setGrade));
check(
  "the only branch write in account-study is the explicit, audited applyAccountGrade (student.grade.account), scoped by centerId",
  (study.match(/studentProfile\.(update|updateMany|create|delete)\w*\(/g) ?? []).length === 1 &&
    /"student\.grade\.account"/.test(study) && /centerId: input\.centerId/.test(study),
);
const ensure = functionBody("lib/db/reservations.ts", "ensureStudentProfile");
check(
  "ensureStudentProfile returns an existing profile untouched, and seeds only a new one from the account",
  ensure.indexOf("if (existing) return existing;") > 0 && ensure.indexOf("if (existing) return existing;") < ensure.indexOf("seedFromAccount("),
);
check("setting the account grade is a session-user action, never a form-supplied user id", !/userId/.test(code("app/[locale]/account/study-actions.ts").replace(/user\.id/g, "")));

console.log("\nF4 - promotion is a branch-record change only");
const promotion = code("lib/db/promotion.ts");
check(
  "lib/db/promotion.ts never writes an enrolment, class, session, payment, user or another table's grade",
  !/\b(enrollment|classGroup|session|payment|refund|settlement|user)\.(update|updateMany|create|createMany|delete|deleteMany|upsert)\(/.test(promotion),
);
check(
  "the batch, its items and the audit row are written on the same transaction as the grade change",
  /\$transaction\(async \(tx\)/.test(promotion) && /tx\.gradePromotionBatch\.create/.test(promotion) && /tx\.gradePromotionItem\.createMany/.test(promotion) && /writeAuditRow\(tx,/.test(promotion),
);
check("both audit actions exist: student.grade.promote and student.grade.promote.undo", /"student\.grade\.promote"/.test(promotion) && /"student\.grade\.promote\.undo"/.test(promotion));
const scopedModels = [...promotion.matchAll(/(?:studentProfile|gradePromotionBatch|enrollment)\.(?:findMany|findFirst|updateMany|groupBy)\(\{\s*where:\s*(\w+)/g)];
check(
  "every studentProfile / batch / enrolment query in promotion.ts is scopedWhere(centerId, ...), and each raw lock names the centre",
  scopedModels.length >= 5 && scopedModels.every((match) => match[1] === "scopedWhere") && (promotion.match(/"centerId" = \$\{centerId\}/g) ?? []).length >= 3,
  String(scopedModels.length),
);
const students = code("app/[locale]/(center)/students/actions.ts");
check(
  "confirm and undo are gated on student.promote and the old one-click promoteGradeAction is gone",
  /export async function confirmPromotionAction[\s\S]*?ctxCan\(ctx, "student\.promote"\)/.test(students) &&
    /export async function undoPromotionAction[\s\S]*?ctxCan\(ctx, "student\.promote"\)/.test(students) &&
    !/promoteGradeAction/.test(students),
);
check("the promote page is gated on student.promote", /requirePermission\(ctx, "student\.promote"\)/.test(code("app/[locale]/(center)/students/promote/page.tsx")));
check(
  "undo window: 14 days, open at exactly 14 days and closed a second later",
  PROMOTION_UNDO_DAYS === 14 &&
    isWithinUndoWindow(new Date(0), undoDeadline(new Date(0))) &&
    !isWithinUndoWindow(new Date(0), new Date(undoDeadline(new Date(0)).getTime() + 1000)),
);
const catalogGrade = { id: "a", nameAr: "ا", nameEn: "A", active: true, educationSystemId: null, educationSystem: null };
check(
  "the grade picker invents no order: grades are listed by name, never a guessed 'next grade'",
  !/next(Grade)?\b/i.test(code("lib/student-grade-options.ts")) &&
    gradePickerData("en", [catalogGrade], null, { noSystem: "Other", inactive: "Off" }).systems[0].value === "none",
);

if (failures > 0) {
  console.error(`\n${failures} account check(s) failed.`);
  process.exit(1);
}
console.log("\nAll account checks passed.");
