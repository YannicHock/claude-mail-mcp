/**
 * Whose fault an error that reached an app's last-resort handler is (#219).
 *
 * Both services end their Express chain with one error handler, and each used to
 * read every error one way. The connector's answered all of them as a malformed
 * body, so a settings save that failed writing accounts.json came back `400` and
 * was logged as the client's mistake. The OAuth layer's answered all of them
 * `500`, so an oversized form on one of its 64 KB parsers was logged at `error`
 * as the server's. The rule is the same in both and lives here; what each
 * handler answers and logs stays its own.
 */

/**
 * The 4xx an error carries, or `undefined` when it is the server's failure.
 *
 * body-parser and raw-body set `.status` (and `.statusCode`) on what they refuse:
 * 400 for a body that does not parse, 413 for one over the limit, 415 for a
 * charset they cannot read. Anything without one, or with a 5xx, is not the
 * client's doing.
 */
export function clientErrorStatus(err: unknown): number | undefined {
  const candidate =
    (err as { status?: unknown } | null)?.status ??
    (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof candidate === "number" && candidate >= 400 && candidate < 500
    ? candidate
    : undefined;
}
