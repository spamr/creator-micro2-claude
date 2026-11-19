// Connection to the keypad: discovery, fire-and-forget vendor RPC, input
// notifications, firmware query and reconnect. The ChatGPT desktop app opens
// the device exclusively while it runs, so open failures are expected and
// retried; quitting ChatGPT hands the device over on the next retry.
//
// Adapted from alasano/house-of-herdr packages/codex-micro/src/device.ts
// (MIT, Copyright (c) 2026 Aljosa Asanovic), including the Creator Micro 2
// product ids and macOS 26 error codes from that repository's pull request 4
// by malud. See THIRD_PARTY.md.
import { HIDAsync, devicesAsync } from "node-hid";
import { CHANNEL_RPC, Reassembler, encodeMessage } from "./framing.js";

export const VENDOR_ID = 0x303a; // Espressif
// Codex Micro (OpenAI edition), then the Creator Micro 2 over USB and over
// Bluetooth. The order is the connect preference if several are present.
export const PRODUCT_IDS = [0x8360, 0x8297, 0x8298];
export const USAGE_PAGE = 0xff00; // the vendor (RPC) interface
export const MIN_FIRMWARE = [0, 6, 3];
const RECONNECT_MIN_MS = 1000;
const RECONNECT_JITTER_MS = 1000;
const STATUS_REQUEST_ID = 7;

export const EFFECT = { off: 0, solid: 1, breath: 4 };
export const KEY_COUNT = 6;
export const RING_OFF = { e: 0, b: 0, s: 0, m: 0, c: 0 };

export function productName(productId) {
  return productId === 0x8360 ? "Codex Micro" : "Creator Micro 2";
}

/**
 * Maps IOKit open failures to actionable states. 0xE00002C1 (privilege
 * violation) and 0xE00002E2 (not permitted, macOS 26) mean Input Monitoring
 * is missing; 0xE00002C5 (exclusive access) means another host, in practice
 * the ChatGPT app, holds the device.
 */
export function classifyOpenError(message) {
  if (/privilege violation|E00002C1|not permitted|E00002E2/i.test(message)) return "permission_required";
  if (/exclusive access|E00002C5/i.test(message)) return "device_busy";
  if (/device not found/i.test(message)) return "device_absent";
  return "connecting";
}

export async function findCandidates() {
  const devices = await devicesAsync();
  return devices
    .filter((d) => d.vendorId === VENDOR_ID && PRODUCT_IDS.includes(d.productId) && d.usagePage === USAGE_PAGE && d.path)
    .sort((a, b) => PRODUCT_IDS.indexOf(a.productId) - PRODUCT_IDS.indexOf(b.productId));
}

/** "0.6.3", "v0.6.3" or "0.7.0-rc.16" -> [0, 6, 3]; null if unrecognised. */
export function parseFirmwareVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  return match ? match.slice(1).map(Number) : null;
}

export function firmwareSupported(parsed) {
  for (let i = 0; i < MIN_FIRMWARE.length; i++) {
    if (parsed[i] !== MIN_FIRMWARE[i]) return parsed[i] > MIN_FIRMWARE[i];
  }
  return true;
}

// The reply to device.status carries the version under one of a few names;
// fall back to the whole result so an unexpected shape is still visible.
function statusReplyVersion(parsed) {
  const r = parsed?.result;
  if (!r || typeof r !== "object") return null;
  const version = r.fw ?? r.firmware ?? r.version ?? r.fw_version ?? r.firmware_version;
  return typeof version === "string" ? version : JSON.stringify(r);
}

/**
 * Handlers: onConnect(info), onDisconnect(), onStateChange(state),
 * onHid(key, act) with act 1 = press, 0 = release, 2 = dial detent, onJoystick(angle, distance),
 * onRaw(channel, message) for anything else (optional).
 */
export class Keypad {
  #device = null;
  #info = null;
  #reassembler = new Reassembler();
  #generation = 0;
  #stopped = true;
  #connecting = false;
  #retryTimer = null;
  #writeQueue = Promise.resolve();
  #state = "stopped";
  #lastOpenFailure = "";
  #pendingStatus = null;

  constructor(handlers, log = () => {}) {
    this.handlers = handlers;
    this.log = log;
  }

  get connected() {
    return this.#device !== null;
  }

  get state() {
    return this.#state;
  }

  get info() {
    return this.#info;
  }

