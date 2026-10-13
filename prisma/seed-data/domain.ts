/**
 * The email domain every seed account uses (P1). `SEED_EMAIL_DOMAIN` in `.env`,
 * default `example.com` — RFC 2606's reserved domain, never a real mailbox.
 * Configurable because a Supabase project may refuse a given domain at the
 * admin API; `npm run seed:preflight` finds that out before anything is wiped.
 *
 * Dependency-free on purpose: the plan, the seed, the preflight, the docs
 * generator and `seed:verify` all read the one value from here.
 */
const DEFAULT_DOMAIN = "example.com";

function resolveDomain(): string {
  const raw = (process.env.SEED_EMAIL_DOMAIN ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_DOMAIN;
  if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(raw)) {
    throw new Error(`SEED_EMAIL_DOMAIN '${raw}' is not a valid domain (for example: example.com).`);
  }
  return raw;
}

export const SEED_EMAIL_DOMAIN: string = resolveDomain();
export const DEFAULT_SEED_EMAIL_DOMAIN = DEFAULT_DOMAIN;

/** `mail("owner.center60")` → `owner.center60@<domain>`. */
export function mail(localPart: string): string {
  return `${localPart}@${SEED_EMAIL_DOMAIN}`;
}
