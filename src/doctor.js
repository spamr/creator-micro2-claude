// Setup diagnostics: one line per check, then what to do about anything
// failing. Deliberately independent of the running helper, because the
// moment you need a doctor is when the helper may be stuck or blocked.
import { existsSync, statSync, readFileSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { HIDAsync } from "node-hid";
import { findCandidates, classifyOpenError, parseFirmwareVersion, firmwareSupported, MIN_FIRMWARE } from "./device.js";
import { encodeMessage, Reassembler, CHANNEL_RPC } from "./framing.js";
import { accessibilityGranted } from "./tapkey.js";
import { chatGptRunning } from "./chatgpt.js";
import { loadConfig, CONFIG_PATH } from "./config.js";
import { ask } from "./control.js";
import * as hooks from "./hooks.js";
import * as agent from "./agent.js";
import { EVENTS_PATH } from "./sessions.js";

const lines = [];
const advice = [];
const ok = (name, detail) => lines.push(`✓ ${name}: ${detail}`);
const bad = (name, detail, fix) => {
  lines.push(`✗ ${name}: ${detail}`);
  if (fix) advice.push(fix);
};
const note = (name, detail) => lines.push(`· ${name}: ${detail}`);

function running(pattern) {
  return spawnSync("pgrep", ["-f", pattern], { stdio: "ignore" }).status === 0;
}

// One request/reply on a fresh handle (the helper may hold the device too;
// every open handle receives every reply).
function rpc(device, method, params, id, timeoutMs = 2000) {
  const reassembler = new Reassembler();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = (value) => {
      clearTimeout(timer);
      device.off("data", onData);
      resolve(value);
    };
    const onData = (buf) => {
      for (const { channel, message } of reassembler.push(buf)) {
        if (channel !== CHANNEL_RPC) continue;
        try {
          const parsed = JSON.parse(message);
          if (parsed.id === id) return finish(parsed.result ?? null);
        } catch {}
      }
    };
    device.on("data", onData);
    (async () => {
      for (const report of encodeMessage(JSON.stringify({ method, params, id }))) await device.write(report);
    })().catch(() => finish(null));
  });
}

async function checkDevice() {
  let candidates;
  try {
    candidates = await findCandidates();
  } catch (e) {
    bad("pad", `could not list HID devices: ${e.message}`);
    return;
  }
  if (candidates.length === 0) {
    bad("pad", "no Creator Micro 2 or Codex Micro found", "Turn the pad on, or plug it in over USB; over Bluetooth, check it shows as connected in System Settings.");
    return;
  }
  const info = candidates[0];
  const transport = info.productId === 0x8298 ? "Bluetooth" : "USB";
  let device;
  try {
    device = await HIDAsync.open(info.path, { nonExclusive: true });
  } catch (e) {
    const why = classifyOpenError(e.message);
    bad("pad", `${info.product} found over ${transport} but cannot be opened from this terminal (${why})`,
      why === "permission_required"
        ? "Grant Input Monitoring to the app this terminal runs in (System Settings > Privacy & Security > Input Monitoring)."
        : why === "device_busy" ? "Another host holds the pad exclusively; quit the ChatGPT app." : `open error: ${e.message}`);
    return;
  }
  ok("pad", `${info.product} over ${transport}, openable from this terminal`);
  const status = await rpc(device, "device.status", null, 71);
  if (status) {
    const parsed = parseFirmwareVersion(status.version ?? "");
    if (parsed && firmwareSupported(parsed)) ok("firmware", `${status.version}, battery ${status.battery}%${status.is_charging ? " (charging)" : ""}`);
    else bad("firmware", `${status.version ?? "unknown"}; ${MIN_FIRMWARE.join(".")} or newer is needed`, "Update the firmware in Work Louder's Input app.");
  } else {
    note("firmware", "no reply to device.status (not fatal)");
  }
  const keymapReply = await rpc(device, "fs.read", { file: "keymap.json" }, 72, 3000);
  try {
    const keymap = JSON.parse(keymapReply.data ?? keymapReply);
    const profile = keymap.profiles.find((p) => p.id === keymap.activeProfileId) ?? keymap.profiles[0];
    const codex = profile.layers.find((l) => JSON.stringify(l.layout).includes("KV_OAI_AG00"));
    if (codex) ok("Claude layer", `layer "${codex.name}" (layer ${profile.layers.indexOf(codex) + 1} of ${profile.layers.length}) carries the agent keys; keep the pad on it (tap the touch sensor at the bottom left to cycle layers)`);
    else bad("Claude layer", "no layer on the pad has the agent keys", "In Work Louder's Input app open Preset, add the ChatGPT preset, then switch the pad to that layer.");
  } catch {
    note("Claude layer", "could not read the keymap");
  }
  if (transport === "Bluetooth") note("transport", "Bluetooth works; USB avoids pairing drops and sleep latency");
  await device.close().catch(() => {});
}

