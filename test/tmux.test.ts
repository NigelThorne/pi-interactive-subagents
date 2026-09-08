import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { inspectSubagentStatus } from "../pi-extension/subagents/status.ts";
import {
  createSurface,
  getMuxBackend,
  getSurfaceState,
  probeSurfaceSubagent,
} from "../pi-extension/subagents/cmux.ts";
import {
  captureTmuxPane,
  closeTmuxPane,
  createTmuxPane,
  getTmuxPaneState,
  probeTmuxSubagent,
  queryTmuxPaneRoute,
  renameTmuxPane,
  sendTmuxCommand,
  type TmuxConnection,
} from "../pi-extension/subagents/tmux.ts";

const MISE_TMUX = "/Users/nigelthorne/.local/share/mise/installs/tmux/3.6a/bin/tmux";
const TMUX = process.env.PI_TEST_TMUX?.trim() ||
  (existsSync(MISE_TMUX)
    ? MISE_TMUX
    : execFileSync("/usr/bin/which", ["tmux"], { encoding: "utf8", timeout: 2_000 }).trim());

function run(connection: TmuxConnection, args: string[]): string {
  return execFileSync(connection.executable, ["-S", connection.socketPath, ...args], {
    encoding: "utf8",
    timeout: 2_000,
  }).trim();
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): void {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

function withServer(fn: (state: {
  connection: TmuxConnection;
  dir: string;
  parentPane: string;
  parentWindow: string;
  otherWindow: string;
}) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-tmux-test-"));
  const connection = {
    executable: TMUX,
    socketPath: join(dir, "tmux.sock"),
    timeoutMs: 2_000,
  };

  try {
    run(connection, ["-f", "/dev/null", "new-session", "-d", "-s", "test", "-n", "other", "-c", dir]);
    const otherWindow = run(connection, ["display-message", "-p", "-t", "test:other", "#{window_id}"]);
    const parentWindow = run(connection, ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", "test:", "-n", "parent", "-c", dir]);
    const parentPane = run(connection, ["display-message", "-p", "-t", parentWindow, "#{pane_id}"]);
    run(connection, ["select-window", "-t", otherWindow]);
    fn({ connection, dir, parentPane, parentWindow, otherWindow });
  } finally {
    try {
      run(connection, ["kill-server"]);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("tmux backend", () => {
  it("routes the public mux adapter through tmux and keeps the child beside TMUX_PANE", () => {
    withServer(({ connection, dir, parentPane, parentWindow }) => {
      const original = {
        TMUX: process.env.TMUX,
        TMUX_PANE: process.env.TMUX_PANE,
        CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
        PI_SUBAGENT_MUX: process.env.PI_SUBAGENT_MUX,
        PI_SUBAGENT_TMUX_EXECUTABLE: process.env.PI_SUBAGENT_TMUX_EXECUTABLE,
      };
      process.env.TMUX = `${connection.socketPath},99999,0`;
      process.env.TMUX_PANE = parentPane;
      process.env.CMUX_SOCKET_PATH = "/tmp/inherited-cmux.sock";
      delete process.env.PI_SUBAGENT_MUX;
      process.env.PI_SUBAGENT_TMUX_EXECUTABLE = connection.executable;

      try {
        assert.equal(getMuxBackend(), "tmux");
        const surface = createSurface("adapter worker", "sleep 5", dir);
        const route = queryTmuxPaneRoute(connection, surface);
        assert.equal(route.windowID, parentWindow);
        assert.equal(getSurfaceState(surface), "present");
        assert.equal(probeSurfaceSubagent(surface, join(dir, "wrong-session.jsonl"))?.processes.length, 0);
        closeTmuxPane(route, connection);
      } finally {
        for (const [name, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
  });

  it("creates a detached direct-command pane beside the explicit parent without stealing focus", () => {
    withServer(({ connection, dir, parentPane, parentWindow, otherWindow }) => {
      const cwd = join(dir, "child cwd");
      execFileSync("mkdir", ["-p", cwd]);
      const observed = join(dir, "observed.txt");
      const command = `printf '%s\\n%s\\n' "$PWD" "$PTC_ALLOW_UNSANDBOXED_SUBPROCESS" > ${JSON.stringify(observed)}; sleep 5`;
      const parentRoute = queryTmuxPaneRoute(connection, parentPane);

      const child = createTmuxPane({
        connection,
        from: parentRoute,
        name: "worker pane",
        direction: "right",
        cwd,
        command,
        environment: { PTC_ALLOW_UNSANDBOXED_SUBPROCESS: "true" },
      });

      waitFor(() => existsSync(observed));
      assert.equal(child.socketPath, connection.socketPath);
      assert.match(child.sessionID, /^\$\d+$/);
      assert.match(child.windowID, /^@\d+$/);
      assert.match(child.paneID, /^%\d+$/);
      assert.equal(child.windowID, parentWindow);
      assert.equal(
        realpathSync(run(connection, ["display-message", "-p", "-t", child.paneID, "#{pane_current_path}"])),
        realpathSync(cwd),
      );
      const [observedCwd, observedSandbox] = readFileSync(observed, "utf8").trimEnd().split("\n");
      assert.equal(realpathSync(observedCwd), realpathSync(cwd));
      assert.equal(observedSandbox, "true");
      assert.equal(run(connection, ["display-message", "-p", "-t", "test", "#{window_id}"]), otherWindow);
      assert.equal(run(connection, ["display-message", "-p", "-t", parentPane, "#{pane_active}"]), "1");
      assert.equal(run(connection, ["display-message", "-p", "-t", child.paneID, "#{pane_title}"]), "worker pane");
    });
  });

  it("places backward splits to the left and above the explicit parent", () => {
    withServer(({ connection, dir, parentPane }) => {
      const parentRoute = queryTmuxPaneRoute(connection, parentPane);
      const left = createTmuxPane({
        connection,
        from: parentRoute,
        name: "left worker",
        direction: "left",
        cwd: dir,
        command: "sleep 5",
      });
      const leftEdge = Number(run(connection, ["display-message", "-p", "-t", left.paneID, "#{pane_left}"]));
      const parentLeft = Number(run(connection, ["display-message", "-p", "-t", parentPane, "#{pane_left}"]));
      assert.ok(leftEdge < parentLeft);
      closeTmuxPane(left, connection);

      const above = createTmuxPane({
        connection,
        from: parentRoute,
        name: "upper worker",
        direction: "up",
        cwd: dir,
        command: "sleep 5",
      });
      const upperEdge = Number(run(connection, ["display-message", "-p", "-t", above.paneID, "#{pane_top}"]));
      const parentTop = Number(run(connection, ["display-message", "-p", "-t", parentPane, "#{pane_top}"]));
      assert.ok(upperEdge < parentTop);
    });
  });

  it("captures output, steers the existing pane, renames it, and closes only that pane", () => {
    withServer(({ connection, dir, parentPane }) => {
      const received = join(dir, "received.txt");
      const parentRoute = queryTmuxPaneRoute(connection, parentPane);
      const child = createTmuxPane({
        connection,
        from: parentRoute,
        name: "waiting",
        direction: "down",
        cwd: dir,
        command: `printf 'ready\\n'; IFS= read -r line; printf '%s' "$line" > ${JSON.stringify(received)}; sleep 5`,
      });

      waitFor(() => captureTmuxPane(child, 20, connection).includes("ready"));
      sendTmuxCommand(child, "steer this exact process", connection);
      waitFor(() => existsSync(received));
      assert.equal(readFileSync(received, "utf8"), "steer this exact process");

      renameTmuxPane(child, "renamed worker", connection);
      assert.equal(run(connection, ["display-message", "-p", "-t", child.paneID, "#{pane_title}"]), "renamed worker");

      closeTmuxPane(child, connection);
      assert.throws(() => queryTmuxPaneRoute(connection, child.paneID));
      assert.doesNotThrow(() => queryTmuxPaneRoute(connection, parentPane));
    });
  });

  it("recognizes a child Pi only when pane ancestry carries the expected session identity", () => {
    withServer(({ connection, dir, parentPane }) => {
      const fakePi = join(dir, "pi");
      symlinkSync("/bin/sleep", fakePi);
      const sessionFile = join(dir, "expected child.jsonl");
      writeFileSync(sessionFile, "{}\n");
      const done = join(dir, "done");
      const parentRoute = queryTmuxPaneRoute(connection, parentPane);
      const child = createTmuxPane({
        connection,
        from: parentRoute,
        name: "live worker",
        direction: "right",
        cwd: dir,
        command: `${JSON.stringify(fakePi)} 5; printf done > ${JSON.stringify(done)} # ${sessionFile}`,
      });

      waitFor(() => probeTmuxSubagent(child, sessionFile, connection).processes.length === 1);
      const verified = probeTmuxSubagent(child, sessionFile, connection);
      assert.equal(verified.paneState, "present");
      assert.equal(verified.processes.length, 1);
      assert.match(verified.processes[0].command, /\/pi 5/);
      assert.equal(
        inspectSubagentStatus(
          {
            id: "launch-id",
            name: "live worker",
            surface: child.paneID,
            startTime: Date.now() - 100,
            sessionFile,
            doneFile: done,
          },
          {
            doneFileExists: false,
            paneState: verified.paneState,
            processes: verified.processes,
            now: Date.now(),
          },
        ).lifecycle,
        "running",
      );

      const wrong = probeTmuxSubagent(child, join(dir, "different.jsonl"), connection);
      assert.equal(wrong.paneState, "present");
      assert.deepEqual(wrong.processes, []);
    });
  });

  it("reports a timed-out pane query as unknown rather than missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-tmux-timeout-"));
    const fakeTmux = join(dir, "tmux");
    writeFileSync(fakeTmux, "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
    const route = {
      socketPath: join(dir, "sock"),
      serverPID: process.pid,
      serverStartTime: "now",
      sessionID: "$1",
      windowID: "@1",
      paneID: "%1",
    };

    try {
      assert.equal(
        getTmuxPaneState(route, { executable: fakeTmux, socketPath: route.socketPath, timeoutMs: 30 }),
        "unknown",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to close a reused pane ID after the tmux server incarnation changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-tmux-stale-"));
    const connection: TmuxConnection = {
      executable: TMUX,
      socketPath: join(dir, "tmux.sock"),
      timeoutMs: 2_000,
    };

    try {
      run(connection, ["-f", "/dev/null", "new-session", "-d", "-s", "old"]);
      const stale = queryTmuxPaneRoute(connection, "old:");
      run(connection, ["kill-server"]);
      run(connection, ["-f", "/dev/null", "new-session", "-d", "-s", "new"]);
      const replacement = queryTmuxPaneRoute(connection, "new:");
      assert.equal(replacement.paneID, stale.paneID);

      assert.throws(() => closeTmuxPane(stale, connection), /server incarnation/i);
      assert.equal(getTmuxPaneState(replacement, connection), "present");
    } finally {
      try {
        run(connection, ["kill-server"]);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets direct commands close their panes on exit", () => {
    withServer(({ connection, dir, parentPane }) => {
      const child = createTmuxPane({
        connection,
        from: queryTmuxPaneRoute(connection, parentPane),
        name: "short lived",
        direction: "right",
        cwd: dir,
        command: "sleep 0.2",
      });

      waitFor(() => getTmuxPaneState(child, connection) === "missing");
      assert.doesNotThrow(() => queryTmuxPaneRoute(connection, parentPane));
    });
  });
});
