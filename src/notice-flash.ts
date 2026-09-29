/**
 * A notice that has to survive a redirect (#173).
 *
 * A save that stores the mailbox but finds its CalDAV block broken has one
 * thing to say, and the redirect that follows every save carries nothing. The
 * page used to be rendered straight out of the POST instead, so a reload
 * re-submitted the form: a second 25-second probe and then a 409 on create, a
 * 409 and the edit URL left in the address bar on an edit.
 *
 * So the sentence is kept here, and the 303 carries only a token. The sentence
 * itself never goes into the URL: it carries the CalDAV server's own words
 * about what failed, and a list page that painted whatever a query said would
 * let any link put text of its choosing on the one page that holds mail
 * passwords. A token this map did not issue reads as no notice at all.
 *
 * Not consumed on read. A reload inside the lifetime shows the same page, which
 * is what "a reload shows the list, not a resubmission" means; after it the
 * list is shown plain. In memory and bounded, because the worst a lost entry
 * costs is one sentence the operator was already shown once.
 */

import { randomBytes } from "node:crypto";

export const NOTICE_FLASH_TTL_MS = 10 * 60 * 1000;
export const NOTICE_FLASH_MAX = 32;

export interface NoticeFlash {
  /** Keep `notice`, and return the token a redirect carries to it. */
  put(notice: string): string;
  /** The notice behind `token`, or null — for anything that is not a live token. */
  get(token: unknown): string | null;
}

export function createNoticeFlash(
  opts: { now?: () => number; ttlMs?: number; max?: number } = {}
): NoticeFlash {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? NOTICE_FLASH_TTL_MS;
  const max = opts.max ?? NOTICE_FLASH_MAX;
  // Insertion order is age order, which is what eviction walks.
  const entries = new Map<string, { notice: string; expires: number }>();

  return {
    put(notice) {
      const token = randomBytes(16).toString("base64url");
      entries.set(token, { notice, expires: now() + ttlMs });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return token;
    },
    get(token) {
      if (typeof token !== "string") return null;
      const entry = entries.get(token);
      if (entry === undefined) return null;
      if (now() >= entry.expires) {
        entries.delete(token);
        return null;
      }
      return entry.notice;
    },
  };
}
