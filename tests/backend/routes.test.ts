import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { startServer, type TestServer } from "./helpers";

function fakeSshClient(outputs: Record<string, string>, exitCode = 0) {
  const client = new EventEmitter() as EventEmitter & {
    exec: (
      command: string,
      cb: (err: Error | null, stream: unknown) => void,
    ) => void;
  };
  client.exec = (command, cb) => {
    const stream = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
    };
    stream.stderr = new EventEmitter();
    // A POSIX host answers the shell probe (see detectShell).
    const probe = command === "/bin/sh -c 'echo posix'";
    const matchKey = Object.keys(outputs).find((k) => command.includes(k));
    const output = probe ? "posix\n" : matchKey ? outputs[matchKey] : "";
    cb(null, stream);
    setImmediate(() => {
      if (output) stream.emit("data", Buffer.from(output));
      stream.emit("close", probe ? 0 : exitCode);
    });
  };
  return client;
}

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("GET /:hostId/overview", () => {
  it("403s when the host does not exist or is not reachable", async () => {
    server = await startServer({ hosts: [] });
    const res = await server.request("GET", "/7/overview");
    expect(res.status).toBe(403);
  });

  it("403s when the monitor is disabled for the host", async () => {
    server = await startServer({ enabledHosts: [] });
    const res = await server.request("GET", "/7/overview");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it("403s without the tmux-monitor.use permission", async () => {
    server = await startServer({ permissions: [] });
    const res = await server.request("GET", "/7/overview");
    expect(res.status).toBe(403);
  });

  it("reports tmux unavailable when the exec exits non-zero", async () => {
    server = await startServer({ sshClient: fakeSshClient({}, 127) });
    const res = await server.request("GET", "/7/overview");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, sessions: [] });
  });
});

describe("PUT /:hostId/tags", () => {
  it("saves tags for the acting user and session", async () => {
    server = await startServer();
    const res = await server.request("PUT", "/7/tags", {
      body: { sessionName: "work", tags: ["a", "b", "b", "  "] },
    });
    expect(res.status).toBe(200);
    expect(res.body.tags.sort()).toEqual(["a", "b"]);
  });

  it("rejects a non-array tags field", async () => {
    server = await startServer();
    const res = await server.request("PUT", "/7/tags", {
      body: { sessionName: "work", tags: "nope" },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /:hostId/sessions", () => {
  it("rejects an invalid session name", async () => {
    server = await startServer();
    const res = await server.request("POST", "/7/sessions", {
      body: { name: "bad:name" },
    });
    expect(res.status).toBe(400);
  });
});

describe("Windows hosts (psmux)", () => {
  // OpenSSH on Windows runs commands in cmd.exe: no /bin/sh, no ps, no grep.
  function windowsSshClient(outputs: Record<string, string>) {
    const client = new EventEmitter() as EventEmitter & {
      commands: string[];
      exec: (
        command: string,
        cb: (err: Error | null, stream: unknown) => void,
      ) => void;
    };
    client.commands = [];
    client.exec = (command, cb) => {
      client.commands.push(command);
      const stream = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
      };
      stream.stderr = new EventEmitter();
      const posixOnly = /^\/bin\/sh|^ps |grep|nvidia-smi/.test(command);
      const matchKey = Object.keys(outputs).find((k) => command.includes(k));
      cb(null, stream);
      setImmediate(() => {
        if (!posixOnly && matchKey)
          stream.emit("data", Buffer.from(outputs[matchKey]));
        stream.emit("close", posixOnly ? 1 : 0);
      });
    };
    return client;
  }

  it("lists sessions without wrapping commands in /bin/sh", async () => {
    const client = windowsSshClient({
      "-V": "tmux 3.3.8\n",
      "list-sessions": "agent<<TMX>>1<<TMX>>2<<TMX>>0\n",
    });
    server = await startServer({ sshClient: client });
    const res = await server.request("GET", "/7/overview");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.sessions.map((s: { name: string }) => s.name)).toEqual([
      "agent",
    ]);
    const tmuxCalls = client.commands.filter((c) => c.includes("tmux"));
    expect(tmuxCalls.every((c) => c.startsWith("tmux -u "))).toBe(true);
  });

  it("returns empty metrics instead of running ps", async () => {
    const client = windowsSshClient({ "list-panes": "" });
    server = await startServer({ sshClient: client });
    const res = await server.request("GET", "/7/metrics");
    expect(res.status).toBe(200);
    expect(client.commands.some((c) => c.startsWith("ps "))).toBe(false);
  });

  it("searches panes by matching captured text locally", async () => {
    const client = windowsSshClient({
      "list-panes":
        "agent<<TMX>>0<<TMX>>%1<<TMX>>0<<TMX>>100<<TMX>>1<<TMX>>80<<TMX>>24<<TMX>>node<<TMX>>C:\\\\x<<TMX>>t\n",
      "capture-pane": "build ok\nERROR: boom\nerror again\n",
    });
    server = await startServer({ sshClient: client });
    const res = await server.request("GET", "/7/search?q=error");
    expect(res.status).toBe(200);
    expect(
      res.body.matches.map((m: { line: number; text: string }) => [
        m.line,
        m.text,
      ]),
    ).toEqual([
      [2, "ERROR: boom"],
      [3, "error again"],
    ]);
    expect(client.commands.some((c) => c.includes("grep"))).toBe(false);
  });
});
