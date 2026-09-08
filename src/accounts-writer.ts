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
    await rename(temp, path);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}
