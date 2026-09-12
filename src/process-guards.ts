// Last-resort handlers for the two ways a Node process dies silently.
//
// Node's default for an unhandled promise rejection is to exit. In this app
// those come from a forgotten .catch on a Slack or provider call, never from
// corrupted state, so logging and carrying on keeps the dashboard (and the
// terminal websockets on it) alive. An uncaught exception is different: a
// timer or stream callback threw mid-flight and internal state may be torn,
// so log it and exit non-zero; systemd (Restart=on-failure) brings the
// service back in five seconds.

let installed = false;

export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[Devy] unhandled promise rejection (continuing): ${detail}`);
  });

  process.on("uncaughtException", (error, origin) => {
    console.error(`[Devy] uncaught exception (${origin}), exiting so systemd can restart: ${error.stack || error.message}`);
    // Give stderr a moment to flush; unref so a stuck handle cannot keep us up.
    setTimeout(() => process.exit(1), 100).unref();
  });
}
