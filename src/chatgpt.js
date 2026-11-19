// The ChatGPT desktop app opens the pad exclusively and repaints its lights
// while it runs, so the helper yields the device to it. Detected by its main
// binary; the Codex app-server daemon that lingers after quitting does not
// hold the device and is deliberately not matched.
import { spawn } from "node:child_process";

const CHATGPT_BINARY = "ChatGPT.app/Contents/MacOS/ChatGPT";

export function chatGptRunning() {
  return new Promise((resolve) => {
    const child = spawn("pgrep", ["-f", CHATGPT_BINARY], { stdio: "ignore" });
    child.on("close", (status) => resolve(status === 0));
    child.on("error", () => resolve(false));
  });
}
