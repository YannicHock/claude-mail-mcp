/**
 * How far the operator has got through the setup wizard.
 *
 * The wizard is three screens and the operator may be interrupted between any
 * two of them — a reload, a closed tab, a container restart. Coming back to
 * step 1 each time would make the wizard worse than the manual path it replaces,
 * so the progress lives on the data volume next to the claim token and is read
 * back on the next boot.
 *
 * **This file holds progress and nothing else.** No username, no password, no
 * hash. Step 1 writes its credential straight to the operator record, which is
 * the file already built to hold one, and the state rule in bootstrap.ts is what
 * makes that safe to do before the wizard has finished. A half-finished wizard
 * therefore leaves no secret lying anywhere it would not otherwise be.
 *
 * The mark is a high-water mark, not a cursor: it only ever moves forward. Back
 * on step 3 renders step 2 without forgetting that step 3 was reached, so an
 * operator who goes back to check something is not made to walk forward again.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Logger } from "./logger.js";

/** The wizard's screens, in order. The path segment is the step's own name. */
export const SETUP_STEPS = ["credentials", "mailbox", "connect"] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/** The first screen, and where a wizard with no stored progress starts. */
export const FIRST_SETUP_STEP: SetupStep = SETUP_STEPS[0];

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === "string" && (SETUP_STEPS as readonly string[]).includes(value);
}

/** 1-based, for the `Step N of 3` line the design fixes as plain text. */
export function stepNumber(step: SetupStep): number {
  return SETUP_STEPS.indexOf(step) + 1;
}

const CURRENT_VERSION = 1;

interface SetupStateData {
  version: number;
  /** The furthest screen the operator has reached. */
  furthest: SetupStep;
}

export class SetupState {
  #data: SetupStateData;
  readonly #path: string | null;
  readonly #log: Logger;

  private constructor(path: string | null, data: SetupStateData, log: Logger) {
    this.#path = path;
    this.#data = data;
    this.#log = log;
  }

  /**
   * Read the stored progress, or start at step 1.
   *
   * Synchronous, like every other file this service reads before it binds a
   * socket, and forgiving in one direction only: anything unreadable, malformed
   * or from a version this build does not know is treated as no progress at all.
   * Starting the operator at step 1 costs them a retype of a form they have not
   * submitted yet; trusting a file this build cannot parse would cost them a
   * wizard that skips a screen it never showed.
   */
  static open(path: string | null, log: Logger): SetupState {
    if (path === null) {
      return new SetupState(null, { version: CURRENT_VERSION, furthest: FIRST_SETUP_STEP }, log);
    }

    let raw: string | null = null;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log("warn", "setup progress unreadable, starting the wizard from step 1", { path });
      }
    }

    const parsed = raw === null ? null : parse(raw);
    if (raw !== null && parsed === null) {
      log("warn", "setup progress malformed, starting the wizard from step 1", { path });
    }
    return new SetupState(
      path,
      parsed ?? { version: CURRENT_VERSION, furthest: FIRST_SETUP_STEP },
      log
    );
  }

  /** The screen a bare `/setup/<token>` resumes at. */
  get furthest(): SetupStep {
    return this.#data.furthest;
  }

  /** True when the operator has already been shown this screen. */
  reached(step: SetupStep): boolean {
    return SETUP_STEPS.indexOf(step) <= SETUP_STEPS.indexOf(this.#data.furthest);
  }

  /**
   * Record that the operator has reached this screen. Moves the mark forward,
   * never back, and is a no-op if the screen is already behind them.
   *
   * A failure to persist is logged and swallowed. By the time this is called the
   * step's own work — writing the operator record — has already succeeded, and
   * failing the request over the progress note would tell the operator their
   * credential was not saved when it was. The cost of the swallowed error is one
   * repeated screen after a restart.
   */
  async advanceTo(step: SetupStep): Promise<void> {
    if (this.reached(step)) return;
    this.#data = { ...this.#data, furthest: step };
    await this.#persist();
  }

  async #persist(): Promise<void> {
    const path = this.#path;
    if (path === null) return;
    const payload = JSON.stringify(this.#data, null, 2);
    try {
      // Temp file, then rename, the same recipe as operator.ts and store.ts: a
      // crash mid-write leaves the previous progress rather than a truncated
      // file the next boot would refuse to parse.
      const temp = join(dirname(path), `.${randomUUID()}.tmp`);
      await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temp, path);
    } catch (err) {
      this.#log("warn", "failed to persist setup progress", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function parse(raw: string): SetupStateData | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<SetupStateData>;
  if (candidate.version !== CURRENT_VERSION) return null;
  if (!isSetupStep(candidate.furthest)) return null;
  return { version: CURRENT_VERSION, furthest: candidate.furthest };
}
