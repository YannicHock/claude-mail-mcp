/**
 * Reading an IMAP ENVELOPE into the strings the mail tools answer with, pure.
 *
 * Shared by `ImapClient`'s list tools and by code outside it that fetches
 * envelopes of its own (threads, v0.8 #27), so one message reads the same in
 * every tool: the same `date` (the Date header, F4) and the same address text.
 */

/** A date as ISO 8601 UTC, or null when it is missing or not a date. */
export function isoDate(value: Date | string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** One envelope address list as `Name <address>, address`, or null when empty. */
export function addrText(
  addr:
    | { name?: string; address?: string }[]
    | { name?: string; address?: string }
    | undefined
): string | null {
  if (!addr) return null;
  const list = Array.isArray(addr) ? addr : [addr];
  return (
    list
      .map((a) => {
        const name = a?.name?.trim();
        const email = a?.address?.trim();
        if (name && email) return `${name} <${email}>`;
        return email ?? name ?? null;
      })
      .filter((v): v is string => Boolean(v))
      .join(", ") || null
  );
}
