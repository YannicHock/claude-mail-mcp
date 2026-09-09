/**
 * URL canonicalisation, RFC 8707 section 2 — one rule, spelled once per package.
 *
 * `PUBLIC_URL` is written twice, once in `.env.oauth` for this service and once
 * in `.env` for the connector, and the two have to denote the same URL: it
 * travels as the settings assertion's `iss` claim and the connector's
 * src/settings-assertion.ts compares it with `!==`. That comparison stays
 * strict — teaching a security-relevant identifier's comparison to be lenient is
 * the worse of the two available fixes — so both sides canonicalise first, and
 * they must canonicalise *identically*. Until #110 they did not: this package ran
 * the value through `new URL`, which lowercases scheme and host and elides a
 * default port, while the connector only trimmed it and stripped trailing
 * slashes. `https://Mail.example.com` on one side against
 * `https://mail.example.com` on the other then answered 401 to every settings
 * request, with nothing anywhere naming the cause.
 *
 * This file is the OAuth layer's copy. `src/canonical-url.ts` in the connector is
 * the other, and the two are identical below this comment; the drift test in the
 * connector's test/unit/canonical-url.test.ts fails if they part company, the
 * same way secrets.test.ts and settings-api.test.ts pin the two other mirrored
 * pairs. The packages have separate Docker build contexts and cannot import from
 * one another, so a mirrored module is the closest thing to a shared one they
 * have.
 *
 * Only the canonicalisation is mirrored, not the rest of `urls.ts`: redirect-URI
 * matching and the Claude redirect allowlists are this service's own business and
 * the connector has no use for them. `urls.ts` re-exports the three functions
 * below, so this package keeps one URL module and neither package ends up holding
 * two copies of the rule.
 */

/**
 * Canonicalise a resource identifier per RFC 8707 section 2: lowercase scheme and
 * host, drop a default port, drop any fragment, and drop a bare trailing slash.
 *
 * Throws for input that is not a usable absolute URI — a fragment is rejected
 * outright rather than silently stripped, because a `resource` carrying one is a
 * client bug worth surfacing, not something to paper over.
 *
 * Surrounding whitespace needs no separate trim: the WHATWG URL parser strips
 * leading and trailing spaces and C0 controls before it parses, so a value that
 * picked one up on its way out of an `.env` file canonicalises to the same string
 * as one that did not.
 */
export function canonicalResource(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Not an absolute URI: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Resource URI must be http or https: ${value}`);
  }
  if (url.hash !== "") {
    throw new Error(`Resource URI must not contain a fragment: ${value}`);
  }
  // `new URL` already lowercases scheme and host and elides the default port.
  url.search = "";
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** True when two resource identifiers denote the same resource. */
export function sameResource(a: string, b: string): boolean {
  try {
    return canonicalResource(a) === canonicalResource(b);
  } catch {
    return false;
  }
}

/**
 * Normalise a configured public base URL: no trailing slash, no query, no fragment.
 * Used as the OAuth issuer, so it must be stable and byte-identical everywhere it
 * appears — clients compare the `iss` in an authorization response against the
 * issuer from metadata with simple string comparison (RFC 9207 section 2.4), and
 * the settings assertion the OAuth layer mints for the connector carries the same
 * value as its own `iss`.
 */
export function normalisePublicUrl(value: string): string {
  return canonicalResource(value);
}
