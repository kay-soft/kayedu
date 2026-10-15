/**
 * Supabase Auth for the demo seed (P1) — **server-side only**, through the
 * admin API and the service-role key, and only for the seed's OWN fixed account
 * list (every address `@<SEED_EMAIL_DOMAIN>`, default example.com).
 *
 * Hard rules:
 *  - the password is `SEED_PASSWORD` — required, and refused if under 6
 *    characters; there is no default and nothing here prints it. The platform
 *    admin alone uses `SEED_ADMIN_PASSWORD` (SEC-2a, D-21 (a)): also ≥ 6
 *    characters and refused when it equals `SEED_PASSWORD`, so a tester given a
 *    demo login never holds the admin's;
 *  - **a seed account is recognised by a marker the seed itself writes**
 *    (`app_metadata.kayedu_seed = true`, settable only through the admin API).
 *    An account with a seed address that carries no marker was not made by the
 *    seed: the seed REFUSES to run rather than reset its password;
 *  - an auth user NOT in the list is never modified or deleted; the summary
 *    lists them so the person can see what else lives in the project;
 *  - `runAuthPreflight` is the check both `npm run seed:preflight` and the
 *    seed's own first step run: it creates ONE probe user, confirms it, and
 *    deletes exactly that id in a `finally`.
 */
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SEED_EMAIL_DOMAIN } from "./domain.ts";
import { productionTargetReason } from "./production-refs.ts";

export { SEED_EMAIL_DOMAIN };

/** The marker that says "the seed made this auth user". */
export const SEED_MARKER = { kayedu_seed: true } as const;

export type AuthAccount = {
  email: string;
  firstName: string;
  lastName: string;
  locale: "ar" | "en";
  /** The platform admin — signs in with SEED_ADMIN_PASSWORD (D-21). */
  admin?: boolean;
};

/** Both seed passwords, checked once (D-21): ≥ 6 characters each (Supabase Auth's own minimum — these are dev demo logins, never production: SEC-70), and different. */
export function seedPasswordProblems(env: Record<string, string | undefined> = process.env): string[] {
  const password = env.SEED_PASSWORD ?? "";
  const adminPassword = env.SEED_ADMIN_PASSWORD ?? "";
  const problems: string[] = [];
  if (password.length < 6) problems.push("SEED_PASSWORD is missing or shorter than 6 characters");
  if (adminPassword.length < 6) problems.push("SEED_ADMIN_PASSWORD is missing or shorter than 6 characters");
  if (adminPassword.length > 0 && adminPassword === password) {
    problems.push("SEED_ADMIN_PASSWORD must differ from SEED_PASSWORD");
  }
  return problems;
}

/** `postgres.<ref>` (pooler user), `db.<ref>.supabase.co`, or `<ref>.supabase.co`. */
export function projectRefOf(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const user = decodeURIComponent(url.username);
  if (user.startsWith("postgres.")) return user.slice("postgres.".length);
  const direct = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  if (direct) return direct[1];
  const api = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/);
  return api ? api[1] : null;
}

/** What the seed needs from Auth - satisfied by the real admin client or by "no Auth at all". */
export type AuthPort = {
  has(email: string): boolean;
  ensure(account: AuthAccount): Promise<string>;
  otherAuthUsers(): string[];
};

/** For a throwaway local database: no Supabase call is ever made, no account created. */
export function offlineAuth(): AuthPort {
  return {
    has: () => false,
    ensure: async () => {
      throw new Error("Supabase Auth is not available when seeding a local database.");
    },
    otherAuthUsers: () => [],
  };
}

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey || serviceRoleKey.startsWith("[")) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
  }
  return createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Supabase's own error text, status and code - exactly as returned. */
function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { message?: string; status?: number; code?: string; name?: string };
    const extra = [e.name, e.status !== undefined ? `status ${e.status}` : null, e.code ? `code ${e.code}` : null].filter(Boolean);
    return `${e.message ?? String(error)}${extra.length ? ` (${extra.join(", ")})` : ""}`;
  }
  return String(error);
}

type AuthUserRow = { id: string; email?: string; app_metadata?: Record<string, unknown> };

async function listAll(admin: SupabaseClient): Promise<AuthUserRow[]> {
  const all: AuthUserRow[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    all.push(...(data.users as AuthUserRow[]));
    if (data.users.length < 200) break;
  }
  return all;
}

