// The helper's main loop: keeps the pad connected, routes input to the
// controls, and yields the device while the ChatGPT desktop app runs.
import { watch, statSync } from "node:fs";
import { Keypad, KEY_COUNT, RING_OFF } from "./device.js";
import { Controls } from "./controls.js";
import { loadConfig, CONFIG_PATH } from "./config.js";
import { chatGptRunning } from "./chatgpt.js";
import { COLORS, ring, keyLight } from "./colors.js";
import { Sessions, STATUS_LIGHT } from "./sessions.js";
import { focusSession } from "./focus.js";
import { serve as serveControl } from "./control.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { accessibilityGranted } from "./tapkey.js";
import { loadRelay, subscribe as subscribeRelay } from "./relay.js";

const CHATGPT_POLL_MS = 3000;
// The pad falls back to its stored lighting after a power cycle or profile
// reload, so the lights are re-sent periodically as well as on change.
const RESYNC_MS = 30000;

export function createLogger(write = (line) => process.stdout.write(line + "\n")) {
  return (message) => write(`${new Date().toISOString()} ${message}`);
}

export class Daemon {
  #config;
  #yielded = false;
  #stopping = false;
  #timer = null;
  #configTimer = null;
  #resyncTimer = null;
  #control = null;
  #relay = null;
  #lastFocusAt = new Map();

