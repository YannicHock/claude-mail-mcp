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
 *
 * #80 is why the second half of this file exists. #61 fixed `sendLoginPage()`
 * and did not notice `respondWithErrorPage()` two lines above it — the same
 * defect, in the same file, surviving the fix aimed at it — and nothing here
 * could see that, because every case above reaches a page that renders a *form*.
 * The six /authorize refusals render an error page instead; they went out with
 * no `Cache-Control`, no `X-Frame-Options`, no CSP and no `Referrer-Policy`, and
 * nothing in this package ever asked. So: one case per error-page entry point,
 * written out by hand, so that a seventh added later has a visibly empty slot
 * next to it.
 *
 * #136 is why there is a third part. Every case above reaches a response that
 * renders *something*, and the two redirects on the authorization path render
 * nothing — which is exactly why nobody thought to ask what headers they carry.
 * They carried none, and Express put the authorization code in the body it
 * renders for a redirect. The last section covers both.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  CLAUDE_CALLBACK,
  TEST_PASSWORD,
  TEST_USERNAME,
  getAuthorizePage,
  getClients,
  getSettings,
  makePkce,
  postAuthorizeForm,
  registerClaudeClient,
  signInWith,
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

// ---- The error pages ------------------------------------------------------

/**
 * GET /authorize with a valid PKCE pair and whatever else the caller says.
 *
 * An empty value deletes the parameter, which is how the two "missing" cases
 * below are built: an absent `client_id` and an absent `redirect_uri` are
 * separate refusals in separate branches, and a helper that always sent both
 * would reach neither.
 */
