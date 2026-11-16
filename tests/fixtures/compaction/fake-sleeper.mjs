#!/usr/bin/env node
/**
 * Real child process used to prove that adapter cancellation actually terminates a
 * subprocess. It records its own pid, prints a start marker, then sleeps forever.
 *
 * The default SIGTERM disposition is used deliberately: the process dies from the signal
 * (exit code null, exit signal SIGTERM), so the runner's `close` handler observes real
 * termination rather than an in-process `process.exit` shortcut.
 */
import { writeFileSync } from "node:fs";

const pidFile = process.env.FAKE_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));

process.stdout.write("fake-sleeper:started\n");

// Keep the event loop alive until a signal arrives.
setInterval(() => {}, 1000);