export async function run() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major >= 22) ok("node", `${process.version} at ${process.execPath}`);
  else bad("node", `${process.version}; 22 or newer is required`, "Install a current Node (brew install node).");

  try {
    const { targets } = loadConfig();
    ok("config", `${Object.values(targets).map((t) => t.name).join(", ")} (${CONFIG_PATH})`);
  } catch (e) {
    bad("config", e.message, `Fix config.json: ${e.message}`);
  }

  const ax = await accessibilityGranted();
  if (ax) ok("accessibility", "granted for this terminal (key presses can be sent)");
  else bad("accessibility", "not granted for this terminal", "Grant Accessibility to the app this terminal runs in (System Settings > Privacy & Security > Accessibility).");

  await checkDevice();

  const live = await ask("status");
  if (live) {
    const sessions = live.sessions?.length ? live.sessions.map((s) => `key ${s.key} ${s.status}`).join(", ") : "no sessions yet";
    if (live.device === "connected") ok("helper", `running (pid ${live.pid}), pad connected; ${sessions}`);
    else if (live.yieldedToChatGpt) note("helper", `running (pid ${live.pid}), yielding the pad to the ChatGPT app`);
    else bad("helper", `running (pid ${live.pid}) but pad state is ${live.device}`,
      live.device === "permission_required"
        ? `The helper's process lacks Input Monitoring. If it runs as the login item, add ${process.execPath} under System Settings > Privacy & Security > Input Monitoring (and Accessibility).`
        : "See state/helper.log for the device error.");
  } else {
    bad("helper", "not running", "Start it with: node bin/claude-micro.js run (or install the login item: node bin/claude-micro.js agent install).");
  }

  const a = agent.status();
  if (a.loaded) ok("login item", `loaded (pid ${a.pid ?? "?"}, ${a.state ?? "state unknown"}), log ${agent.LOG_PATH}`);
  else if (a.installed) bad("login item", "plist present but not loaded", "Run: node bin/claude-micro.js agent install");
  else note("login item", "not installed (node bin/claude-micro.js agent install)");
  if (existsSync(agent.LOG_PATH)) {
    // Only the current run matters: older refusals may predate a grant.
    const all = readFileSync(agent.LOG_PATH, "utf8");
    const lastStart = all.lastIndexOf("claude-micro starting");
    const tail = (lastStart === -1 ? all : all.slice(lastStart)).split("\n").slice(-200).join("\n");
    if (/not permitted|privilege violation/.test(tail)) advice.push(`helper.log shows an Input Monitoring refusal: add ${process.execPath} to Input Monitoring.`);
    if (/accessibility permission not granted/.test(tail)) advice.push(`helper.log shows key presses refused: add ${process.execPath} to Accessibility.`);
  }

  if (hooks.installed()) {
    let detail = `all ${hooks.HOOK_EVENTS.length} events in ${hooks.SETTINGS_PATH}`;
    try {
      accessSync(hooks.HOOK_SCRIPT, constants.X_OK);
    } catch {
      bad("hooks", `${detail}, but the script is missing or not executable`, `chmod +x ${hooks.HOOK_SCRIPT}`);
      detail = null;
    }
    if (detail) {
      let age = "no events yet";
      try {
        const ms = Date.now() - statSync(EVENTS_PATH).mtimeMs;
        if (statSync(EVENTS_PATH).size > 0) age = `last event ${Math.round(ms / 1000)} s ago`;
      } catch {}
      ok("hooks", `${detail}; ${age}`);
    }
  } else {
    bad("hooks", "not installed", "Run: node bin/claude-micro.js hooks install (shows nothing; use hooks diff first to review).");
  }

  if (live?.relay) {
    if (live.relay.connected) ok("cloud relay", `subscribed${live.relay.lastMessageAt ? `, last message ${Math.round((Date.now() - live.relay.lastMessageAt) / 1000)} s ago` : ", no messages yet"}`);
    else bad("cloud relay", `not connected (${live.relay.lastError ?? "connecting"})`, "Check internet access to ntfy.sh; the helper keeps retrying.");
  } else if (live) {
    note("cloud relay", "not set up (node bin/claude-micro.js cloud setup)");
  }
  if (await chatGptRunning()) note("ChatGPT app", "running; the helper yields the pad while it is open");
  else ok("ChatGPT app", "not running");
  if (running("Input.app/Contents/MacOS")) note("Input app", "running; it competes for the pad's lights, quit it when not configuring");
  note("dictation", existsSync("/Applications/Wispr Flow.app") ? "Wispr Flow installed (mic key uses its hands-free deep links)" : "Wispr Flow not found; rebind ACT11 in config.json");

  console.log(lines.join("\n"));
  if (advice.length) {
    console.log("\nTo fix:");
    for (const a of advice) console.log(`  - ${a}`);
  }
  return advice.length === 0;
}
