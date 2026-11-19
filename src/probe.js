#!/usr/bin/env node
// Proof of life: open the keypad, print every input event, light the ring.
//
//   node src/probe.js [ring colour]       e.g. node src/probe.js amber
//
// While running, type a colour name or #rrggbb and press Return to change the
// ring; "keys <colour>" lights all six agent keys; "off" clears; "q" quits.
// Lights are cleared on exit.
import readline from "node:readline";
import { Keypad, firmwareSupported, parseFirmwareVersion, productName, RING_OFF, KEY_COUNT } from "./device.js";
import { COLORS, parseColor, ring, keyLight } from "./colors.js";

const stamp = () => new Date().toISOString().slice(11, 23);
const say = (...parts) => console.log(stamp(), ...parts);

const startColor = process.argv[2] ?? "blue";
let ringColor;
try {
  ringColor = parseColor(startColor);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const keypad = new Keypad(
  {
    onStateChange: (state) => {
      const hints = {
        permission_required: "macOS refused the open: grant Input Monitoring to this terminal app (System Settings > Privacy & Security > Input Monitoring), then rerun.",
        device_busy: "another process holds the device exclusively (the ChatGPT app?). Quit it; retrying.",
        device_absent: "no Creator Micro 2 / Codex Micro found; check power, USB or Bluetooth. Retrying.",
      };
      say(`state: ${state}${hints[state] ? ` -> ${hints[state]}` : ""}`);
    },
    onConnect: async (info) => {
      say(`connected: ${productName(info.productId)} "${info.product}" vid=0x${info.vendorId.toString(16)} pid=0x${info.productId.toString(16)}`);
      const version = await keypad.firmwareVersion(1500);
      if (version) {
        const parsed = parseFirmwareVersion(version);
        const ok = parsed ? firmwareSupported(parsed) : null;
        say(`firmware: ${version}${ok === false ? " (older than 0.6.3: update it in the Input app)" : ""}`);
      } else {
        say("firmware: no reply to device.status within 1.5 s (not fatal)");
      }
      await keypad.setRing(ring(ringColor)).catch((e) => say(`ring write failed: ${e.message}`));
      say(`ring set to ${describe(ringColor)}. Now press keys, turn the dial, move the stick.`);
      say("If nothing prints, the device is probably not on its Codex layer.");
    },
    onDisconnect: () => say("disconnected"),
    onHid: (key, act) => say(`key  ${key.padEnd(8)} ${act === 1 ? "press" : act === 0 ? "release" : `act=${act}`}`),
    onJoystick: (angle, distance) => say(`stick angle=${angle.toFixed(3)} distance=${distance.toFixed(3)}`),
    onRaw: (channel, message) => say(`raw  ch${channel} ${message}`),
  },
  (message) => say(`log: ${message}`),
);

function describe(color) {
  const name = Object.entries(COLORS).find(([, v]) => v === color)?.[0];
  return name ?? `#${color.toString(16).padStart(6, "0")}`;
}

async function shutdown() {
  if (keypad.connected) {
    await keypad.setKeyLights(Array.from({ length: KEY_COUNT }, (_, id) => keyLight(id, 0))).catch(() => {});
    await keypad.setRing(RING_OFF).catch(() => {});
  }
  await keypad.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  if (text === "q" || text === "quit") return shutdown();
  try {
    if (text.startsWith("keys ")) {
      const color = parseColor(text.slice(5));
      await keypad.setKeyLights(Array.from({ length: KEY_COUNT }, (_, id) => keyLight(id, color)));
      say(`agent keys set to ${describe(color)}`);
    } else if (text === "off") {
      await keypad.setKeyLights(Array.from({ length: KEY_COUNT }, (_, id) => keyLight(id, 0)));
      await keypad.setRing(RING_OFF);
      say("lights off");
    } else {
      ringColor = parseColor(text);
      await keypad.setRing(ring(ringColor));
      say(`ring set to ${describe(ringColor)}`);
    }
  } catch (error) {
    say(`error: ${error.message}`);
  }
});

say(`probe starting; colours: ${Object.keys(COLORS).join(", ")} or #rrggbb; type one + Return to change the ring, "keys <colour>" for the agent keys, "q" to quit`);
keypad.start();
