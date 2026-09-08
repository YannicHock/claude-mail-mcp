#!/usr/bin/env node
/**
 * Generate the `AUTH_PASSWORD_HASH` value.
 *
 * Reads the password from stdin rather than taking it as an argument, so it does
 * not end up in the shell history or in the process list of a shared machine.
 *
 *   npm run hash-password              # prompts, reads from the terminal
 *   echo 'secret' | npm run hash-password
 *
 * In the deployed container, note the --entrypoint override: the image's
 * ENTRYPOINT is `node dist/index.js`, so a trailing `node dist/hash-password.js`
 * would be appended to it as arguments and start the server instead.
 *
 *   docker compose run --rm --entrypoint node mail-oauth dist/hash-password.js
 */

import { createInterface } from "node:readline";

import { DEFAULT_PARAMS, hashPassword } from "./passwords.js";

/**
 * Below this, a hash of any cost is the wrong control. The service is reachable
 * from the internet and stands in front of plaintext mailbox credentials.
 */
const MIN_LENGTH = 12;

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("Password: ");
  }
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return "";
}

async function main(): Promise<void> {
  const password = (await readPassword()).replace(/\r$/, "");

  if (password.length === 0) {
    process.stderr.write("No password given.\n");
    process.exit(1);
  }
  if (password.length < MIN_LENGTH) {
    process.stderr.write(
      `Password must be at least ${MIN_LENGTH} characters. This is the only thing ` +
        `between the public internet and your mailboxes.\n`
    );
    process.exit(1);
  }

  const hash = await hashPassword(password, DEFAULT_PARAMS);

  // The hash alone on stdout, so it can be redirected straight into a secret
  // file; everything explanatory goes to stderr.
  process.stderr.write("\nAdd this to your secret file or environment:\n\n");
  process.stdout.write(`${hash}\n`);
  process.stderr.write(
    "\nTo write it straight into the secret file, without the password reaching\n" +
      "your shell history:\n\n" +
      "  read -rs PW && printf '%s\\n' \"$PW\" | docker compose run --rm -T \\\n" +
      "    --entrypoint node mail-oauth dist/hash-password.js \\\n" +
      "    > secrets/auth_password_hash.txt; unset PW\n\n"
  );
}

await main();
