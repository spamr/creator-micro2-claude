// Vendor HID framing shared by the Codex Micro and the Creator Micro 2:
// 64-byte reports carrying newline-delimited JSON-RPC on a channel byte.
// Report layout: [report id 6][channel][payload length][payload, up to 61 bytes].
//
// Adapted from alasano/house-of-herdr packages/codex-micro/src/framing.ts
// (MIT, Copyright (c) 2026 Aljosa Asanovic). See THIRD_PARTY.md.

export const REPORT_ID = 6;
export const CHANNEL_RPC = 2;
const REPORT_SIZE = 64;
const MAX_PAYLOAD = 61;
const HEADER_SIZE = 3;
// A message that never terminates must not grow the buffer without bound.
const MAX_BUFFERED = 64 * 1024;

/** Split one JSON-RPC message into the 64-byte reports the device expects. */
export function encodeMessage(message) {
  const bytes = Buffer.from(message, "utf8");
  const reports = [];
  for (let off = 0; off < bytes.length; off += MAX_PAYLOAD) {
    const chunk = bytes.subarray(off, off + MAX_PAYLOAD);
    const report = Buffer.alloc(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = CHANNEL_RPC;
    report[2] = chunk.length;
    chunk.copy(report, HEADER_SIZE);
    reports.push(report);
  }
  return reports;
}

/**
 * Rebuilds newline-terminated messages that may span several reports.
 * macOS delivers numbered input reports with the report id as byte 0.
 * Bytes are buffered per channel so multibyte UTF-8 crossing a report
 * boundary decodes correctly.
 */
export class Reassembler {
  #buffers = new Map();

  /** @returns {{channel: number, message: string}[]} */
  push(data) {
    if (data.length < HEADER_SIZE || data[0] !== REPORT_ID) return [];
    const channel = data[1];
    const length = data[2];
    // A declared length past the report would pull in zero padding and
    // poison the next message on that channel.
    if (length > MAX_PAYLOAD || HEADER_SIZE + length > data.length) return [];
    const payload = data.subarray(HEADER_SIZE, HEADER_SIZE + length);
    let buffer = Buffer.concat([this.#buffers.get(channel) ?? Buffer.alloc(0), payload]);
    const messages = [];
    let newline;
    while ((newline = buffer.indexOf(0x0a)) !== -1) {
      messages.push({ channel, message: buffer.subarray(0, newline).toString("utf8") });
      buffer = buffer.subarray(newline + 1);
    }
    this.#buffers.set(channel, buffer.length > MAX_BUFFERED ? Buffer.alloc(0) : buffer);
    return messages;
  }

  reset() {
    this.#buffers.clear();
  }
}
