/**
 * Writing accounts.json.
 *
 * This is the only code in the repository that writes mailbox credentials, and the
 * file it writes is read by a process that hot-reloads it. Two properties matter
 * more than anything else here:
 *
 * 1. A reader never sees a partial file. The write goes to a sibling temp file and
 *    is renamed into place, which is atomic within a directory. The temp file is
 *    created 0600, so the credentials are never briefly world-readable.
 * 2. The connector never writes a file it would refuse to read. The serialised text
 *    is handed back to the same parser the loader uses, and only a clean parse is
 *    allowed to reach the rename.
 */

import { randomUUID } from "node:crypto";
import { open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type AccountsFile, parseAccountsFile } from "./accounts.js";

/** Identifies the on-disk version a form was rendered from. */
export async function readStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}-${info.mtimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
}

export class StaleStampError extends Error {
  constructor() {
    super(
      "accounts.json changed on disk since this form was opened. " +
        "Review the current contents and submit again."
    );
    this.name = "StaleStampError";
  }
}

export async function writeAccountsFile(path: string, file: AccountsFile): Promise<void> {
  const serialised = `${JSON.stringify(file, null, 2)}\n`;

  // The round trip. If this throws, nothing has touched the real file yet.
  parseAccountsFile(serialised);

  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, serialised, { encoding: "utf8", mode: 0o600 });
    // fsync before rename: a crash between the two would otherwise leave a file
    // that exists but has no contents, and mailbox credentials are not something
    // to lose to a power cut.
    const handle = await open(temp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, path);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

/**
 * The waits between rename attempts, in milliseconds (#219).
 *
 * Windows refuses to rename over a file another handle holds open, and answers
 * EPERM, EACCES or EBUSY rather than waiting. The likeliest holder is the
 * store's own reload of the previous write, a readFile of a few kilobytes that
 * lets go within milliseconds; an antivirus scan of the fresh file is the next
 * likeliest and takes somewhat longer. graceful-fs retries the same three codes
 * for up to a minute, which suits a build tool and not a form submit. Five
 * doubling waits come to 310 ms: past anything our own reader holds, long
 * enough for a scanner's usual look, and short enough that a save that was
 * never going to work still answers inside a third of a second.
 *
 * All platforms, not only win32. On Linux these codes from rename mean a real
 * permission problem, which the retries cannot fix and only delay by those
 * 310 ms. One code path also means CI exercises the one a Windows user runs.
 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160];

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** rename(), retried over {@link RENAME_RETRY_DELAYS_MS} while the target is busy. */
export async function renameWithRetry(
  from: string,
  to: string,
  attempt: (from: string, to: string) => Promise<void> = rename
): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      await attempt(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (tries >= RENAME_RETRY_DELAYS_MS.length || !code || !RETRYABLE_RENAME_CODES.has(code)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[tries]));
    }
  }
}
