/**
 * The same-origin test for a route handler (SEC-52). Server Actions are checked by
 * Next; a route handler is not, so `/api/assessment-attempts/[id]/close` runs this.
 *
 * It fails closed: no Origin header, an Origin that does not parse, a browser that
 * says the request is not same-origin (`Sec-Fetch-Site`), or an origin that is not
 * byte-for-byte one of the allowed origins, is refused. An origin is
 * `scheme://host[:port]` compared as a whole, never a suffix, prefix or substring.
 */

type HeaderReader = { get(name: string): string | null };

/** `https://a.example` for a header value, or null when it is not a bare origin. */
function normaliseOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // A real Origin header has no path, query, fragment or credentials.
    if (url.origin !== value.trim().replace(/\/+$/, "")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The origins this request may come from: the configured app origin when set,
 * otherwise the request's own scheme and host (the proxy-forwarded ones first).
 */
export function allowedOrigins(headers: HeaderReader, appUrl: string | undefined, fallbackProtocol: string): string[] {
  const configured = normaliseOrigin(appUrl);
  if (configured) return [configured];
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim();
  const proto = (headers.get("x-forwarded-proto") ?? fallbackProtocol.replace(/:$/, "")).split(",")[0].trim();
  const own = host ? normaliseOrigin(`${proto}://${host}`) : null;
  return own ? [own] : [];
}

export function isSameOriginRequest(request: { origin: string | null; secFetchSite: string | null }, allowed: string[]): boolean {
  const origin = normaliseOrigin(request.origin);
  if (!origin) return false;
  if (request.secFetchSite !== null && request.secFetchSite !== "same-origin") return false;
  return allowed.includes(origin);
}
