/**
 * What an MCP tool says, and what it logs, when the mailbox behind it fails.
 *
 * This is #146's acceptance, held offline. The deployment that filed it added
 * a Gmail mailbox whose password Google refused, and every later `list_folders`
 * answered `Command failed` — imapflow's generic wording — while the log said
 * nothing at all. Two things had to become true: the answer names the account
 * and the classified reason, and exactly one `warn` line carries the same pair.
 *
 * Both directions are asserted, because a classifier that collapses them is
 * worse than none: a rejecting server must read as a rejection, and a host
 * that is not there must still read as connectivity — in the tool answer and
 * in the log.
 *
 * The tools are registered against a stand-in `McpServer` that only records
 * what was registered. That is enough: the handler under test is the closure
 * `registerMailTools` builds, and calling it directly is what the SDK does
 * once a client asks for the tool.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountsStore, type Account } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { registerMailTools } from "../../src/tools-mail.js";
import { registerCalendarTools } from "../../src/tools-calendar.js";
import { CREDENTIAL_REJECTION_MESSAGE, MAX_MESSAGE_LENGTH } from "../../shared/credential-failure.js";
import type { LogLevel } from "../../shared/log.js";
import { makeTmpDir, cleanupTmpDir, makeAccount, makeAccountsFile } from "../helpers/fixtures.js";
import { startRejectingImapServer } from "../helpers/fake-imap.js";
import { startFakeCalDavServer } from "../helpers/fake-caldav.js";

/** The password every fixture below uses, so no assertion can echo it by luck. */
const PASSWORD = "hunter2-very-secret";

/**
 * A closed port on loopback. Port 1 is privileged and nothing listens, so the
 * connection is refused immediately — the "genuinely unreachable host" case,
 * without the multi-second wait a blackholed address would cost.
 */
const CLOSED_PORT = 1;

