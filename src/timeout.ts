/**
 * One deadline helper, for every module in the connector that needs one.
 *
 * It lived twice — once in `probe.ts` and once in `autoconfig.ts`, written
 * weeks apart, the second a strict subset of the first with a doc comment
 * saying "As in `probe.ts`". Both now import this.
 */

/**
 * Race `promise` against a `ms`-millisecond timer. The timer is always
 * cleared, win or lose, so a fast-resolving promise never leaves a dangling
 * handle behind.
 *
 * `label`, when given, names the loser in the rejection message — `"IMAP timed
 * out after 10000ms"` rather than the bare `"timed out after 10000ms"` — which
 * is what makes a report of several concurrent probes readable.
 *
 * `onTimeout`, when given, runs synchronously the moment the timer fires —
 * before the rejection — so a caller holding a client/socket tied to `promise`
 * can force it closed immediately. **Racing a promise never cancels it:** on
 * its own this function only stops *watching* the loser, it does not touch
 * whatever is still running underneath. Whether that matters is the caller's
 * to know: `probe.ts` holds sockets it must tear down and passes `onTimeout`
 * for exactly that (see probeImap()/probeCalDav()), while `autoconfig.ts`
 * enforces its own deadline down in the transport and uses this only to stop
 * waiting.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label?: string,
  onTimeout?: () => void
): Promise<T> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(label ? `${label} timed out after ${ms}ms` : `timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
