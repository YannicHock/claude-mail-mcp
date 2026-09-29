/**
 * src/caldav-url.ts: which calendar URLs are one collection, and where an
 * object of a given name lives in one — what `move_event` (#212) resolves
 * its destination with (code-health review of PR #231).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { objectName, objectUrl, sameCollection, withSlash } from "../../src/caldav-url.js";

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
