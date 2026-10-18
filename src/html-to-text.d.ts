/**
 * The part of `html-to-text` this connector uses. Version 10 ships no types,
 * and `@types/html-to-text` stops at 9, so the one call is declared here. The
 * package is pinned to the version mailparser depends on, so `get_message`'s
 * `bodyText` reads the same whether mailparser or the connector made it.
 */
declare module "html-to-text" {
  export function convert(html: string, options?: Record<string, unknown>): string;
}
