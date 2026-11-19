#!/usr/bin/env node
// Developer tool: send one JSON-RPC request to the pad and print the reply.
//   node tools/rpc.js device.status
//   node tools/rpc.js fs.read '{"file":"keymap.json"}'
import { HIDAsync } from "node-hid";
import { findCandidates } from "../src/device.js";
import { encodeMessage, Reassembler, CHANNEL_RPC } from "../src/framing.js";

const [method, paramsText] = process.argv.slice(2);
if (!method) {
  console.error("usage: node tools/rpc.js <method> [json params]");
  process.exit(2);
}
const params = paramsText ? JSON.parse(paramsText) : null;
const [info] = await findCandidates();
if (!info) {
  console.error("no pad found");
  process.exit(1);
}
const device = await HIDAsync.open(info.path, { nonExclusive: true });
const reassembler = new Reassembler();
const id = 4242;
const reply = new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ error: "timeout after 4 s" }), 4000);
  device.on("data", (buf) => {
    for (const { channel, message } of reassembler.push(buf)) {
      if (channel !== CHANNEL_RPC) continue;
      try {
        const parsed = JSON.parse(message);
        if (parsed.id === id) {
          clearTimeout(timer);
          resolve(parsed);
        }
      } catch {}
    }
  });
});
for (const report of encodeMessage(JSON.stringify({ method, params, id }))) await device.write(report);
console.log(JSON.stringify(await reply));
await device.close();
