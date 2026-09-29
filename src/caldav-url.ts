/**
 * The URL arithmetic of CalDAV collections and the objects in them, with no
 * server behind it: which two calendar URLs are one collection, and where an
 * object of a given file name lives in one. Moved out of
 * src/caldav-client.ts (code-health review of PR #231), where `move_event`
 * (#212) had grown them, so they can be tested on their own.
 */

/** True when two calendar URLs name one collection: equal but for trailing slashes. */
export function sameCollection(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** `url` with one trailing slash, so a file name resolved against it lands inside the collection. */
export function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** The last path segment of an object's URL, as the server encoded it: the file name a move keeps. */
export function objectName(url: string): string {
  return new URL(url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * The URL of the object called `name` — a path segment as {@link objectName}
 * gives it — inside the collection at `collection`, with or without its
 * trailing slash.
 *
 * The name is resolved as `./name`: on its own, `new URL("event:1.ics",
 * base)` is the absolute URL `event:1.ics`, scheme `event:`, and a MOVE's
 * Destination or the fallback's PUT went there instead of into the
 * calendar (review of PR #231). It is not encoded again: a segment from
 * {@link objectName} already is, and `%20` must stay `%20`.
 */
export function objectUrl(collection: string, name: string): string {
  return new URL(`./${name}`, withSlash(collection)).href;
}
