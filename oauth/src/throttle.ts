/**
 * Login attempt throttling.
 *
 * This is the second line, not the first: the reverse proxy rate-limits and a
 * fail2ban jail bans on the log lines this service emits. It exists because both
 * of those are deployment configuration that can be missing or misconfigured, and
 * the thing behind this login is plaintext credentials for several real mailboxes.
 *
 * The window is per client IP and counts failures only, so an operator who signs
 * in correctly is never throttled. Successful authentication clears the counter.
 */

/** Failures allowed within the window before further attempts are refused. */
export const MAX_FAILURES = 5;

/** How long failures are remembered, and how long a lockout lasts. */
export const WINDOW_SECONDS = 15 * 60;

interface Attempts {
  failures: number[];
}

export class LoginThrottle {
  readonly #byIp = new Map<string, Attempts>();
  readonly #max: number;
  readonly #windowMs: number;

  constructor(max: number = MAX_FAILURES, windowSeconds: number = WINDOW_SECONDS) {
    this.#max = max;
    this.#windowMs = windowSeconds * 1000;
  }

  /** True when this IP has spent its allowance and must be refused. */
  isBlocked(ip: string, now: number = Date.now()): boolean {
    return this.#live(ip, now).length >= this.#max;
  }

  /** Seconds until the oldest failure ages out, for a Retry-After header. */
  retryAfter(ip: string, now: number = Date.now()): number {
    const live = this.#live(ip, now);
    if (live.length < this.#max) return 0;
    const oldest = live[0];
    return Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1000));
  }

  /** Record a failed attempt. Returns the number of failures now in the window. */
  recordFailure(ip: string, now: number = Date.now()): number {
    const live = this.#live(ip, now);
    live.push(now);
    this.#byIp.set(ip, { failures: live });
    return live.length;
  }

  /** Clear an IP's history after a successful sign-in. */
  recordSuccess(ip: string): void {
    this.#byIp.delete(ip);
  }

  /** Drop IPs whose failures have all aged out. */
  sweep(now: number = Date.now()): void {
    for (const ip of [...this.#byIp.keys()]) {
      if (this.#live(ip, now).length === 0) this.#byIp.delete(ip);
    }
  }

  /** Number of IPs currently tracked. Test and diagnostics only. */
  get size(): number {
    return this.#byIp.size;
  }

  #live(ip: string, now: number): number[] {
    const entry = this.#byIp.get(ip);
    if (!entry) return [];
    const cutoff = now - this.#windowMs;
    const live = entry.failures.filter((at) => at > cutoff);
    if (live.length === 0) {
      this.#byIp.delete(ip);
      return [];
    }
    entry.failures = live;
    return live;
  }
}
