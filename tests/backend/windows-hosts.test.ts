import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import { describe, expect, it } from "vitest";
import { grepLines } from "../../src/backend/monitor-helpers.js";
import {
  attachOrCreateTmuxSession,
  detectShell,
  detectTmux,
  knownShell,
  tmuxShell,
  waitForTmuxSession,
  windowsQuote,
} from "../../src/backend/tmux-commands.js";

/**
 * A Windows host running psmux over OpenSSH: commands go to cmd.exe, so
 * /bin/sh is "not recognized" and exits 1. `answer` decides the rest.
 */
function windowsClient(
  answer: (command: string) => { out?: string; code?: number } = () => ({}),
) {
  const commands: string[] = [];
  const conn = {
    exec(command: string, cb: (err: Error | null, stream: never) => void) {
      commands.push(command);
      const stream = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
      };
      stream.stderr = new EventEmitter();
      cb(null, stream as never);
      setImmediate(() => {
        if (command.startsWith("/bin/sh")) {
          stream.stderr.emit(
            "data",
            Buffer.from(
              "'/bin/sh' is not recognized as an internal or external command",
            ),
          );
          stream.emit("close", 1);
          return;
        }
        const { out = "", code = 0 } = answer(command);
        if (out) stream.emit("data", Buffer.from(out));
        stream.emit("close", code);
      });
    },
  };
  return { conn: conn as unknown as Client, commands };
}

describe("shell detection", () => {
  it("treats a host without /bin/sh as Windows and remembers it per host", async () => {
    const { conn } = windowsClient();
    await expect(detectShell(conn, 41)).resolves.toBe("windows");
    expect(knownShell(41)).toBe("windows");
  });

  it("probes once per connection", async () => {
    const { conn, commands } = windowsClient();
    await detectShell(conn);
    await detectShell(conn);
    expect(commands.filter((c) => c.startsWith("/bin/sh"))).toHaveLength(1);
  });

  it("rejects when the exec channel itself fails instead of guessing Windows", async () => {
    const conn = {
      exec: (_c: string, cb: (err: Error) => void) =>
        cb(new Error("Channel open failure")),
    } as unknown as Client;
    await expect(detectShell(conn)).rejects.toThrow("Channel open failure");
  });
});

describe("tmux on Windows (psmux)", () => {
  it("detects tmux without the /bin/sh wrapper and lists sessions with cmd.exe redirection", async () => {
    const { conn, commands } = windowsClient((c) =>
      c.includes("list-sessions")
        ? { out: "agent<<TMX>>1700000000<<TMX>>1700000100<<TMX>>1<<TMX>>0\n" }
        : { out: "tmux 3.3.8\n" },
    );
    await expect(detectTmux(conn, 42)).resolves.toEqual({
      available: true,
      sessions: [expect.objectContaining({ name: "agent", windows: 1 })],
    });
    expect(commands.slice(1)).toEqual([
      "tmux -u -V",
      'tmux -u list-sessions -F "#{session_name}<<TMX>>#{session_created}<<TMX>>#{session_activity}<<TMX>>#{session_windows}<<TMX>>#{session_attached}" 2>nul',
    ]);
  });

  it("reports tmux unavailable when psmux is not installed either", async () => {
    const { conn } = windowsClient(() => ({ code: 9009 }));
    await expect(detectTmux(conn)).resolves.toEqual({
      available: false,
      sessions: [],
    });
  });

  it("waits for a session with an exact double-quoted target", async () => {
    const { conn, commands } = windowsClient();
    await expect(waitForTmuxSession(conn, "new")).resolves.toBe("new");
    expect(commands.at(-1)).toBe('tmux -u has-session -t "=new" 2>nul');
  });

  it("attaches through cmd.exe with && between tmux commands", () => {
    let written = "";
    const stream = {
      write: (v: string) => (written = v),
    } as unknown as ClientChannel;
    attachOrCreateTmuxSession(stream, "agent", undefined, false, "windows");
    expect(written).toBe(
      'tmux -u set-option -q -t "=agent" mouse off && tmux -u set-option -q -t "=agent" history-limit 50000 && tmux -u attach-session -t "=agent" && exit\r',
    );
  });

  it("creates a new session first when none is given", () => {
    let written = "";
    const stream = {
      write: (v: string) => (written = v),
    } as unknown as ClientChannel;
    attachOrCreateTmuxSession(stream, undefined, "fresh", true, "windows");
    expect(
      written.startsWith(
        'tmux -u new-session -d -s "fresh" && tmux -u set-option -q -t "=fresh" mouse on',
      ),
    ).toBe(true);
  });
});

describe("Windows quoting", () => {
  it("keeps cmd.exe metacharacters literal and doubles embedded quotes", () => {
    expect(windowsQuote("%3")).toBe('"%3"');
    expect(windowsQuote("a & b | c > d")).toBe('"a & b | c > d"');
    expect(windowsQuote('say "hi"')).toBe('"say ""hi"""');
  });

  it("POSIX commands are unchanged", () => {
    const posix = tmuxShell("posix");
    expect(posix.q("=a")).toBe("'=a'");
    expect(posix.quiet).toBe("2>/dev/null");
    expect(posix.sequence(["a", "b"])).toContain("tmux -u a \\; b");
  });
});

describe("grepLines", () => {
  it("matches like grep -n -i -F and stops at the limit", () => {
    const text = "Alpha\r\nbeta\nALPHA beta\nalphabet";
    expect(grepLines(text, "alpha", 2)).toBe("1:Alpha\n3:ALPHA beta");
    expect(grepLines(text, "a.b", 10)).toBe("");
    expect(grepLines("", "x", 5)).toBe("");
  });
});
