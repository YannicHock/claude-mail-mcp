/**
 * How many reverse-proxy hops to trust, read from `TRUST_PROXY`.
 *
 * **Never a boolean.** `trust proxy: true` trusts the entire X-Forwarded-For
 * chain and takes its leftmost entry, and a reverse proxy only *appends* the
 * address it saw — so the leftmost entry is whatever the client wrote. In the
 * OAuth layer that is an address a client could pick for itself to sidestep the
 * login throttle one forged value at a time. In the connector there is no
 * throttle to sidestep, but `req.ip` is what its two rejection log lines carry
 * (`rejected unauthenticated MCP request` in src/app.ts, `rejected settings
 * request` in src/settings-assertion.ts), and the obvious use for those is a
 * fail2ban jail — which, reading a client-chosen field, bans whatever the
 * attacker names. A hop count makes Express skip exactly the proxies that are
 * really there.
 *
 * The default, 1, matches a single reverse proxy terminating TLS — the shape
 * every documented deployment has, including the one where the OAuth layer sits
 * in between, since its proxy forwards `X-Forwarded-For` unchanged rather than
 * appending to it (see `HOP_BY_HOP` in oauth/src/proxy.ts). Raise it only if
 * there is genuinely another trusted hop in front, such as a CDN: setting it
 * higher than the real chain reintroduces the same forgery. Use 0 when nothing
 * proxies the process, which makes `req.ip` the socket address.
 *
 * The two services still read *separate* environments — docker-compose.yml
 * gives them `.env` and `.env.oauth`, and the pm2/systemd recipes give each its
 * own env file — so a deployment that puts a different number of proxies in
 * front of each can still say so. What is shared is the rule, not the value.
 *
 * This is the pair #126 is named after: identical in both packages down to the
 * error string, arriving late in `e10a4ae` / `5a7ce79` with no comment, no
 * mirrored module and no drift test, while three larger duplicates next to it
 * had one. An unpinned security rule duplicated verbatim is the part that
 * bites, so it is the first fragment this file collects.
 *
 * `fail` exists because the two packages report a bad configuration
 * differently: the connector throws a plain `Error` at import time, the OAuth
 * layer throws its own `ConfigError`, which its bootstrap catches and turns
 * into a readable startup message. The *message* is shared; the class is the
 * caller's.
 */
export function trustProxyHops(
  env: Record<string, string | undefined> = process.env,
  fail: (message: string) => Error = (message) => new Error(message)
): number {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw fail(
      `TRUST_PROXY must be a non-negative integer — the number of reverse-proxy ` +
        `hops in front of this service — got ${raw}. Use 0 when nothing proxies it.`
    );
  }
  return parsed;
}