export class SeedAuth implements AuthPort {
  private readonly admin: SupabaseClient;
  private readonly password: string;
  private readonly adminPassword: string;
  private readonly existing = new Map<string, string>(); // email → auth id (seed-made only)
  private readonly others = new Set<string>();
  private readonly seedEmails: Set<string>;

  private constructor(
    admin: SupabaseClient,
    password: string,
    adminPassword: string,
    seedEmails: Set<string>,
  ) {
    this.admin = admin;
    this.password = password;
    this.adminPassword = adminPassword;
    this.seedEmails = seedEmails;
  }

  /** Reads SEED_PASSWORD / SEED_ADMIN_PASSWORD and the Supabase env, refusing early and clearly. */
  static async connect(seedEmails: readonly string[]): Promise<SeedAuth> {
    const problems = seedPasswordProblems();
    if (problems.length > 0) {
      throw new Error(`${problems.join("; ")}. Set them in .env (SEED_PASSWORD for every seed account, SEED_ADMIN_PASSWORD for the platform admin).`);
    }
    const password = process.env.SEED_PASSWORD ?? "";
    const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "";
    for (const email of seedEmails) {
      if (!email.endsWith(`@${SEED_EMAIL_DOMAIN}`)) {
        throw new Error(`Seed account ${email} is not an @${SEED_EMAIL_DOMAIN} address.`);
      }
    }
    const admin = adminClient();
    const auth = new SeedAuth(
      admin,
      password,
      adminPassword,
      new Set(seedEmails.map((email) => email.toLowerCase())),
    );

    const collisions: string[] = [];
    for (const user of await listAll(admin)) {
      const email = user.email?.toLowerCase();
      if (!email) continue;
      if (!auth.seedEmails.has(email)) auth.others.add(email);
      else if (user.app_metadata?.kayedu_seed === true) auth.existing.set(email, user.id);
      else collisions.push(email);
    }
    if (collisions.length > 0) throw new Error(collisionMessage(collisions));
    return auth;
  }

  has(email: string): boolean {
    return this.seedEmails.has(email.toLowerCase());
  }

  /** Creates the account, or resets an account the seed made earlier. Returns its auth id. */
  async ensure(account: AuthAccount): Promise<string> {
    const email = account.email.toLowerCase();
    if (!this.seedEmails.has(email)) {
      throw new Error(`${email} is not in the seed's fixed account list; refusing to touch it.`);
    }
    const metadata = { first_name: account.firstName, last_name: account.lastName, locale: account.locale };
    const password = account.admin ? this.adminPassword : this.password;

    const known = this.existing.get(email);
    if (known) {
      const { error } = await this.admin.auth.admin.updateUserById(known, {
        password,
        email_confirm: true,
        user_metadata: metadata,
      });
      if (error) throw error;
      return known;
    }

    const { data, error } = await this.admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: metadata,
      app_metadata: SEED_MARKER,
    });
    if (error || !data.user) throw error ?? new Error(`Could not create auth user ${email}`);
    this.existing.set(email, data.user.id);
    return data.user.id;
  }

  /** Auth users in this project that are not seed accounts — left exactly as they were. */
  otherAuthUsers(): string[] {
    return [...this.others].sort();
  }
}

function collisionMessage(emails: string[]): string {
  return (
    `These auth users already exist with a seed address but were NOT created by the seed, so it will not touch them (it never resets a non-seed user's password): ${emails.join(", ")}. ` +
    "Delete them in the Supabase dashboard (Authentication → Users), or choose another SEED_EMAIL_DOMAIN."
  );
}

// ── The preflight ────────────────────────────────────────────────────────────

export type PreflightStep = { name: string; ok: boolean; detail: string };
export type PreflightResult = { ok: boolean; steps: PreflightStep[]; others: string[] };

/**
 * Everything that can go wrong with Auth, found BEFORE a wipe or a seed:
 * password length, project refs, the service-role key, any address clash with
 * an auth user the seed did not make, and one real probe (create → confirm →
 * delete) with the seed's own domain and password rules. Writes nothing to the
 * application database. The probe is the only auth user this ever creates and
 * the only one it ever deletes (by the id it just got back).
 */
