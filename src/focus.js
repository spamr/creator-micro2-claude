// Bring a Claude Code session's window forward. Desktop-app sessions open by
// deep link (the app accepts its own session id, which the hook captured from
// the environment). iTerm2 sessions are selected by their iTerm session id
// through AppleScript, which needs the Automation permission for iTerm2.
import { spawn } from "node:child_process";

function run(cmd, args, log) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => {
      if (status !== 0) log(`${cmd} failed (exit ${status}): ${stderr.trim()}`);
      resolve(status === 0);
    });
    child.on("error", (e) => {
      log(`${cmd} failed: ${e.message}`);
      resolve(false);
    });
  });
}

// The app link alone selects the session and raises the app. Activating the
// app separately afterwards made it bounce back to the previously focused
// local session, so nothing else is sent.
async function openInClaude(url, log) {
  return run("open", [url], log);
}

export async function focusSession(session, log) {
  if (session.cloud) {
    if (session.bridge && /^[A-Za-z0-9_-]+$/.test(session.bridge)) {
      // The desktop app shows Remote Control sessions from claude.ai/code/<id>;
      // its claude://claude.ai/... links navigate the app to the same page.
      log(`focus key ${session.slot + 1}: remote session ${session.bridge} (${session.cwd})`);
      return openInClaude(`claude://claude.ai/code/${session.bridge}`, log);
    }
    log(`key ${session.slot + 1}: remote session (${session.cwd}) without a Remote Control id; marked seen only`);
    return false;
  }
  if (session.host && /^local_[A-Za-z0-9-]+$/.test(session.host)) {
    log(`focus key ${session.slot + 1}: desktop session ${session.host}`);
    return openInClaude(`claude://code/continue?session=${session.host}`, log);
  }
  if (session.iterm) {
    // ITERM_SESSION_ID looks like "w0t1p0:UUID"; iTerm's scripting id is the UUID part.
    const id = session.iterm.split(":").pop();
    log(`focus key ${session.slot + 1}: iTerm session ${id}`);
    const script = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if id of s is "${id}" then
                select t
                select s
                set index of w to 1
                activate
                return
              end if
            end repeat
          end repeat
        end repeat
      end tell`;
    return run("osascript", ["-e", script], log);
  }
  log(`focus key ${session.slot + 1}: no window id known for session ${session.id.slice(0, 8)} (cwd ${session.cwd})`);
  return false;
}
