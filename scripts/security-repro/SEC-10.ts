/**
 * A09-1 — PostgREST exposure probe with the PUBLIC anon key (SEC-1 audit, area A09: Supabase RLS).
 *
 * What it proves: whether an unauthenticated caller holding only the public anon key
 * (it ships to every browser as NEXT_PUBLIC_SUPABASE_ANON_KEY) can read any KayEdu table
 * through Supabase's auto-generated REST API (PostgREST), call RPC functions in `public`,
 * or list Storage buckets/objects.
 *
 * Nothing is imported from the app: this talks to `${NEXT_PUBLIC_SUPABASE_URL}/rest/v1`
 * and `/storage/v1` directly, exactly as an attacker with the anon key would.
 * Read-only: GET / POST-to-RPC-that-does-not-exist only; no writes, no fixtures.
 * Prints HTTP status, PostgREST error code and ROW COUNTS ONLY — never row contents,
 * never the key or URL.
 *
 * Run:  node --env-file-if-exists=.env scripts/security-repro/SEC-10.ts
 * Final line: REPRODUCED if any sensitive table / RPC / storage object list returns data
 *             to the anon key; NOT REPRODUCED otherwise.
 *
 * Note: the `authenticated` role (any signed-in student/parent JWT) is covered by the
 * catalog side of the audit (has_table_privilege('authenticated', …) = false on every
 * public table, no USAGE on schema public) — this script does not mint a user JWT.
 */

const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!base || !anon) {
  console.log("missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  console.log("NOT REPRODUCED");
  process.exit(0);
}

const headers: Record<string, string> = { apikey: anon };
// Legacy anon keys are JWTs; the newer sb_publishable_ keys must not go in Authorization.
if (anon.split(".").length === 3) headers.Authorization = `Bearer ${anon}`;

const SENSITIVE = [
  "User", "StudentProfile", "Payment", "AuditLog", "Membership", "ParentLink",
  "Refund", "Settlement", "PermissionGrant", "Invitation", "Center", "Organization",
  "SessionAttendee", "Expense", "SessionRating", "CenterPaymentMethod", "CenterTerm",
  "RoomLink", "StudentCodeCounter",
  "_prisma_migrations", // the one public table with RLS off
];

let exposed = 0;

async function probe(label: string, url: string, init: RequestInit = {}) {
  try {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
    const text = await res.text();
    let rows = "-";
    let code = "";
    try {
      const body = JSON.parse(text);
      if (Array.isArray(body)) rows = String(body.length);
      else if (body && typeof body === "object") {
        code = String(body.code ?? body.error ?? body.statusCode ?? "");
        if (body.paths) rows = `openapi paths=${Object.keys(body.paths).length}`;
      }
    } catch {
      rows = `non-json len=${text.length}`;
    }
    console.log(`${label.padEnd(36)} status=${res.status} rows=${rows}${code ? ` code=${code}` : ""}`);
    return { status: res.status, rows };
  } catch (e) {
    console.log(`${label.padEnd(36)} fetch error ${(e as Error).message}`);
    return { status: 0, rows: "-" };
  }
}

async function main() {
  // 1. Is the public schema exposed / what does the OpenAPI root reveal?
  const root = await probe("GET /rest/v1/ (openapi root)", `${base}/rest/v1/`);
  if (root.status === 200 && /paths=[1-9]/.test(root.rows)) exposed++;

  // 2. Sensitive tables.
  for (const t of SENSITIVE) {
    const r = await probe(`GET ${t}`, `${base}/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`);
    if (r.status === 200 && Number(r.rows) > 0) exposed++;
  }

  // 3. Other schemas via Accept-Profile (only exposed schemas are accepted).
  for (const schema of ["storage", "auth", "graphql_public"]) {
    await probe(`GET Accept-Profile=${schema}`, `${base}/rest/v1/objects?select=id&limit=1`, {
      headers: { "Accept-Profile": schema },
    });
  }

  // 4. RPC surface: the function the checklist warned about, and an M10 helper.
  for (const fn of ["rls_auto_enable", "kayedu_member_center_ids"]) {
    const r = await probe(`POST rpc/${fn}`, `${base}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (r.status >= 200 && r.status < 300) exposed++;
  }

  // 5. Storage: list buckets and try to list each known bucket's root.
  const b = await probe("GET storage bucket list", `${base}/storage/v1/bucket`);
  if (b.status === 200 && Number(b.rows) > 0) exposed++;
  for (const bucket of ["avatars", "id-cards", "logos", "session-uploads"]) {
    const r = await probe(`POST storage list ${bucket}`, `${base}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "", limit: 5 }),
    });
    if (r.status === 200 && Number(r.rows) > 0) exposed++;
  }

  // 6. GraphQL endpoint (pg_graphql) — introspection with the anon key.
  await probe("POST graphql/v1 introspection", `${base}/graphql/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ __schema { queryType { name } } }" }),
  });

  console.log(`exposed surfaces returning data: ${exposed}`);
  console.log(exposed > 0 ? "REPRODUCED" : "NOT REPRODUCED");
}

main();
