/**
 * The refusals. Each of these is a way in if it is missing.
 */

import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  CLAUDE_CALLBACK,
  TEST_PASSWORD,
  TEST_USERNAME,
  extractRequestToken,
  makePkce,
  registerClaudeClient,
  startHarness,
  type Harness,
} from "../helpers/harness.js";
import { LoginThrottle } from "../../src/throttle.js";

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.close();
});

/** Start an authorization request and return the rendered form's request token. */
async function beginAuthorization(
  overrides: Record<string, string> = {}
): Promise<{ clientId: string; challenge: string; verifier: string; response: Response }> {
  const registration = await registerClaudeClient(harness.baseUrl);
  const clientId = registration.body.client_id as string;
  const { verifier, challenge } = makePkce();

  const url = new URL(`${harness.baseUrl}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(overrides)) {
    if (value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }

  return {
    clientId,
    challenge,
    verifier,
    response: await fetch(url, { redirect: "manual" }),
  };
}

/** Sign in against a request token and return the redirect's authorization code. */
async function signIn(requestToken: string): Promise<string> {
  const login = await fetch(`${harness.baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: harness.baseUrl,
    },
    body: new URLSearchParams({
      request: requestToken,
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    }),
  });
  const location = login.headers.get("location");
  assert.ok(location, `expected a redirect, got ${login.status}`);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  return code;
}

describe("/authorize client and redirect validation", () => {
  it("refuses an unknown client with a page, not a redirect", async () => {
    const url = new URL(`${harness.baseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "never-registered");
    url.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
    url.searchParams.set("code_challenge", makePkce().challenge);
    url.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(url, { redirect: "manual" });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
  });

  it("refuses a redirect_uri the client did not register, without redirecting", async () => {
    // Redirecting an error to an unvalidated URI is the open redirect this
    // ordering exists to prevent.
    const registration = await registerClaudeClient(harness.baseUrl);
    const url = new URL(`${harness.baseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", registration.body.client_id as string);
    url.searchParams.set("redirect_uri", "https://evil.example.com/steal");
    url.searchParams.set("code_challenge", makePkce().challenge);
    url.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(url, { redirect: "manual" });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
  });

  it("refuses a registration whose redirect_uri is not Claude's callback", async () => {
    const result = await registerClaudeClient(harness.baseUrl, {
      redirect_uris: ["https://evil.example.com/steal"],
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "invalid_redirect_uri");
  });
});

describe("/authorize request validation", () => {
  it("refuses a missing PKCE challenge", async () => {
    const { response } = await beginAuthorization({ code_challenge: "" });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.searchParams.get("error"), "invalid_request");
  });

  it("refuses code_challenge_method=plain", async () => {
    const { response } = await beginAuthorization({ code_challenge_method: "plain" });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.searchParams.get("error"), "invalid_request");
  });

  it("refuses a malformed code_challenge", async () => {
    const { response } = await beginAuthorization({ code_challenge: "too-short" });
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.searchParams.get("error"), "invalid_request");
  });

  it("refuses an unsupported response_type", async () => {
    const { response } = await beginAuthorization({ response_type: "token" });
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.searchParams.get("error"), "unsupported_response_type");
  });

  it("refuses a resource naming a different server", async () => {
    const { response } = await beginAuthorization({
      resource: "https://someone-elses-server.example.com/mcp",
    });
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.searchParams.get("error"), "invalid_target");
  });

  it("accepts the resource in the form the operator may have typed it", async () => {
    // Claude sends the canonical form, but the check must not be byte-for-byte.
    const { response } = await beginAuthorization({
      resource: `${harness.baseUrl.toUpperCase()}/mcp/`,
    });
    assert.equal(response.status, 200);
  });

  it("carries state through to an error redirect, with iss", async () => {
    const { response } = await beginAuthorization({
      response_type: "token",
      state: "keep-me",
    });
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.searchParams.get("state"), "keep-me");
    assert.equal(location.searchParams.get("iss"), harness.baseUrl);
  });
});