  constructor(log = createLogger()) {
    this.log = log;
    this.#config = loadConfig();
    this.sessions = new Sessions(log, () => this.#config.keyOrder, () => this.#config.expireHours);
    this.sessions.on("change", () => this.#schedulePaint());
    this.controls = new Controls(() => this.#config, log, {
      onSessionAction: (action) => {
        const target = action === "urgent" ? this.sessions.mostUrgent() : this.sessions.neighbour(action === "next" ? 1 : -1);
        if (!target) {
          log(`session ${action}: no lit session`);
          return;
        }
        log(`session ${action}: key ${target.slot + 1} (${target.status})`);
        this.sessions.press(target.slot);
        void focusSession(target, log);
      },
      onAgentHold: (slot) => {
        if (!this.sessions.free(slot)) log(`agent key ${slot + 1} held: nothing to free`);
      },
      onAgentKey: (slot) => {
        // Opening a session is a navigation in the app; a second press within
        // two seconds only sends it through the same navigation again.
        const now = Date.now();
        if (now - (this.#lastFocusAt.get(slot) ?? 0) < 2000) {
          log(`agent key ${slot + 1}: pressed again within 2 s, ignored`);
          return;
        }
        this.#lastFocusAt.set(slot, now);
        const session = this.sessions.press(slot);
        if (!session) {
          log(`agent key ${slot + 1}: no session on this key`);
          return;
        }
        void focusSession(session, log);
      },
    });
    this.keypad = new Keypad(
      {
        onStateChange: (state) => log(`device state: ${state}`),
        onConnect: async () => {
          const version = await this.keypad.firmwareVersion();
          log(`firmware ${version ?? "unknown"}`);
          await this.paint();
        },
        onDisconnect: () => void this.controls.resetInputState(),
        onHid: (key, act) => this.controls.onHid(key, act),
        onJoystick: (a, d) => this.controls.onJoystick(a, d),
        onRaw: (channel, message) => {
          // Replies (ours or another tool's on the same pad) carry "result"; only notifications matter here.
          if (/"result"|host\.focused_app/.test(message)) return;
          log(`unhandled device message (ch${channel}): ${message}`);
        },
      },
      log,
    );
  }

  #paintTimer = null;
  #schedulePaint() {
    clearTimeout(this.#paintTimer);
    this.#paintTimer = setTimeout(() => void this.paint(), 80);
  }

  /** Keys show their sessions. The ring breathes at full brightness while any
   *  session works or needs you, else follows the focused session at half
   *  brightness, or glows dim white when no session is known. */
  async paint() {
    if (!this.keypad.connected) return;
    await this.keypad.setKeyLights(this.sessions.keyLights()).catch(() => {});
    const status = this.sessions.ringStatus();
    const light = status ? STATUS_LIGHT[status] : null;
    const loud = status === "working" || status === "needs";
    const ambient = light ? { e: light.e, b: loud ? 1 : 0.5, s: light.s, m: 0, c: light.c } : ring(COLORS.white, 0.15);
    await this.keypad.setRing(ambient).catch(() => {});
  }

  async clearLights() {
    if (!this.keypad.connected) return;
    await this.keypad.setKeyLights(Array.from({ length: KEY_COUNT }, (_, id) => keyLight(id, 0))).catch(() => {});
    await this.keypad.setRing(RING_OFF).catch(() => {});
  }

  async start() {
    this.log(`claude-micro starting; config ${CONFIG_PATH}`);
    this.#control = await serveControl({
      status: () => ({
        pid: process.pid,
        device: this.keypad.state,
        product: this.keypad.info?.product ?? null,
        yieldedToChatGpt: this.#yielded,
        sessions: [...this.sessions.sessions.values()].map((s) => ({ key: s.slot + 1, status: s.status, cwd: s.cwd, where: s.cloud ? "cloud" : s.host ? "desktop" : s.iterm ? "iterm" : "unknown" })),
        focused: this.sessions.focused,
        relay: this.#relay ? { ...this.#relay.state } : null,
      }),
      stop: async () => {
        setTimeout(() => void this.stop().finally(() => process.exit(0)), 50);
        return { stopping: true };
      },
      free: (slot) => ({ freed: this.sessions.free(slot) }),
    });
    if (!this.#control) {
      this.log("another claude-micro is already running on this machine; exiting");
      process.exit(3);
    }
    // Ask macOS for Accessibility from this process, so the system dialog
    // (and the entry it adds to the Accessibility list) belongs to whatever
    // runs the helper: the terminal app, or node under the login item.
    if (!(await accessibilityGranted())) {
      this.log("accessibility not granted to this process; asking macOS (System Settings > Privacy & Security > Accessibility)");
      spawn(fileURLToPath(new URL("../bin/tapkey", import.meta.url)), ["prompt"], { stdio: "ignore" }).on("error", () => {});
    }
    this.log(`targets: ${Object.values(this.#config.targets).map((t) => t.name).join(", ")}`);
    this.#watchConfig();
    this.sessions.start();
    const relay = loadRelay();
    if (relay?.topic) this.#relay = subscribeRelay(relay, (m) => this.sessions.ingestRelay(m), this.log);
    void this.#pollChatGpt();
    this.#timer = setInterval(() => void this.#pollChatGpt(), CHATGPT_POLL_MS);
    this.#resyncTimer = setInterval(() => {
      this.sessions.expire();
      void this.paint();
    }, RESYNC_MS);
  }

  async stop() {
    if (this.#stopping) return;
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#configTimer) clearInterval(this.#configTimer);
    if (this.#resyncTimer) clearInterval(this.#resyncTimer);
    this.sessions.stop();
    this.#relay?.stop();
    if (this.#control) this.#control.close();
    await this.controls.resetInputState();
    await this.clearLights();
    await this.keypad.stop();
    this.log("stopped");
  }

  // Config edits apply live; an invalid file keeps the previous config.
  // fs.watch can miss an edit that replaces the file, so the mtime is also
  // polled every two seconds.
  #watchConfig() {
    let pending = null;
    let lastMtime = statSync(CONFIG_PATH).mtimeMs;
    const reload = () => {
      try {
        this.#config = loadConfig();
        this.log("config reloaded");
        this.sessions.reslot();
      } catch (e) {
        this.log(`config NOT reloaded: ${e.message}`);
      }
    };
    const schedule = () => {
      clearTimeout(pending);
      pending = setTimeout(reload, 300);
    };
    try {
      watch(CONFIG_PATH, schedule);
    } catch {}
    this.#configTimer = setInterval(() => {
      try {
        const mtime = statSync(CONFIG_PATH).mtimeMs;
        if (mtime !== lastMtime) {
          lastMtime = mtime;
          schedule();
        }
      } catch {}
    }, 2000);
  }

  async #pollChatGpt() {
    if (this.#stopping) return;
    const running = await chatGptRunning();
    if (running && !this.#yielded) {
      this.#yielded = true;
      this.log("ChatGPT app is running: yielding the pad to it");
      await this.controls.resetInputState();
      await this.clearLights();
      await this.keypad.stop();
    } else if (!running && (this.#yielded || this.keypad.state === "stopped")) {
      if (this.#yielded) this.log("ChatGPT app quit: reclaiming the pad");
      this.#yielded = false;
      this.keypad.start();
    }
  }
}
