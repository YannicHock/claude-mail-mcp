/**
 * What a browser actually sends to the origin check.
 *
 * Both form POSTs that take the operator's password — the settings sign-in and
 * the /authorize consent screen — are guarded by `isSameOrigin()`, which reads
 * `Origin` and falls back to `Referer`. Every other test here drives those POSTs
 * with `fetch`, which always sets `Origin`. Chrome does not: on a *same-origin*
 * form POST it sends no `Origin` at all, only `Referer`. That row of the matrix
 * was the one nobody exercised, and it was the one that broke — both pages
 * served `Referrer-Policy: no-referrer` until 0.6.1, which left the check with
 * neither header and refused every browser sign-in.
 *
 * So these tests take the header combinations away from what is convenient to
 * construct with `fetch` and pin down what browsers actually produce, against
 * both handlers. Each half also asserts the served `Referrer-Policy`, because
 * that header is the only reason the `Referer` row has anything to read.
 *
 * Where that policy comes from, precisely, because this docstring used to be
 * wrong about it: both pages now read `pageHeaders()` in settings-pages.ts, so
 * one edit there is enough to fail both halves below. That was not true before
 * #61 — the /authorize half read a set spelled out inline in app.ts, and
 * reintroducing the 0.6.0 bug across the OAuth layer took two edits, only one of
 * which any test noticed. The connector's own copy in src/settings-pages.ts is
 * still a third edit; it cannot import from here and is guarded instead by the
 * drift test in test/unit/settings-headers.test.ts.
 *
 * These cases assert `Referrer-Policy` alone, since that is the header the
 * origin check depends on. The full set is asserted, per page and on the wire,
 * in page-headers.test.ts.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  TEST_PASSWORD,
  TEST_USERNAME,
  getAuthorizePage,
  getSettings,
  postAuthorizeForm,
  signInWith,
  startHarness,
  type Harness,
} from "../helpers/harness.js";

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.close();
});

interface HeaderCase {
  /** How the request presents itself to the origin check. */
  name: string;
  /** Built from the issuer, which only exists once the harness is up. */
  headers(baseUrl: string): Record<string, string>;
  accepted: boolean;
}

/**
 * The four combinations a real client can arrive with, plus the cross-site
 * shape of the `Referer` fallback: an attacker's page POSTing here carries its
 * own document URL in whichever header the browser sends, so accepting the
 * fallback must not accept that.
 *
 * `formPath` is the page the form was rendered on — a browser's `Referer` is
 * that document's full URL, not a bare origin.
 */
function headerCases(formPath: string): HeaderCase[] {
  return [
    {
      name: "Origin present and correct",
      headers: (baseUrl) => ({ origin: baseUrl }),
      accepted: true,
    },
    {
      name: "no Origin and a same-origin Referer, as Chrome sends on a same-origin form POST",
      headers: (baseUrl) => ({ referer: `${baseUrl}${formPath}` }),
      accepted: true,
    },
    {
      name: "neither Origin nor Referer",
      headers: () => ({}),
      accepted: false,
    },
    {
      name: "Origin present but foreign",
      headers: () => ({ origin: "https://evil.example.com" }),
      accepted: false,
    },
    {
      name: "no Origin and a foreign Referer",
      headers: () => ({ referer: "https://evil.example.com/attack.html" }),
      accepted: false,
    },
  ];
}

/**
 * The refusal both handlers render. Asserting the body as well as the status
 * matters: a 403 from elsewhere in the chain would otherwise pass for this one.
 */
async function assertBlocked(response: Response): Promise<void> {
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Request blocked/);
}

/**
 * `Referrer-Policy` values that still send a full same-origin `Referer`, which
 * is what the `Origin`-less row above depends on. `no-referrer` is not one of
 * them, and neither is `origin`-style trimming: `isSameOrigin` parses the value
 * as a URL, so a bare origin would work, but any policy change here is a
 * decision that should be made deliberately rather than discovered in a browser.
 */
const REFERRER_POLICY = "same-origin";

describe("the settings sign-in POST, against the headers browsers really send", () => {
  for (const { name, headers, accepted } of headerCases("/settings")) {
    it(`${accepted ? "accepts" : "refuses"} a submission with ${name}`, async () => {
      const res = await signInWith(harness, TEST_USERNAME, TEST_PASSWORD, {
        headers: headers(harness.baseUrl),
      });

      if (!accepted) {
        await assertBlocked(res);
        assert.equal(res.headers.get("set-cookie"), null, "no session for a refused submission");
        return;
      }
      assert.equal(res.status, 303);
      assert.match(res.headers.get("set-cookie") ?? "", /^__Host-mailmcp_session=/);
    });
  }

  it("serves the sign-in page with a Referrer-Policy that keeps a same-origin Referer", async () => {
    const page = await getSettings(harness);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), REFERRER_POLICY);
  });
});

describe("the /authorize consent POST, against the headers browsers really send", () => {
  for (const { name, headers, accepted } of headerCases("/authorize")) {
    it(`${accepted ? "accepts" : "refuses"} a submission with ${name}`, async () => {
      const res = await postAuthorizeForm(harness, TEST_USERNAME, TEST_PASSWORD, {
        headers: headers(harness.baseUrl),
      });

      if (!accepted) {
        await assertBlocked(res);
        assert.equal(res.headers.get("location"), null, "no code for a refused submission");
        return;
      }
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get("location") ?? "");
      assert.ok(location.searchParams.get("code"), "an accepted submission issues a code");
    });
  }

  it("serves the consent page with a Referrer-Policy that keeps a same-origin Referer", async () => {
    const page = await getAuthorizePage(harness);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), REFERRER_POLICY);
  });
});
