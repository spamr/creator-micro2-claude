// One helper per machine. The running helper listens on a Unix socket in
// state/; a second copy sees the socket answer and exits instead of
// double-dispatching every key. The same socket answers "status" for the
// doctor and "stop" for the uninstaller.
import net from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { STATE_DIR } from "./sessions.js";

export const SOCKET_PATH = STATE_DIR + "helper.sock";

/** Ask the running helper something; null when none is running. */
export function ask(command, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET_PATH);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    socket.on("connect", () => socket.write(command + "\n"));
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        resolve({ raw: data });
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** Serve status/stop for this helper. Returns false if another one owns the socket. */
export async function serve(handlers) {
  if (existsSync(SOCKET_PATH)) {
    const alive = await ask("status", 800);
    if (alive) return false;
    try {
      unlinkSync(SOCKET_PATH);
    } catch {}
  }
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const command = buffer.slice(0, newline).trim();
      let reply;
      try {
        reply = command === "status" ? await handlers.status() : command === "stop" ? await handlers.stop() : { error: `unknown command ${command}` };
      } catch (e) {
        reply = { error: e.message };
      }
      socket.end(JSON.stringify(reply));
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => server.listen(SOCKET_PATH, resolve).on("error", reject));
  return server;
}
