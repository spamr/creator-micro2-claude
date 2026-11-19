#!/usr/bin/env node
// Developer tool: open every HID interface of the pad (non-exclusively) and
// print each incoming report with its interface, to find where an input goes.
import { HIDAsync, devicesAsync } from "node-hid";
import { VENDOR_ID, PRODUCT_IDS } from "../src/device.js";

const stamp = () => new Date().toISOString().slice(11, 23);
const devices = (await devicesAsync()).filter((d) => d.vendorId === VENDOR_ID && PRODUCT_IDS.includes(d.productId) && d.path);
if (devices.length === 0) {
  console.error("no pad found");
  process.exit(1);
}
const noise = /"result":\{"ok":1\}|host\.focused_app|device\.status/;
for (const info of devices) {
  const label = `page=0x${info.usagePage.toString(16)} usage=${info.usage}`;
  try {
    const dev = await HIDAsync.open(info.path, { nonExclusive: true });
    dev.on("data", (buf) => {
      const text = buf.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
      if (info.usagePage === 0xff00 && noise.test(text)) return;
      const hex = [...buf.subarray(0, Math.min(buf.length, 24))].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      console.log(stamp(), label.padEnd(22), hex, info.usagePage === 0xff00 ? text.slice(3, 80) : "");
    });
    dev.on("error", (e) => console.log(stamp(), label, "error:", e.message));
    console.log(stamp(), "listening on", label);
  } catch (e) {
    console.log(stamp(), "could not open", label, e.message.split(":").pop().trim());
  }
}
console.log(stamp(), "turn the dial, click it, press a key; Ctrl-C to stop");
