/**
 * Escaping for text interpolated into server-rendered HTML.
 *
 * Seven lines, and until #126 there were two of them: one in
 * `src/settings-pages.ts` and one in `oauth/src/login.ts`, character-identical,
 * with nothing comparing them. Both packages render every operator-facing page
 * by string concatenation — no template engine, no DOM, no build step, which is
 * the rule docs/HARDENING.md sets out — so this function is the only thing
 * standing between a mailbox label and an injected tag. That is not a rule to
 * keep two copies of.
 *
 * The five replacements are deliberately the full set including `'` and `"`:
 * these pages interpolate into attribute values (`value="…"`) as well as into
 * element content, and an escaper that only handled `&<>` would be correct for
 * one and wrong for the other.
 */

/** Escape text for interpolation into HTML element content or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