describe("sign-in", () => {
  it("refuses a wrong password without issuing a code", async () => {
    const { response } = await beginAuthorization();
    const requestToken = extractRequestToken(await response.text())!;

    const login = await fetch(`${harness.baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: harness.baseUrl,
      },
      body: new URLSearchParams({
        request: requestToken,
        username: TEST_USERNAME,
        password: "wrong",
      }),
    });

    assert.equal(login.status, 401);
    assert.equal(login.headers.get("location"), null);
  });

  it("refuses a wrong username with the same response as a wrong password", async () => {
    const { response } = await beginAuthorization();
    const requestToken = extractRequestToken(await response.text())!;

    const login = await fetch(`${harness.baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: harness.baseUrl,
      },
      body: new URLSearchParams({
        request: requestToken,
        username: "somebody-else",
        password: TEST_PASSWORD,
      }),
    });

    assert.equal(login.status, 401);
    const html = await login.text();
    assert.ok(html.includes("Incorrect username or password"));
  });

  it("refuses a POST with no Origin or Referer", async () => {
    const { response } = await beginAuthorization();
    const requestToken = extractRequestToken(await response.text())!;

    const login = await fetch(`${harness.baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request: requestToken,
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
      }),
    });

    assert.equal(login.status, 403);
  });

  it("refuses a POST from a foreign origin", async () => {
    const { response } = await beginAuthorization();
    const requestToken = extractRequestToken(await response.text())!;

    const login = await fetch(`${harness.baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example.com",
      },
      body: new URLSearchParams({
        request: requestToken,
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
      }),
    });

    assert.equal(login.status, 403);
  });

  it("refuses a forged request token", async () => {
    const login = await fetch(`${harness.baseUrl}/authorize`, {
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
    assert.equal(login.status, 400);
  });

  it("sends the sign-in page with no-store and a frame-blocking policy", async () => {
    const { response } = await beginAuthorization();
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /frame-ancestors 'none'/
    );
  });
});

