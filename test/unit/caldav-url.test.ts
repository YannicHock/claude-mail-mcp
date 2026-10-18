/**
 * src/caldav-url.ts: which calendar URLs are one collection, and where an
 * object of a given name lives in one — what `move_event` (#212) resolves
 * its destination with (code-health review of PR #231).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CALDAV_HTTP_MESSAGE,
  CALDAV_UNRESOLVED_MESSAGE,
  caldavUrlProblem,
  guardedCaldavFetch,
  objectName,
  objectUrl,
  sameCollection,
  withSlash,
} from "../../src/caldav-url.js";
import type { MailTlsDeps } from "../../src/mail-tls.js";

const CAL = "https://dav.example/u/cal/";

describe("sameCollection", () => {
  it("is one collection with or without trailing slashes", () => {
    assert.equal(sameCollection(CAL, "https://dav.example/u/cal"), true);
    assert.equal(sameCollection("https://dav.example/u/cal//", CAL), true);
  });

  it("tells two collections apart, a parent included", () => {
    assert.equal(sameCollection(CAL, "https://dav.example/u/other/"), false);
    assert.equal(sameCollection(CAL, "https://dav.example/u/"), false);
  });
});

describe("withSlash", () => {
  it("adds one trailing slash, and only where there is none", () => {
    assert.equal(withSlash("https://dav.example/u/cal"), CAL);
    assert.equal(withSlash(CAL), CAL);
  });
});

describe("objectName", () => {
  it("is the last path segment, as the server encoded it", () => {
    assert.equal(objectName(`${CAL}event.ics`), "event.ics");
    assert.equal(objectName(`${CAL}my%20event.ics`), "my%20event.ics");
    assert.equal(objectName(`${CAL}no-extension`), "no-extension");
  });
});

describe("objectUrl", () => {
  it("puts the object inside the collection, with or without its trailing slash", () => {
    assert.equal(objectUrl(CAL, "event.ics"), `${CAL}event.ics`);
    assert.equal(objectUrl("https://dav.example/u/cal", "event.ics"), `${CAL}event.ics`);
  });

  it("keeps an encoded name encoded, not twice", () => {
    assert.equal(objectUrl(CAL, "my%20event.ics"), `${CAL}my%20event.ics`);
  });

  it("reads a name with a colon as a file name, not as a URL scheme (review of PR #231)", () => {
    // new URL("event:1.ics", base) is the absolute URL "event:1.ics".
    assert.equal(objectUrl(CAL, "event:1.ics"), `${CAL}event:1.ics`);
    assert.equal(objectUrl(CAL, "mailto:x"), `${CAL}mailto:x`);
  });

  it("never leaves the collection for a name that looks like a path", () => {
    assert.equal(objectUrl(CAL, "a%2Fb.ics"), `${CAL}a%2Fb.ics`);
  });
});

// #247: which CalDAV URLs the account's Basic credentials may be sent to.
// The resolver is injected throughout: nothing here reaches a DNS server.

/** A resolver that answers from a table, and records every name it was asked. */
function resolver(table: Record<string, string[]>): MailTlsDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async resolveAddresses(hostname) {
      asked.push(hostname);
      const addresses = table[hostname];
      if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
      return addresses;
    },
  };
}

