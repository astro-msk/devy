import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const originalDirectory = process.cwd();
const testDirectory = await mkdtemp(path.join(os.tmpdir(), "devy-tools-"));
process.chdir(testDirectory);
// Dynamic import is intentional: agent-tools.ts reaches db.ts through sessions.ts, which binds its SQLite path from cwd.
const { FILE_READ_CAP, OUTPUT_CAP, runShell, runTool } = await import("./agent-tools.js");

before(() => {
  process.env.AGENT_BASH_TIMEOUT_SECONDS = "1";
});

after(async () => {
  delete process.env.AGENT_BASH_TIMEOUT_SECONDS;
  process.chdir(originalDirectory);
  await rm(testDirectory, { recursive: true, force: true });
});

test("a command that reads stdin returns immediately instead of hanging", async () => {
  const started = Date.now();
  const result = await runShell("cat", testDirectory, {});
  assert.equal(result.isError, false);
  assert.equal(result.content, "(no output)");
  assert.ok(Date.now() - started < 900, "must not wait for the timeout");
});

test("a timed-out command is killed together with its process group", async () => {
  // A unique sleep duration is the marker for "our" grandchild process.
  const marker = "sleep 30.7391";
  const result = await runShell(`${marker} & echo started; wait`, testDirectory, {});
  assert.equal(result.isError, true);
  assert.match(result.content, /^started\n… \[killed after 1s timeout\]$/);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const survivors = await execFileAsync("pgrep", ["-f", marker]).then((out) => out.stdout.trim()).catch(() => "");
  assert.equal(survivors, "", "the backgrounded sleep must die with the group");
});

test("output is capped for both the model and the live stream", async () => {
  const streamed: string[] = [];
  const result = await runShell("yes | head -c 300000", testDirectory, { onOutput: (chunk) => streamed.push(chunk) });
  assert.equal(result.isError, false);
  assert.ok(result.content.length <= OUTPUT_CAP + 40, `content is ${result.content.length}`);
  assert.match(result.content, /\[output truncated\]$/);
  const streamedTotal = streamed.reduce((sum, chunk) => sum + chunk.length, 0);
  assert.ok(streamedTotal <= OUTPUT_CAP + 40, `streamed ${streamedTotal}`);
  assert.match(streamed.at(-1) || "", /\[output truncated\]$/);
});

test("non-zero exits are reported as errors with the code", async () => {
  const result = await runShell("echo oops >&2; exit 3", testDirectory, {});
  assert.equal(result.isError, true);
  assert.equal(result.content, "oops\n[exit 3]");
});

test("the destructive-command guard refuses the obvious footguns", async () => {
  delete process.env.AGENT_UNRESTRICTED_BASH;
  for (const command of ["rm -rf /", "rm -rf ~", "sudo reboot", "mkfs.ext4 /dev/nvme0n1", ":(){ :|:& };:"]) {
    const result = await runTool("bash", { command }, {});
    assert.equal(result.isError, true, command);
    assert.match(result.content, /^Refused:/, command);
  }
  const fine = await runTool("bash", { command: "rm -rf ./build && echo ok", cwd: testDirectory }, {});
  assert.equal(fine.content, "ok");
});

test("read_file refuses directories and binaries and clips large files", async () => {
  const dir = await runTool("read_file", { path: testDirectory }, {});
  assert.equal(dir.isError, true);
  assert.match(dir.content, /is a directory/);

  const binary = path.join(testDirectory, "blob.bin");
  await writeFile(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  const blob = await runTool("read_file", { path: binary }, {});
  assert.equal(blob.isError, true);
  assert.match(blob.content, /binary file/);

  const big = path.join(testDirectory, "big.log");
  await writeFile(big, "x".repeat(FILE_READ_CAP + 5000));
  const clipped = await runTool("read_file", { path: big }, {});
  assert.equal(clipped.isError, false);
  assert.match(clipped.content, /… \[truncated 5000 bytes\]$/);
  assert.ok(clipped.content.length < FILE_READ_CAP + 100);

  const missing = await runTool("read_file", { path: path.join(testDirectory, "nope.txt") }, {});
  assert.equal(missing.isError, true);
  assert.match(missing.content, /ENOENT/);
  assert.equal((await runTool("read_file", { path: "  " }, {})).isError, true);
});

test("write_file creates parents and round-trips through read_file", async () => {
  const target = path.join(testDirectory, "nested", "deep", "note.md");
  const written = await runTool("write_file", { path: target, content: "# hi\n" }, {});
  assert.equal(written.isError, false);
  const read = await runTool("read_file", { path: target }, {});
  assert.equal(read.content, "# hi\n");
});

test("unknown tools and thrown tool errors come back as results, not exceptions", async () => {
  const unknown = await runTool("teleport", {}, {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /Unknown tool/);
  const send = await runTool("send_session", { session: "definitely-not-a-session-" + process.pid, text: "hi" }, {});
  assert.equal(send.isError, true);
  assert.match(send.content, /send failed/);
});
