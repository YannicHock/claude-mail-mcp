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
 * It lives in a file of its own, importing nothing (#214). The pure calendar
 * modules — src/ical-edit.ts, src/ical-zones.ts, src/ical-expand.ts — throw
 * it, and taking it from tool-errors.ts pulled shared/credential-failure and
 * the client pool's types into every one of them. tool-errors.ts re-exports
 * it, so `instanceof` holds whichever path a caller imported it by.
 */
export class ToolRefusal extends Error {
  override readonly name = "ToolRefusal";
}