export async function runAuthPreflight(seedEmails: readonly string[]): Promise<PreflightResult> {
  const steps: PreflightStep[] = [];
  const add = (name: string, ok: boolean, detail: string) => steps.push({ name, ok, detail });
  const result = (others: string[] = []): PreflightResult => ({ ok: steps.every((step) => step.ok), steps, others });

  const password = process.env.SEED_PASSWORD ?? "";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "";
  add("SEED_PASSWORD is at least 6 characters", password.length >= 6, password.length >= 6 ? `${password.length} characters` : `${password.length} characters (need 6+)`);
  add(
    "SEED_ADMIN_PASSWORD is at least 6 characters (D-21)",
    adminPassword.length >= 6,
    adminPassword.length >= 6 ? `${adminPassword.length} characters` : `${adminPassword.length} characters (need 6+)`,
  );
  add(
    "SEED_ADMIN_PASSWORD differs from SEED_PASSWORD (D-21)",
    adminPassword.length === 0 || adminPassword !== password,
    adminPassword !== password ? "different" : "the same — the platform admin must not share the demo password",
  );
  add("Seed email domain", true, `@${SEED_EMAIL_DOMAIN}${process.env.SEED_EMAIL_DOMAIN ? " (SEED_EMAIL_DOMAIN)" : " (default)"}`);

  const devRef = process.env.DEV_PROJECT_REF?.trim() ?? "";
  const dbRef = projectRefOf(process.env.DATABASE_URL);
  const production = productionTargetReason();
  add("Not a production project or environment (SEC-70)", production === null, production ?? "not production");
  add(
    "DEV_PROJECT_REF matches DATABASE_URL's project ref",
    devRef !== "" && dbRef === devRef,
    devRef === "" ? "DEV_PROJECT_REF is not set" : dbRef === null ? "could not read a project ref out of DATABASE_URL" : dbRef === devRef ? "match" : `DATABASE_URL is project '${dbRef}', DEV_PROJECT_REF is '${devRef}'`,
  );
  for (const name of ["DIRECT_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const) {
    const ref = projectRefOf(process.env[name]);
    add(`${name} points at the same project`, ref === null || ref === devRef, ref === null ? "no ref to compare (skipped)" : ref === devRef ? "match" : `project '${ref}'`);
  }
  if (!steps.every((step) => step.ok)) return result();

  let admin: SupabaseClient;
  try {
    admin = adminClient();
  } catch (error) {
    add("Supabase admin client", false, describeError(error));
    return result();
  }

  let users: AuthUserRow[];
  try {
    users = await listAll(admin);
    add("The service-role key works (auth users listed)", true, `${users.length} auth user(s) in the project`);
  } catch (error) {
    add("The service-role key works (auth users listed)", false, describeError(error));
    return result();
  }

  const wanted = new Set(seedEmails.map((email) => email.toLowerCase()));
  const others: string[] = [];
  const collisions: string[] = [];
  let remade = 0;
  for (const user of users) {
    const email = user.email?.toLowerCase();
    if (!email) continue;
    if (!wanted.has(email)) others.push(email);
    else if (user.app_metadata?.kayedu_seed === true) remade += 1;
    else collisions.push(email);
  }
  add(
    "No seed address belongs to an auth user the seed did not make",
    collisions.length === 0,
    collisions.length === 0 ? `${remade} seed-made account(s) already exist (they will be reset to SEED_PASSWORD)` : collisionMessage(collisions),
  );

  // The probe: the exact email domain and password the seed will use.
  const probeEmail = `probe-${randomBytes(6).toString("hex")}@${SEED_EMAIL_DOMAIN}`;
  let probeId: string | null = null;
  try {
    const { data, error } = await admin.auth.admin.createUser({
      email: probeEmail,
      password,
      email_confirm: true,
      user_metadata: { first_name: "Probe", last_name: "Seed", locale: "en" },
      app_metadata: SEED_MARKER,
    });
    if (error || !data.user) {
      add(`A probe user can be created (${probeEmail})`, false, describeError(error));
    } else {
      probeId = data.user.id;
      const fetched = await admin.auth.admin.getUserById(probeId);
      const confirmed = !fetched.error && fetched.data.user?.email?.toLowerCase() === probeEmail;
      add(
        `A probe user can be created and read back (${probeEmail})`,
        confirmed,
        confirmed ? "created, confirmed, found" : fetched.error ? describeError(fetched.error) : "created but not found",
      );
    }
  } catch (error) {
    add(`A probe user can be created (${probeEmail})`, false, describeError(error));
  } finally {
    if (probeId) {
      try {
        const { error } = await admin.auth.admin.deleteUser(probeId);
        add("The probe user was deleted again", !error, error ? describeError(error) : "deleted");
      } catch (error) {
        add("The probe user was deleted again", false, describeError(error));
      }
    }
  }
  return result(others.sort());
}