  /** Idempotent: a no-op while connected or already connecting. */
  start() {
    if (!this.#stopped && (this.#device || this.#connecting)) return;
    this.#stopped = false;
    this.#clearRetry();
    this.#setState("connecting");
    void this.#connect();
  }

  async stop() {
    this.#stopped = true;
    this.#generation++;
    this.#clearRetry();
    await this.#disconnect();
    this.#setState("stopped");
  }

  /** Six key lights: [{id, c: 0xRRGGBB, b: 0..1, e: EFFECT.*, s: 0..1}]. */
  setKeyLights(slots) {
    return this.#send("v.oai.thstatus", slots);
  }

  /** Ring light: {e, b, s, m, c}. The keys side stays off: setKeyLights owns the keys. */
  setRing(ambient) {
    return this.#send("v.oai.rgbcfg", { ambient, keys: { e: 0, b: 0, s: 0, m: 0, c: 0 } });
  }

  /**
   * Query the firmware version on the live connection; null when no reply
   * arrives in time. The reply comes back through the one data listener
   * (node-hid allows a single read loop per handle), matched by request id.
   */
  firmwareVersion(timeoutMs = 1500) {
    if (!this.#device) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingStatus = null;
        resolve(null);
      }, timeoutMs);
      this.#pendingStatus = (version) => {
        clearTimeout(timer);
        this.#pendingStatus = null;
        resolve(version);
      };
      this.#sendRaw({ method: "device.status", params: null, id: STATUS_REQUEST_ID }).catch(() => {
        this.#pendingStatus?.(null);
      });
    });
  }

  #setState(state) {
    if (state === this.#state) return;
    this.#state = state;
    this.handlers.onStateChange?.(state);
  }

  // Fire-and-forget (the firmware acknowledges with {"result":{"ok":1}}),
  // serialised through a write queue so multi-report frames never interleave.
  #send(method, params) {
    return this.#sendRaw({ method, params });
  }

  #sendRaw(envelope) {
    // Bind to the handle live when the write was queued: a frame composed for
    // the old connection must not be delivered on a new one after a reconnect.
    const target = this.#device;
    const generation = this.#generation;
    const result = this.#writeQueue.then(async () => {
      if (!target || this.#device !== target || this.#generation !== generation) {
        throw new Error("device not connected");
      }
      for (const report of encodeMessage(JSON.stringify(envelope))) {
        await target.write(report);
      }
    });
    this.#writeQueue = result.catch(() => {});
    return result;
  }

  async #connect() {
    if (this.#stopped || this.#device || this.#connecting) return;
    this.#connecting = true;
    const generation = ++this.#generation;
    try {
      const candidates = await findCandidates();
      if (candidates.length === 0) throw new Error("device not found");
      let opened = null;
      let openedInfo = null;
      let lastError = null;
      for (const info of candidates) {
        try {
          opened = await HIDAsync.open(info.path, { nonExclusive: true });
          openedInfo = info;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!opened) throw lastError ?? new Error("no candidate opened");
      if (this.#stopped || this.#generation !== generation) {
        await opened.close().catch(() => {});
        return;
      }
      opened.on("data", (data) => this.#onData(data));
      opened.on("error", (error) => {
        // node-hid reports a vanished Bluetooth link with an empty error.
        const detail = error?.message || (typeof error === "string" ? error : "") || "connection lost";
        this.log(`device error: ${detail}`);
        void this.#dropAndRetry();
      });
      this.#device = opened;
      this.#info = openedInfo;
      this.#lastOpenFailure = "";
      this.#setState("connected");
      this.log(`device connected: ${productName(openedInfo.productId)} (${openedInfo.product ?? ""})`);
      this.handlers.onConnect?.(openedInfo);
    } catch (error) {
      if (this.#stopped || this.#generation !== generation) return;
      const message = error.message;
      if (message !== this.#lastOpenFailure) {
        this.#lastOpenFailure = message;
        this.log(`device open failed: ${message}`);
      }
      this.#setState(classifyOpenError(message));
      this.#scheduleRetry();
    } finally {
      this.#connecting = false;
    }
  }

  #clearRetry() {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #scheduleRetry() {
    if (this.#stopped) return;
    const delay = RECONNECT_MIN_MS + Math.random() * RECONNECT_JITTER_MS;
    this.#retryTimer = setTimeout(() => void this.#connect(), delay);
  }

  async #dropAndRetry() {
    await this.#disconnect();
    if (this.#stopped) return;
    this.#setState("connecting");
    this.#scheduleRetry();
  }

  async #disconnect() {
    const device = this.#device;
    this.#device = null;
    this.#info = null;
    this.#reassembler.reset();
    if (!device) return;
    device.removeAllListeners("data");
    device.removeAllListeners("error");
    await device.close().catch(() => {});
    this.handlers.onDisconnect?.();
  }

  #onData(data) {
    for (const { channel, message } of this.#reassembler.push(data)) {
      if (channel !== CHANNEL_RPC) {
        this.handlers.onRaw?.(channel, message);
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch {
        this.handlers.onRaw?.(channel, message);
        continue;
      }
      if (parsed.id === STATUS_REQUEST_ID && this.#pendingStatus) {
        this.#pendingStatus(statusReplyVersion(parsed));
        continue;
      }
      // Compact {m,p} for notifications, long {method,params} for responses.
      const method = parsed.method ?? parsed.m;
      const params = parsed.params ?? parsed.p;
      if (method === "v.oai.hid" && params) {
        this.handlers.onHid?.(String(params.k ?? ""), Number(params.act ?? 0));
      } else if (method === "v.oai.rad" && params) {
        this.handlers.onJoystick?.(Number(params.a ?? 0), Number(params.d ?? 0));
      } else {
        this.handlers.onRaw?.(channel, message);
      }
    }
  }
}
