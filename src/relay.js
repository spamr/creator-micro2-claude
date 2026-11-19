// Cloud sessions run on Anthropic's machines, where no hook can reach this
// Mac. They report through a relay instead: the cloud-side hook publishes a
// tiny JSON message to an ntfy topic, and this subscriber streams the topic
// and feeds each message to the session table as if it were a local hook.
// The topic name is a long random secret, generated once into state/relay.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { STATE_DIR } from "./sessions.js";

export const RELAY_PATH = STATE_DIR + "relay.json";
const DEFAULT_SERVER = "https://ntfy.sh";
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60000;

export function loadRelay() {
  if (!existsSync(RELAY_PATH)) return null;
  try {
    return JSON.parse(readFileSync(RELAY_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** Create the relay config with a fresh random topic (idempotent). */
export function ensureRelay(server = DEFAULT_SERVER) {
  const existing = loadRelay();
  if (existing?.topic) return existing;
  const relay = { server, topic: `claude-micro-${randomBytes(16).toString("hex")}` };
  writeFileSync(RELAY_PATH, JSON.stringify(relay, null, 2) + "\n");
  return relay;
}

export const publishUrl = (relay) => `${relay.server.replace(/\/$/, "")}/${relay.topic}`;
const streamUrl = (relay) => `${publishUrl(relay)}/json`;

/** Publish one event (used by `cloud test`; the real sender is the cloud hook). */
export async function publish(relay, event) {
  const res = await fetch(publishUrl(relay), { method: "POST", body: JSON.stringify(event), headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`relay publish failed: ${res.status}`);
}

/**
 * Streams the topic forever, reconnecting with backoff. onEvent receives the
 * parsed payload {sid, ev, repo, nt?, t}. Returns a stop function.
 */
export function subscribe(relay, onEvent, log) {
  let stopped = false;
  let controller = null;
  let delay = RETRY_MIN_MS;
  const state = { connected: false, lastMessageAt: null, lastError: null };

  (async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(streamUrl(relay), { signal: controller.signal, headers: { Accept: "application/x-ndjson" } });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        state.connected = true;
        state.lastError = null;
        delay = RETRY_MIN_MS;
        log(`relay connected: ${relay.server} topic …${relay.topic.slice(-6)}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            let frame;
            try {
              frame = JSON.parse(line);
            } catch {
              continue;
            }
            if (frame.event !== "message" || typeof frame.message !== "string") continue;
            state.lastMessageAt = Date.now();
            try {
              onEvent(JSON.parse(frame.message));
            } catch (e) {
              log(`relay: ignored message that is not JSON (${e.message})`);
            }
          }
        }
        throw new Error("stream ended");
      } catch (e) {
        if (stopped) break;
        state.connected = false;
        state.lastError = e.message;
        log(`relay disconnected (${e.message}); retrying in ${Math.round(delay / 1000)} s`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
  })();

  return {
    state,
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
