// Loads config.json next to the package. Bindings are grouped by the bundle
// id of the app that must be frontmost; a press while another app is in
// front does nothing. Each binding is one of:
//   "none"                         ignore this input
//   { "key": "cmd+shift+]" }       tap a key combo
//   { "key": "space", "hold": true } press on key down, release on key up
//   { "scroll": 3 }                wheel scroll (positive = down) per tick
//   { "scroll": 3, "window": "Claude", "at": [0.5, 0.4] } ...aimed at a spot in that app's window
//   { "exec": ["open", "-a", "X"] } run a command (argv, no shell) on press
//   { "exec": [...], "release": [...] } ...and another command on release
// A binding may add "menu": { "ENC_CW": ..., "ENC_CC": ..., "ENC_CLK": ... }
// to re-bind the dial for a few seconds after it fires (e.g. click opens a
// menu, turning moves the selection, clicking again confirms and ends it).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseKeyCombo, isModifierKey } from "./keys.js";

export const CONFIG_PATH = fileURLToPath(new URL("../config.json", import.meta.url));

export const BUTTON_INPUTS = ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12", "ENC_CW", "ENC_CC", "ENC_CLK"];
const JOYSTICK_DIRECTIONS = ["up", "down", "left", "right"];
// Dial ticks report no release, so nothing can be held on them.
const EDGELESS = new Set(["ENC_CW", "ENC_CC"]);

const MENU_INPUTS = ["ENC_CW", "ENC_CC", "ENC_CLK"];
const MENU_TIMEOUT_MS = 6000;

function parseBinding(where, raw, allowHold) {
  const binding = parseBindingBody(where, raw, allowHold);
  if (raw && typeof raw === "object" && "menu" in raw) {
    if (!raw.menu || typeof raw.menu !== "object") throw new Error(`${where}.menu: expected an object`);
    const menu = {};
    for (const input of Object.keys(raw.menu)) {
      if (!MENU_INPUTS.includes(input)) throw new Error(`${where}.menu: only ${MENU_INPUTS.join(", ")} can be re-bound`);
      menu[input] = parseBindingBody(`${where}.menu.${input}`, raw.menu[input], input === "ENC_CLK");
    }
    binding.menu = menu;
    binding.menuTimeoutMs = Number(raw.menu_timeout_ms) || MENU_TIMEOUT_MS;
  }
  return binding;
}

function parseBindingBody(where, raw, allowHold) {
  if (raw === "none" || raw == null) return { kind: "none" };
  if (typeof raw !== "object") throw new Error(`${where}: expected "none" or an object`);
  const kinds = ["key", "scroll", "exec"].filter((k) => k in raw);
  for (const k of Object.keys(raw)) {
    if (!["key", "hold", "scroll", "window", "at", "exec", "release", "menu", "menu_timeout_ms"].includes(k)) throw new Error(`${where}: unknown field "${k}"`);
  }
  if (kinds.length !== 1) throw new Error(`${where}: name exactly one of key, scroll, exec`);
  if (kinds[0] === "key") {
    const combo = parseKeyCombo(raw.key);
    const hold = raw.hold === true || isModifierKey(combo.keyCode);
    if (hold && !allowHold) throw new Error(`${where}: "${raw.key}" cannot be held on an input without a release`);
    return { kind: "key", combo, hold, label: raw.key };
  }
  if (kinds[0] === "scroll") {
    const lines = Number(raw.scroll);
    if (!Number.isInteger(lines) || lines === 0 || Math.abs(lines) > 120) throw new Error(`${where}: scroll must be a nonzero integer up to 120`);
    let target = null;
    if ("window" in raw || "at" in raw) {
      const at = raw.at ?? [0.5, 0.4];
      if (typeof raw.window !== "string" || !raw.window) throw new Error(`${where}: "window" must be the app's window owner name, e.g. "Claude"`);
      if (!Array.isArray(at) || at.length !== 2 || at.some((n) => typeof n !== "number" || n < 0 || n > 1)) throw new Error(`${where}: "at" must be [x, y] fractions between 0 and 1`);
      target = { window: raw.window, at };
    }
    return { kind: "scroll", lines, target, label: `scroll ${lines}${target ? ` in ${target.window} window` : ""}` };
  }
  if (!Array.isArray(raw.exec) || raw.exec.length === 0 || typeof raw.exec[0] !== "string" || !raw.exec[0]) {
    throw new Error(`${where}: exec must be a non-empty argv array`);
  }
  let release = null;
  if ("release" in raw) {
    if (!allowHold) throw new Error(`${where}: "release" needs an input that reports a release`);
    if (!Array.isArray(raw.release) || raw.release.length === 0 || !raw.release[0]) throw new Error(`${where}: release must be a non-empty argv array`);
    release = raw.release.map(String);
  }
  return { kind: "exec", argv: raw.exec.map(String), release, label: raw.exec.join(" ") + (release ? " / " + release.join(" ") : "") };
}

function parseTarget(bundleId, raw) {
  const buttons = {};
  for (const input of BUTTON_INPUTS) {
    buttons[input] = parseBinding(`${bundleId}.${input}`, raw[input], !EDGELESS.has(input));
  }
  const joystick = {};
  for (const dir of JOYSTICK_DIRECTIONS) {
    joystick[dir] = parseBinding(`${bundleId}.joystick.${dir}`, raw.joystick?.[dir], false);
  }
  for (const key of Object.keys(raw)) {
    if (!BUTTON_INPUTS.includes(key) && key !== "joystick" && key !== "name") {
      throw new Error(`${bundleId}: unknown input "${key}" (valid: ${BUTTON_INPUTS.join(", ")}, joystick)`);
    }
  }
  return { name: raw.name ?? bundleId, buttons, joystick };
}

export function loadConfig(path = CONFIG_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || !raw.targets || typeof raw.targets !== "object") {
    throw new Error("config: expected { targets: { <bundle id>: {...} } }");
  }
  const targets = {};
  for (const [bundleId, spec] of Object.entries(raw.targets)) targets[bundleId] = parseTarget(bundleId, spec);
  // Order in which sessions take agent keys (1-6). Keys left out are never used.
  let keyOrder = [0, 1, 2, 3, 4, 5];
  if (raw.agent_key_order !== undefined) {
    const order = raw.agent_key_order;
    const valid = Array.isArray(order) && order.length >= 1 && new Set(order).size === order.length && order.every((k) => Number.isInteger(k) && k >= 1 && k <= 6);
    if (!valid) throw new Error("agent_key_order must list distinct keys from 1 to 6, e.g. [1, 3, 4, 5, 6]; keys left out are never used");
    keyOrder = order.map((k) => k - 1);
  }
  let expireHours = 4;
  if (raw.session_expiry_hours !== undefined) {
    expireHours = Number(raw.session_expiry_hours);
    if (!(expireHours > 0)) throw new Error("session_expiry_hours must be a positive number");
  }
  return { targets, keyOrder, expireHours, raw };
}
