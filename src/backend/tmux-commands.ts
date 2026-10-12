import { randomUUID } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";
import { SEP, shellEscape } from "./monitor-helpers.js";

const TMUX_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/bin",
  "/usr/pkg/bin",
];

export function withTmuxPath(command: string): string {
  const script = `PATH=${TMUX_PATH_DIRS.join(":")}:"$PATH"; export PATH; ${command}`;
  return `/bin/sh -c ${shellEscape(script)}`;
}

export function tmuxCommand(args: string): string {
  return withTmuxPath(`tmux -u ${args}`);
}

/**
 * Run a command on the remote host via a separate exec channel.
 * Returns stdout as a string. Does not pollute the interactive shell.
 */
export function execCommand(conn: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });
      stream.on("error", (err: Error) => {
        reject(err);
      });
      stream.on("close", (code: number) => {
        if (code !== 0 && stdout === "") {
          reject(
            new Error(stderr.trim() || `Command exited with code ${code}`),
          );
        } else {
          resolve(stdout.trim());
        }
      });
    });
  });
}

interface TmuxSessionInfo {
  name: string;
  created: number;
  lastActivity: number;
  windows: number;
  attachedClients: number;
}

export interface TmuxDetectionResult {
  available: boolean;
  sessions: TmuxSessionInfo[];
}

/**
 * Detect whether tmux is installed and list all existing sessions with details.
 */
export async function detectTmux(
  conn: Client,
  hostId?: number,
): Promise<TmuxDetectionResult> {
  const sh = await tmuxShellFor(conn, hostId);
  try {
    await execCommand(conn, sh.cmd("-V"));
  } catch {
    return { available: false, sessions: [] };
  }

  let sessions: TmuxSessionInfo[] = [];
  try {
    const output = await execCommand(
      conn,
      sh.cmd(
        `list-sessions -F "#{session_name}${SEP}#{session_created}${SEP}#{session_activity}${SEP}#{session_windows}${SEP}#{session_attached}" ${sh.quiet}`,
      ),
    );
    if (output) {
      sessions = output
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name, created, activity, windows, attached] = line.split(SEP);
          return {
            name,
            created: parseInt(created, 10) || 0,
            lastActivity: parseInt(activity, 10) || 0,
            windows: parseInt(windows, 10) || 0,
            attachedClients: parseInt(attached, 10) || 0,
          };
        });
    }
  } catch {
    // tmux server not running yet -- no sessions exist
  }

  return { available: true, sessions };
}

/**
 * Wait for a tmux session to appear by polling via exec channel.
 * Returns the session name once found, or null on timeout.
 */
export async function waitForTmuxSession(
  conn: Client,
  sessionName: string,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<string | null> {
  const sh = await tmuxShellFor(conn);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await execCommand(
        conn,
        sh.cmd(`has-session -t ${sh.q(`=${sessionName}`)} ${sh.quiet}`),
      );
      return sessionName;
    } catch {
      // session not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/**
 * Write tmux attach or new-session command to the interactive shell stream.
 * Uses && exit so the shell only closes if tmux started successfully.
 *
 * Options are set on this session only so the user's own tmux config stays
 * untouched. -q keeps an older tmux that lacks an option from aborting the
 * attach.
 */
export function attachOrCreateTmuxSession(
  stream: ClientChannel,
  existingSessionName?: string,
  newSessionName?: string,
  mouseEnabled = true,
  shell: ShellKind = "posix",
): void {
  const sh = tmuxShell(shell);
  const name =
    existingSessionName || newSessionName || `termix-${randomUUID()}`;
  const target = sh.q(`=${name}`);
  const commands = existingSessionName
    ? []
    : [`new-session -d -s ${sh.q(name)}`];
  commands.push(
    `set-option -q -t ${target} mouse ${mouseEnabled ? "on" : "off"}`,
    `set-option -q -t ${target} history-limit 50000`,
    `attach-session -t ${target}`,
  );
  stream.write(`${sh.sequence(commands)} && exit\r`);
}

/**
 * The shell a host runs exec commands in. POSIX hosts get every command
 * wrapped in /bin/sh (see withTmuxPath). Windows hosts running psmux, the
 * native tmux port, have no /bin/sh: OpenSSH hands the command to cmd.exe,
 * so tmux is called directly with Windows quoting.
 */
export type ShellKind = "posix" | "windows";

/** How to build tmux commands for one shell. */
export interface TmuxShell {
  kind: ShellKind;
  /** A tmux invocation, e.g. cmd("list-sessions"). */
  cmd: (args: string) => string;
  /** Several tmux commands run in order, stopping at the first failure. */
  sequence: (commands: string[]) => string;
  /** Quote one argument. */
  q: (value: string) => string;
  /** Discard stderr. */
  quiet: string;
}

// cmd.exe and psmux (Rust's argument parsing) both treat a double-quoted
// argument as one, with "" for a literal quote. Session names and pane ids are
// validated before they get here; this keeps anything else literal.
export function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

const POSIX: TmuxShell = {
  kind: "posix",
  cmd: (args) => tmuxCommand(args),
  sequence: (commands) => tmuxCommand(commands.join(" \\; ")),
  q: shellEscape,
  quiet: "2>/dev/null",
};

const WINDOWS: TmuxShell = {
  kind: "windows",
  cmd: (args) => `tmux -u ${args}`,
  // cmd.exe has no tmux "\;" separator; && runs the next only on success.
  sequence: (commands) => commands.map((c) => `tmux -u ${c}`).join(" && "),
  q: windowsQuote,
  quiet: "2>nul",
};

export function tmuxShell(kind: ShellKind): TmuxShell {
  return kind === "windows" ? WINDOWS : POSIX;
}

const byClient = new WeakMap<Client, ShellKind>();
const byHost = new Map<number, ShellKind>();

/** The shell detected for a host on an earlier connection, if any. */
export function knownShell(hostId: number | undefined): ShellKind | undefined {
  return hostId === undefined ? undefined : byHost.get(hostId);
}

// Runs the probe on an exec channel. A channel error rejects (the host is
// unreachable, not Windows); a command that runs and fails resolves.
function probe(conn: Client): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    conn.exec("/bin/sh -c 'echo posix'", (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = "";
      stream.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });
      stream.stderr?.on("data", () => {});
      stream.on("error", reject);
      stream.on("close", (code: number) => resolve({ code, stdout }));
    });
  });
}

/**
 * Detects the host's shell once per connection: /bin/sh answering means POSIX,
 * anything else means Windows. Remembered per host so the terminal's attach
 * (which only gets a stream and a host id) can use it too.
 */
export async function detectShell(
  conn: Client,
  hostId?: number,
): Promise<ShellKind> {
  const cached = byClient.get(conn);
  if (cached) return cached;
  const { stdout } = await probe(conn);
  const kind: ShellKind = stdout.trim() === "posix" ? "posix" : "windows";
  byClient.set(conn, kind);
  if (hostId !== undefined) byHost.set(hostId, kind);
  return kind;
}

export async function tmuxShellFor(
  conn: Client,
  hostId?: number,
): Promise<TmuxShell> {
  return tmuxShell(await detectShell(conn, hostId));
}
