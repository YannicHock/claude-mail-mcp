/**
 * An answer a tool gives on purpose, not a mailbox that failed.
 *
 * A calendar write refused because the event changed since it was read, or
 * because it is one occurrence of a series, is the tool working as designed —
 * a model retrying after a conflict is exactly the behaviour asked for. Logging
 * it at `warn` beside real server failures would teach an operator to ignore
 * the one line #146 exists to put in front of them. So `reportingFailures()`
 * in tool-errors.ts rethrows this unchanged: no log line, and the message is
 * not prefixed.
 *
 * Every refusal ends by saying what was not done ("Nothing was changed.",
 * "Nothing was deleted."), so a model reading it never has to guess whether
 * half of the call went through.
 *
 * It lives in a file of its own, importing nothing (#214). The pure modules
 * that decide what a write may do throw it — src/ical-edit.ts and the
 * writers beside it (src/ical-occurrence-edit.ts, src/ical-series-shift.ts,
 * src/ical-attendees.ts, src/ical-input.ts, src/ical-build.ts), and
 * src/caldav-etag.ts for a write's guards — as does src/caldav-client.ts,
 * and taking it from tool-errors.ts pulled shared/credential-failure and the
 * client pool's types in with them. The reader refuses nothing: src/ical-expand.ts
 * reports an object it cannot read in `skipped` instead, and src/ical-zones.ts
 * throws `UnreadableTimezone`, which a writer turns into a refusal
 * (`withReadableZones` in src/ical-edit.ts). tool-errors.ts re-exports it, so
 * `instanceof` holds whichever path a caller imported it by.
 */
export class ToolRefusal extends Error {
  override readonly name = "ToolRefusal";
}