describe("login throttling", () => {
  it("locks out after repeated failures and reports Retry-After", async () => {
    // Its own harness: the throttle is per IP and every test here shares one.
    const throttled = await startHarness({ throttle: new LoginThrottle(3, 900) });
    try {
      const registration = await registerClaudeClient(throttled.baseUrl);
      const { challenge } = makePkce();
      const url = new URL(`${throttled.baseUrl}/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", registration.body.client_id as string);
      url.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      const requestToken = extractRequestToken(await (await fetch(url)).text())!;

      const attempt = (password: string) =>
        fetch(`${throttled.baseUrl}/authorize`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: throttled.baseUrl,
          },
          body: new URLSearchParams({
            request: requestToken,
            username: TEST_USERNAME,
            password,
          }),
        });

      for (let i = 0; i < 3; i += 1) {
        assert.equal((await attempt("wrong")).status, 401);
      }

      const blocked = await attempt("wrong");
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) > 0);

      // Even the correct password is refused while the lockout stands.
      assert.equal((await attempt(TEST_PASSWORD)).status, 429);
    } finally {
      await throttled.close();
    }
  });
});

describe("the token endpoint's grant checks", () => {
  let requestToken: string;
  let verifier: string;
  let clientId: string;

  beforeEach(async () => {
    const started = await beginAuthorization();
    requestToken = extractRequestToken(await started.response.text())!;
    verifier = started.verifier;
    clientId = started.clientId;
  });

  const exchange = (params: Record<string, string>) =>
    fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        ...params,
      }),
    });

  it("refuses a code redeemed twice", async () => {
    const code = await signIn(requestToken);
    assert.equal((await exchange({ code, code_verifier: verifier })).status, 200);

    const replay = await exchange({ code, code_verifier: verifier });
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");
  });

  it("refuses a wrong PKCE verifier", async () => {
    const code = await signIn(requestToken);
    const response = await exchange({
      code,
      code_verifier: makePkce().verifier,
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "invalid_grant");
  });

  it("refuses the challenge presented as its own verifier", async () => {
    const started = await beginAuthorization();
    const token = extractRequestToken(await started.response.text())!;
    const code = await signIn(token);
    const response = await fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: started.clientId,
        redirect_uri: CLAUDE_CALLBACK,
        code,
        code_verifier: started.challenge,
      }),
    });
    assert.equal(response.status, 400);
  });

  it("refuses a missing verifier", async () => {
    const code = await signIn(requestToken);
    const response = await exchange({ code });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "invalid_request");
  });

  it("refuses a made-up code", async () => {
    const response = await exchange({
      code: "never-issued",
      code_verifier: verifier,
    });
    assert.equal(response.status, 400);
  });

  it("refuses a code redeemed by a different client", async () => {
    const code = await signIn(requestToken);
    const other = await registerClaudeClient(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: other.body.client_id as string,
        redirect_uri: CLAUDE_CALLBACK,
        code,
        code_verifier: verifier,
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "invalid_grant");
  });

  it("refuses a mismatched redirect_uri", async () => {
    const code = await signIn(requestToken);
    const response = await exchange({
      code,
      code_verifier: verifier,
      redirect_uri: "https://claude.com/api/mcp/auth_callback",
    });
    assert.equal(response.status, 400);
  });

  it("refuses a resource other than the one the code was issued for", async () => {
    const code = await signIn(requestToken);
    const response = await exchange({
      code,
      code_verifier: verifier,
      resource: "https://elsewhere.example.com/mcp",
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "invalid_target");
  });
});

describe("login throttling cannot be sidestepped with X-Forwarded-For", () => {
  it("buckets on the address the reverse proxy observed, not one the client picked", async () => {
    // The shape this runs in: the reverse proxy appends the address it saw to
    // whatever X-Forwarded-For the client sent, so the header arriving here is
    // "<client-supplied>, <real client>". With `trust proxy: true` Express would
    // take the leftmost entry — the forged one — and every attempt would land in
    // its own throttle bucket, leaving the login effectively unthrottled and the
    // fail2ban log line naming an address of the attacker's choosing.
    const throttled = await startHarness({ throttle: new LoginThrottle(3, 900) });
    try {
      const registration = await registerClaudeClient(throttled.baseUrl);
      const { challenge } = makePkce();
      const url = new URL(`${throttled.baseUrl}/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", registration.body.client_id as string);
      url.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      const requestToken = extractRequestToken(await (await fetch(url)).text())!;

      const attempt = (forged: string) =>
        fetch(`${throttled.baseUrl}/authorize`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: throttled.baseUrl,
            // A different forged address every time, with the real one appended.
            "X-Forwarded-For": `${forged}, 203.0.113.7`,
          },
          body: new URLSearchParams({
            request: requestToken,
            username: TEST_USERNAME,
            password: "wrong",
          }),
        });

      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await attempt(`9.9.9.${i}`)).status);
      }

      assert.deepEqual(
        statuses,
        [401, 401, 401, 429, 429],
        "rotating the forged X-Forwarded-For entry must not reset the throttle"
      );
    } finally {
      await throttled.close();
    }
  });
});

describe("consent page CSP", () => {
  it("allows a form redirect to the registered callback", async () => {
  // form-action must not be plain 'self'. Submitting the consent form redirects to
  // the client's redirect_uri, and Chrome enforces form-action against the redirect
  // target too — 'self' alone blocks the hand-off to claude.ai and the flow dies on
  // its last step with nothing but a console error.
  const harness = await startHarness();
  try {
    const registration = await registerClaudeClient(harness.baseUrl);
    const clientId = registration.body.client_id as string;
    const { challenge } = makePkce();
    const url = new URL(`${harness.baseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    const res = await fetch(url, { redirect: "manual" });
    const csp = res.headers.get("content-security-policy") ?? "";
    const formAction = /form-action ([^;]+)/.exec(csp)?.[1] ?? "";

    assert.match(formAction, /'self'/, "same-origin submission must stay allowed");
    assert.match(
      formAction,
      new RegExp(new URL(CLAUDE_CALLBACK).origin.replace(/[.]/g, "\.")),
      "the registered callback's origin must be allowed, or Chrome blocks the redirect"
    );
    assert.ok(!/form-action 'self';/.test(csp), "must not be bare 'self'");
  } finally {
    await harness.close();
  }
});
});