async function getAuthorizeWith(params: Record<string, string>): Promise<Response> {
  const url = new URL(`${harness.baseUrl}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", makePkce().challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [name, value] of Object.entries(params)) {
    if (value === "") url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  return fetch(url, { redirect: "manual" });
}

/** A client registered the way Claude's hosted surfaces register one. */
async function registeredClientId(): Promise<string> {
  const registration = await registerClaudeClient(harness.baseUrl);
  return registration.body.client_id as string;
}

/**
 * One case per way to reach `respondWithErrorPage()` in app.ts.
 *
 * They carry the *strict* CSP, not the consent screen's, and asserting that is a
 * real claim rather than a formality. The consent screen widens `form-action` to
 * the redirect allowlist because submitting it redirects the browser to the
 * client and Chrome enforces `form-action` against the redirect target too;
 * `renderErrorPage()` contains no `<form>` at all, so there is nothing for the
 * wider value to permit. An error page arriving with `https://claude.ai` in its
 * `form-action` would be granting a permission it has no use for, and `SELF_CSP`
 * below fails on it.
 *
 * Each case matches the rendered title as well as the status, because four of
 * the six are 400s out of the same handler and a 400 from the wrong branch would
 * otherwise pass for the one under test.
 */
describe("every /authorize refusal that renders a page serves the whole header set", () => {
  it("does on a missing client_id", async () => {
    const res = await getAuthorizeWith({ redirect_uri: CLAUDE_CALLBACK });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Invalid request/);
    assertHeaders(res, SELF_CSP, "the missing-client_id error page");
  });

  it("does on an unknown client", async () => {
    const res = await getAuthorizeWith({
      client_id: "never-registered",
      redirect_uri: CLAUDE_CALLBACK,
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Unknown client/);
    assertHeaders(res, SELF_CSP, "the unknown-client error page");
  });

  it("does on a missing redirect_uri", async () => {
    const res = await getAuthorizeWith({ client_id: await registeredClientId() });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Invalid request/);
    assertHeaders(res, SELF_CSP, "the missing-redirect_uri error page");
  });

  it("does on a redirect_uri the client never registered", async () => {
    // The refusal that must not redirect: sending an OAuth error to an
    // unvalidated URI is the open redirect the ordering in app.ts exists to
    // prevent, so this branch renders a page — and this is that page.
    const res = await getAuthorizeWith({
      client_id: await registeredClientId(),
      redirect_uri: "https://evil.example.com/steal",
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
    assert.match(await res.text(), /Invalid redirect URI/);
    assertHeaders(res, SELF_CSP, "the unregistered-redirect_uri error page");
  });

  it("does on a POST the origin check refuses", async () => {
    const res = await postAuthorizeForm(harness, TEST_USERNAME, TEST_PASSWORD, {
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Request blocked/);
    assertHeaders(res, SELF_CSP, "the origin-check refusal");
  });

  it("does on a request token that is no longer valid", async () => {
    // The one an operator reaches by leaving a tab open rather than by attacking
    // anything, and it names the client they were connecting. `no-store` on it is
    // what keeps that out of a shared cache.
    const res = await fetch(`${harness.baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: harness.baseUrl,
      },
      body: new URLSearchParams({
        request: "not.a.real.token",
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
      }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Session expired/);
    assertHeaders(res, SELF_CSP, "the expired-request-token error page");
  });
});

describe("the settings layer's error page serves it too", () => {
  it("does on a sign-in POST the origin check refuses", async () => {
    // The same `renderErrorPage()` output, reached through a different route
    // module's send helper. It has always carried the set; asserting it here is
    // what makes "every error page in this service, on the wire" a statement
    // about the service rather than about one file in it.
    const res = await signInWith(harness, TEST_USERNAME, TEST_PASSWORD, {
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Request blocked/);
    assertHeaders(res, SELF_CSP, "the settings origin-check refusal");
  });
});

// ---- The redirects --------------------------------------------------------

/**
 * The two responses on the authorization path that are not pages at all.
 *
 * #80 made "every HTML response goes out through `sendPage()`" true and left a
 * gap that sentence does not cover: a *redirect* is an HTML response too.
 * Express renders a body for one — `<p>Found. Redirecting to …</p>` when the
 * client accepts `text/html`, the bare URL when it does not — and
 * `res.redirect()` sets none of this service's headers. The success redirect's
 * body carried the one-time authorization code; `redirectWithError`'s carried
 * the `error_description`.
 *
 * So both halves are asserted here: the whole header set on a redirect, and an
 * empty body. The body assertion is deliberately stronger than "does not contain
 * the code" — nothing at all is the only shape that cannot leak the next
 * parameter someone adds to the target URL.
 *
 * `Accept: text/html` on both requests, because that is what a browser sends and
 * it is the header that selects Express's HTML body. A request without it gets
 * the `text/plain` branch, which leaks exactly the same values.
 */
const BROWSER_ACCEPT = "text/html,application/xhtml+xml";

/** GET /authorize as a browser would, with whatever parameters the caller says. */
async function getAuthorizeAsBrowser(params: Record<string, string>): Promise<Response> {
  const url = new URL(`${harness.baseUrl}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", makePkce().challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [name, value] of Object.entries(params)) {
    if (value === "") url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  return fetch(url, { redirect: "manual", headers: { Accept: BROWSER_ACCEPT } });
}

describe("the /authorize redirects serve the header set and no body", () => {
  it("does on the success redirect, and does not echo the code", async () => {
    // The one credential-carrying response in this service. Its Location has the
    // authorization code in it, which is correct and unavoidable; its *body* had
    // it too, on a response carrying no `Cache-Control: no-store`.
    const res = await postAuthorizeForm(harness, TEST_USERNAME, TEST_PASSWORD, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: harness.baseUrl,
        Accept: BROWSER_ACCEPT,
      },
    });
    assert.equal(res.status, 302);

    const location = res.headers.get("location");
    assert.ok(location, "the success redirect must carry a Location");
    const code = new URL(location).searchParams.get("code");
    assert.ok(code, "the success redirect must carry a code in its Location");

    assertHeaders(res, SELF_CSP, "the /authorize success redirect");

    const body = await res.text();
    assert.ok(!body.includes(code), "the authorization code must not appear in the body");
    assert.equal(body, "", "a redirect must send no body");
  });

  it("does on an OAuth error redirect, and does not echo the description", async () => {
    // Past the redirect-URI validation, so the refusal goes back to the client
    // as an OAuth error rather than rendering a page. `error_description` in an
    // unprotected body is the same defect one value down.
    const res = await getAuthorizeAsBrowser({
      client_id: await registeredClientId(),
      redirect_uri: CLAUDE_CALLBACK,
      response_type: "token",
    });
    assert.equal(res.status, 302);

    const location = res.headers.get("location");
    assert.ok(location, "the error redirect must carry a Location");
    assert.equal(new URL(location).searchParams.get("error"), "unsupported_response_type");

    assertHeaders(res, SELF_CSP, "the /authorize error redirect");
    assert.equal(await res.text(), "", "a redirect must send no body");
  });
});
