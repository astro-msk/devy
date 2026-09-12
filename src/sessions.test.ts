import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { managedSessionCommand } from "./sessions.js";

test("successful login helpers exit; failed logins and ordinary agents retain a shell", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devy-session-command-"));
  try {
    // Observe the fallback shell without loading the developer's shell profile.
    await writeFile(path.join(dir, "bash"), "#!/bin/sh\nprintf 'SHELL_FALLBACK\\n'\n", { mode: 0o700 });
    const run = (launch: string, closeOnSuccess: boolean) => promisify(execFile)("/bin/bash", [
      "--noprofile", "--norc", "-c", managedSessionCommand("codex", launch, closeOnSuccess)
    ], { env: { PATH: dir }, timeout: 3000 });
    assert.equal((await run("printf LOGIN_OK", true)).stdout, "LOGIN_OK");
    assert.match((await run("(exit 7)", true)).stdout, /exited with status 7\nSHELL_FALLBACK/);
    assert.equal((await run("printf AGENT_DONE", false)).stdout, "AGENT_DONESHELL_FALLBACK\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
