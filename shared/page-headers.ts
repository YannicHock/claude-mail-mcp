/**
 * The response headers every operator-facing HTML page in either service sets.
 *
 * One function rather than one literal per page, because these pages differ in
 * exactly one header and agree on the other three. The connector's settings
 * pages, the OAuth layer's settings pages, the setup wizard and the /authorize
 * consent screen all carry a CSRF token or a request token, all take a
 * password, must none of them be cached anywhere, and have none of them any
 * reason to be framed. Only the CSP differs — the consent screen has to widen
 * `form-action` to the redirect allowlist, because submitting it hands off to
 * the client — so the CSP is the parameter and the rest is fixed.
 *
 * The history is worth keeping, because it is the argument for this file. The
 * set was once written out three times: in the connector's settings-pages.ts,
 * in the OAuth layer's, and inline in `sendLoginPage()` in oauth/src/app.ts.
 * The consent screen's copy was outside every test, which is how it came to be
 * the page 0.6.1 and 0.6.2 were both about (#61, #80). #126 removed the last
 * pair: the two remaining copies were pinned by a drift test that pulled both
 * declarations out of the two files with a regex and compared the extracted
 * text. There is one declaration now, and both packages re-export it.
 *
 * Both services are served on pages of the same browser session, which is why
 * they could never afford to disagree here: a header the two spell differently
 * is a header whose effect depends on which service answered.
 */

export function pageHeaders(csp: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": csp,
    // same-origin, not no-referrer. These pages submit forms back to their own
    // origin, and the OAuth layer's POST handlers verify that with
    // isSameOrigin(), which reads Origin and falls back to Referer. Chrome does
    // not send Origin on a same-origin form POST, so no-referrer left the check
    // with neither header and refused every browser sign-in. same-origin still
    // withholds the referrer from any cross-origin destination, which is the
    // property that matters — and it keeps the connector's pages, which have no
    // such check today, from becoming a trap for whoever adds one.
    "Referrer-Policy": "same-origin",
  };
}

/**
 * The CSP for a page whose forms only ever post back to their own origin.
 *
 * Allows inline styles and nothing else — in particular no script, which is why
 * every interaction on these pages is a form submission. The /authorize consent
 * screen builds its own instead; see `loginCsp` in oauth/src/app.ts.
 */
export const SETTINGS_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/** The header set every settings response — in either service — carries. */
export const SETTINGS_HEADERS: Record<string, string> = pageHeaders(SETTINGS_CSP);