describe("caldavUrlProblem", () => {
  it("passes an https:// URL wherever it points, without a lookup", async () => {
    const dns = resolver({});
    for (const url of ["https://cloud.example.com/dav/", "https://8.8.8.8/", "https://radicale:5232/"]) {
      assert.equal(await caldavUrlProblem(url, dns), null, url);
    }
    assert.deepEqual(dns.asked, []);
  });

  it("passes http:// to a loopback or private literal, without a lookup", async () => {
    const dns = resolver({});
    for (const url of [
      "http://127.0.0.1:5232/",
      "http://127.0.0.1.:5232/",
      "http://[::1]:5232/dav/",
      "http://192.168.1.20/radicale/",
      "http://10.0.0.5/",
    ]) {
      assert.equal(await caldavUrlProblem(url, dns), null, url);
    }
    assert.deepEqual(dns.asked, []);
  });

  it("passes http:// to a local-form name that resolves only privately", async () => {
    const dns = resolver({
      radicale: ["172.18.0.3"],
      "nas.home.arpa": ["192.168.1.9", "fd00::9"],
      localhost: ["127.0.0.1", "::1"],
    });
    assert.equal(await caldavUrlProblem("http://radicale:5232/", dns), null);
    assert.equal(await caldavUrlProblem("http://nas.home.arpa/dav/", dns), null);
    assert.equal(await caldavUrlProblem("http://localhost:5232/", dns), null);
  });

  it("refuses http:// to a public host, saying to use https://, and never resolves a dotted public name", async () => {
    const dns = resolver({});
    for (const url of ["http://cloud.example.com/", "http://8.8.8.8/dav/", "HTTP://Cloud.Example.com/"]) {
      assert.equal(await caldavUrlProblem(url, dns), CALDAV_HTTP_MESSAGE, url);
    }
    assert.match(CALDAV_HTTP_MESSAGE, /https:\/\//);
    assert.deepEqual(dns.asked, []);
  });

  it("refuses http:// to a local-form name that resolves publicly, even partly", async () => {
    const dns = resolver({ mail: ["203.0.113.5"], mixed: ["192.168.1.2", "203.0.113.5"] });
    assert.equal(await caldavUrlProblem("http://mail/dav/", dns), CALDAV_HTTP_MESSAGE);
    assert.equal(await caldavUrlProblem("http://mixed/dav/", dns), CALDAV_HTTP_MESSAGE);
  });

  it("says so when a local-form name could not be resolved, rather than calling it public", async () => {
    const dns = resolver({ empty: [] });
    assert.equal(await caldavUrlProblem("http://gone.local/dav/", dns), CALDAV_UNRESOLVED_MESSAGE);
    assert.equal(await caldavUrlProblem("http://radicale:5232/", dns), CALDAV_UNRESOLVED_MESSAGE);
    assert.equal(await caldavUrlProblem("http://empty/", dns), CALDAV_UNRESOLVED_MESSAGE);
  });

  it("refuses http:// to a name written with a trailing dot, which resolves without the search domain", async () => {
    const dns = resolver({ localhost: ["127.0.0.1"], radicale: ["172.18.0.3"] });
    assert.equal(await caldavUrlProblem("http://localhost.:5232/", dns), CALDAV_HTTP_MESSAGE);
    assert.equal(await caldavUrlProblem("http://radicale./", dns), CALDAV_HTTP_MESSAGE);
    assert.equal(await caldavUrlProblem("https://cloud.example.com./", dns), null);
  });

  it("refuses another scheme the same way; a string that is no URL is not its to judge", async () => {
    assert.equal(await caldavUrlProblem("ftp://127.0.0.1/", resolver({})), CALDAV_HTTP_MESSAGE);
    assert.equal(await caldavUrlProblem("not a url", resolver({})), null);
  });
});

describe("guardedCaldavFetch", () => {
  /** A fetch that records what it was asked and answers 200. */
  function recordingFetch(): { fetch: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const f = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response("ok");
    }) as typeof fetch;
    return { fetch: f, urls };
  }

  it("hands an allowed request on unchanged", async () => {
    const base = recordingFetch();
    const guarded = guardedCaldavFetch(base.fetch, resolver({}));
    assert.equal((await guarded("https://dav.example/cal/")).status, 200);
    assert.equal((await guarded(new URL("http://127.0.0.1:5232/"))).status, 200);
    assert.equal((await guarded(new Request("https://dav.example/x"))).status, 200);
    assert.deepEqual(base.urls, ["https://dav.example/cal/", "http://127.0.0.1:5232/", "https://dav.example/x"]);
  });

  it("refuses a request to http:// on a host that is not local before anything is sent", async () => {
    const base = recordingFetch();
    const guarded = guardedCaldavFetch(base.fetch, resolver({}));
    await assert.rejects(guarded("http://public.example/remote.php/dav/"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /http:\/\/public\.example/);
      assert.ok(err.message.endsWith(CALDAV_HTTP_MESSAGE), err.message);
      return true;
    });
    assert.deepEqual(base.urls, []);
  });
});