interface LogLine {
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Register the real tool registries against a recording stand-in, and hand
 * back the handlers by name plus every line the pool's logger was given.
 */
async function withTools<T>(
  account: Account,
  run: (ctx: { call: (tool: string, args?: Record<string, unknown>) => Promise<unknown>; lines: LogLine[] }) => Promise<T>
): Promise<T> {
  const dir = await makeTmpDir();
  try {
    const file = await makeAccountsFile(dir, [account]);
    const store = new AccountsStore(file);
    await store.reload();

    const lines: LogLine[] = [];
    const pool = new ClientPool(store, (level, message, extra) => {
      lines.push({ level, message, extra });
    });

    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;

    registerMailTools(server, pool, store);
    registerCalendarTools(server, pool);

    try {
      return await run({
        call: (tool, args = {}) => {
          const handler = handlers.get(tool);
          assert.ok(handler, `tool ${tool} was never registered`);
          return handler(args);
        },
        lines,
      });
    } finally {
      await pool.closeAll().catch(() => {});
    }
  } finally {
    await cleanupTmpDir(dir);
  }
}

/** The message of whatever `call` rejected with. Fails if it resolved. */
async function failureMessage(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail("the tool call was expected to fail");
}

/** The one warn line, asserting there is exactly one. */
function onlyWarning(lines: LogLine[]): LogLine {
  const warnings = lines.filter((line) => line.level === "warn");
  assert.equal(
    warnings.length,
    1,
    `expected exactly one warn line, got ${warnings.length}: ${JSON.stringify(warnings)}`
  );
  return warnings[0] as LogLine;
}

test("a rejected password names the account and the reason, in the answer and in one warn line", async () => {
  const server = await startRejectingImapServer();
  try {
    await withTools(
      makeAccount({
        id: "gmail",
        default: true,
        imap: { host: "127.0.0.1", port: server.port, user: "alice@example.invalid", pass: PASSWORD, tls: false },
      }),
      async ({ call, lines }) => {
        const message = await failureMessage(call("list_folders", { account: "gmail" }));

        // The answer. `Command failed` was what this said before #146.
        assert.match(message, /gmail/);
        assert.ok(
          message.includes(CREDENTIAL_REJECTION_MESSAGE),
          `expected the classified reason, got: ${message}`
        );
        assert.ok(!message.includes(PASSWORD));

        // The log. Exactly one line, carrying the same pair.
        const warning = onlyWarning(lines);
        assert.equal(warning.extra?.account, "gmail");
        assert.equal(warning.extra?.reason, CREDENTIAL_REJECTION_MESSAGE);
        assert.equal(warning.extra?.credential_rejection, true);
        assert.equal(warning.extra?.tool, "list_folders");
        assert.ok(!JSON.stringify(warning).includes(PASSWORD));
      }
    );
  } finally {
    await server.close();
  }
});

test("an unreachable host still reads as connectivity, in the answer and in the log", async () => {
  // The other direction, and the reason the classification is worth having at
  // all. Telling an operator their password was rejected by a server they
  // never reached would be a worse bug than the one #146 replaced.
  await withTools(
    makeAccount({
      id: "gmail",
      default: true,
      imap: { host: "127.0.0.1", port: CLOSED_PORT, user: "alice@example.invalid", pass: PASSWORD, tls: false },
    }),
    async ({ call, lines }) => {
      const message = await failureMessage(call("list_folders", { account: "gmail" }));

      assert.match(message, /gmail/);
      assert.ok(
        !message.includes(CREDENTIAL_REJECTION_MESSAGE),
        `a refused connection must not read as a rejection, got: ${message}`
      );
      assert.match(message, /ECONNREFUSED/);

      const warning = onlyWarning(lines);
      assert.equal(warning.extra?.account, "gmail");
      assert.equal(warning.extra?.credential_rejection, false);
      assert.notEqual(warning.extra?.reason, CREDENTIAL_REJECTION_MESSAGE);
      assert.match(String(warning.extra?.reason), /ECONNREFUSED/);
      assert.ok(!JSON.stringify(warning).includes(PASSWORD));
    }
  );
});

test("the default account is named by its id, not by \"(default)\"", async () => {
  // A multi-account instance has to say *which* mailbox, and the tool call
  // that omits `account` is the one where that is least obvious.
  await withTools(
    makeAccount({
      id: "privat",
      default: true,
      imap: { host: "127.0.0.1", port: CLOSED_PORT, user: "alice@example.invalid", pass: PASSWORD, tls: false },
    }),
    async ({ call, lines }) => {
      const message = await failureMessage(call("list_folders"));
      assert.match(message, /privat/);
      assert.equal(onlyWarning(lines).extra?.account, "privat");
    }
  );
});

test("the reported reason is bounded, however much the server said", async () => {
  await withTools(
    makeAccount({
      id: "gmail",
      default: true,
      imap: { host: "127.0.0.1", port: CLOSED_PORT, user: "alice@example.invalid", pass: PASSWORD, tls: false },
    }),
    async ({ call, lines }) => {
      await failureMessage(call("list_messages", { mailbox: "INBOX", account: "gmail" }));
      const reason = String(onlyWarning(lines).extra?.reason);
      assert.ok(reason.length <= MAX_MESSAGE_LENGTH + 1, `unbounded reason: ${reason.length} chars`);
    }
  );
});

test("an unknown account id is not dressed up as a connection failure", async () => {
  // NoSuchAccountError already names the account and lists the configured
  // ids. Wrapping it would say less, and logging it as a mailbox failure
  // would blame a mailbox that was never contacted.
  await withTools(
    makeAccount({ id: "gmail", default: true }),
    async ({ call, lines }) => {
      const message = await failureMessage(call("list_folders", { account: "nope" }));
      assert.match(message, /nope/);
      assert.ok(!message.includes(CREDENTIAL_REJECTION_MESSAGE));
      assert.equal(lines.filter((line) => line.level === "warn").length, 0);
    }
  );
});

test("a calendar tool reports and logs the same way the mail tools do", async () => {
  const caldav = await startFakeCalDavServer("reject-credentials");
  try {
    await withTools(
      makeAccount({
        id: "gmail",
        default: true,
        caldav: { url: caldav.url, user: "alice@example.invalid", pass: PASSWORD },
      }),
      async ({ call, lines }) => {
        const message = await failureMessage(call("list_calendars", { account: "gmail" }));
        assert.match(message, /gmail/);
        assert.ok(!message.includes(PASSWORD));

        const warning = onlyWarning(lines);
        assert.equal(warning.extra?.account, "gmail");
        assert.equal(warning.extra?.tool, "list_calendars");
        assert.ok(String(warning.extra?.reason).length <= MAX_MESSAGE_LENGTH + 1);
        assert.ok(!JSON.stringify(warning).includes(PASSWORD));
      }
    );
  } finally {
    await caldav.close();
  }
});

test("an account with no CalDAV configured is not logged as a mailbox failure", async () => {
  await withTools(makeAccount({ id: "gmail", default: true }), async ({ call, lines }) => {
    const message = await failureMessage(call("list_calendars", { account: "gmail" }));
    assert.match(message, /CalDAV/);
    assert.equal(lines.filter((line) => line.level === "warn").length, 0);
  });
});
