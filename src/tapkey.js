// Posts synthetic keystrokes and wheel scrolls through the compiled helper
// (bin/tapkey, built from native/tapkey.c). The helper needs the macOS
// Accessibility permission for the process tree that runs it. An allow-list
// of bundle ids makes the helper withhold the key unless one of those apps is
// frontmost, so a stray press never lands in the wrong window.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HELPER = fileURLToPath(new URL("../bin/tapkey", import.meta.url));

function run(args, log, label) {
  return new Promise((resolve) => {
    const child = spawn(HELPER, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => {
      if (status === 5) log(`${label}: ${stderr.trim()}`); // withheld: wrong app in front
      else if (status !== 0) log(`${label} failed (exit ${status}): ${stderr.trim()}`);
      resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", (error) => {
      log(`tapkey spawn failed: ${error.message}`);
      resolve({ status: -1, stdout: "", stderr: error.message });
    });
  });
}

/** mode: "tap" | "down" | "up". allow: array of bundle ids or [] for any app. */
export function postKey(combo, mode, allow, log) {
  const args = [String(combo.keyCode), mode, String(combo.modifiers), allow.join(",")];
  return run(args, log, `key ${combo.keyCode} ${mode}`);
}

/**
 * Wheel scroll, positive = down. Without a target it lands under the pointer
 * like a physical wheel. With { window, at: [x, y] } the pointer is moved to
 * that fraction of the named app's front window first (only while that app is
 * frontmost) and put back afterwards, so the dial can aim at, say, the
 * conversation pane while the cursor sits in the text box.
 */
export function postScroll(lines, log, target) {
  const args = ["scroll", String(lines)];
  if (target?.window) args.push(String(target.at[0]), String(target.at[1]), target.window);
  return run(args, log, `scroll ${lines}`);
}

/** Bundle id of the frontmost app, "" when unknown. Needs no permission. */
export async function frontmostApp() {
  const { stdout } = await run(["front"], () => {}, "front");
  return stdout;
}

/** True when the helper may post events (Accessibility granted). */
export async function accessibilityGranted() {
  const { status } = await run(["0", "check"], () => {}, "check");
  return status === 0;
}
