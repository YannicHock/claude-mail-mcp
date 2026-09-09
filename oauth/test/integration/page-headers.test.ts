/**
 * The security headers this service's HTML pages are served with, asserted on
 * the wire.
 *
 * Until #61 only two of the four values had ever been checked against a real
 * response anywhere in this package: `Referrer-Policy`, by origin-check.test.ts,
 * and `Cache-Control`, by settings-session.test.ts. `X-Frame-Options` and
 * `Content-Security-Policy` were asserted in memory only, against
 * `SETTINGS_HEADERS` itself — and a test that reads the constant passes just as
 * happily when the constant is never sent, or when a page builds its own set
 * next to it. The /authorize consent screen did exactly that, which is why the
 * page the operator types a password into was the one page nothing covered.
 *
 * So: every page, the whole set, off a real response, against literals written
 * out here rather than derived from the source. Same two-guarantee shape as the
 * connector's test/unit/settings-headers.test.ts.
 *
 * The consent screen's CSP is the one value that differs, and differs for a
 * reason — `form-action` has to name the redirect allowlist's origins, because
 * submitting that form hands the browser off to the client. Everything else is
 * identical, and now identical by construction: all of it comes from
 * `pageHeaders()` in settings-pages.ts.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  TEST_PASSWORD,
  TEST_USERNAME,
  getAuthorizePage,
  getClients,
  getSettings,
  postAuthorizeForm,
  startHarness,
  type Harness,
} from "../helpers/harness.js";

let harness: Harness;
let cookie: string;

before(async () => {
  harness = await startHarness();
  cookie = await harness.signIn();
});

after(async () => {
  await harness.close();
});

/**
 * The CSP a page whose forms only post back here is served with.
 *
 * Deliberately not imported from `SETTINGS_HEADERS`: this is the second opinion
 * that catches a change to the constant, and it only works while it is spelled
 * out independently.
 */
const SELF_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/**
 * The CSP the /authorize consent screen is served with, for a harness whose
 * redirect allowlist is the two hosted Claude callbacks.
 *
 * `form-action` cannot be plain 'self' here. Chrome enforces it against the
 * *redirect target* as well as the action URL, so 'self' alone blocks the
 * hand-off to claude.ai and the flow dies on its last step with a console-only
 * error. Widened to exactly the origins a redirect_uri is already validated
 * against, and nothing else — so if this literal ever has to grow, that is a
 * decision worth reading in a diff.
 */
const CONSENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; " +
  "form-action 'self' https://claude.ai https://claude.com; frame-ancestors 'none'";

/** The three values every page agrees on, whatever its CSP. */
function expectedHeaders(csp: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": csp,
    // The entry with a history: `no-referrer` here left `isSameOrigin()` with
    // neither `Origin` nor `Referer` on a Chrome form POST and made every
    // browser sign-in impossible in 0.6.0.
    "referrer-policy": "same-origin",
  };
}

function assertHeaders(res: Response, csp: string, page: string): void {
  for (const [name, value] of Object.entries(expectedHeaders(csp))) {
    assert.equal(res.headers.get(name), value, `expected ${name} on ${page}`);
  }
}

describe("every operator-facing page serves the whole header set", () => {
  it("the settings sign-in page does", async () => {
    const res = await getSettings(harness);
    assert.equal(res.status, 200);
    assertHeaders(res, SELF_CSP, "the settings sign-in page");
  });

  it("the settings overview does", async () => {
    const res = await getSettings(harness, cookie);
    assert.equal(res.status, 200);
    assertHeaders(res, SELF_CSP, "the settings overview");
  });

  it("the clients page does", async () => {
    const res = await getClients(harness, cookie);
    assert.equal(res.status, 200);
    assertHeaders(res, SELF_CSP, "the clients page");
  });

  it("the /authorize consent screen does, with its own form-action", async () => {
    // The page this whole file exists for: it takes the operator's password and
    // it built its own header set inline until #61, outside every guard covering
    // the identical set next door.
    const res = await getAuthorizePage(harness);
    assert.equal(res.status, 200);
    assertHeaders(res, CONSENT_CSP, "the /authorize consent screen");
  });

  it("the consent screen re-served after a wrong password does too", async () => {
    // A second call site of the same helper, and the one an attacker reaches
    // most often. A 401 that forgot `Cache-Control: no-store` would leave the
    // request token and the typed username in a shared cache.
    const res = await postAuthorizeForm(harness, TEST_USERNAME, "not the password");
    assert.equal(res.status, 401);
    assertHeaders(res, CONSENT_CSP, "the consent screen after a failed sign-in");
  });
});

describe("the consent screen and the settings pages differ only in the CSP", () => {
  it("agrees on cache, framing and referrer", async () => {
    // Stated as a property rather than as two lists of literals, so a fifth
    // header added to one page and not the other is a failure here even if
    // nobody thinks to add it to `expectedHeaders`.
    const consent = await getAuthorizePage(harness);
    const settings = await getSettings(harness);

    for (const name of ["cache-control", "x-frame-options", "referrer-policy"]) {
      assert.equal(
        consent.headers.get(name),
        settings.headers.get(name),
        `${name} differs between the consent screen and the settings pages`
      );
    }
    assert.notEqual(
      consent.headers.get("content-security-policy"),
      settings.headers.get("content-security-policy"),
      "the consent screen needs a wider form-action; if these are equal, one of them is wrong"
    );
  });
});
