// Claude Code sessions on the six agent keys. Hook events arrive as lines in
// state/events.jsonl (written by hooks/claude-micro-hook.sh). Each live
// session takes the first free key and keeps it (sticky), so lights never
// shuffle under your fingers. Key colours: working = breathing blue,
// done = green, needs you = amber, idle = dim white, free = off.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, watch, writeFileSync, readFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KEY_COUNT, EFFECT } from "./device.js";
import { COLORS, keyLight } from "./colors.js";

export const STATE_DIR = fileURLToPath(new URL("../state/", import.meta.url));
export const EVENTS_PATH = STATE_DIR + "events.jsonl";
// Sessions survive a helper restart: saved on every change, loaded at start.
export const SESSIONS_PATH = STATE_DIR + "sessions.json";
const ROTATE_BYTES = 1024 * 1024;
const DEFAULT_EXPIRE_HOURS = 4; // a finished or idle session silent this long gives its key back

export const STATUS_LIGHT = {
  // Pure blue: any green component shows at the dim end of the breath.
  working: { c: 0x0000ff, b: 1, e: EFFECT.breath, s: 0.35 },
  done: { c: COLORS.green, b: 1, e: EFFECT.solid, s: 0 },
  // Needs you: deep red, breathing fast, unmistakable next to green and blue.
  needs: { c: 0xff0000, b: 1, e: EFFECT.breath, s: 0.7 },
  // Seen: dim white, which these LEDs render as a soft warm glow.
  idle: { c: COLORS.white, b: 0.2, e: EFFECT.solid, s: 0 },
};

// Hook event -> status. Anything else only refreshes "last seen".
const EVENT_STATUS = {
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "done",
  Notification: "needs",
};

const URGENCY = { needs: 3, working: 2, done: 1, idle: 0 };

export class Sessions extends EventEmitter {
  /** session id -> { id, slot, status, cwd, host, iterm, term, seen } */
  sessions = new Map();
  /** session id of the one the ring follows: last submitted to or last key pressed. */
  focused = null;
  #offset = 0;
  #timer = null;

  constructor(log, keyOrder = () => [0, 1, 2, 3, 4, 5], expireHours = () => DEFAULT_EXPIRE_HOURS) {
    super();
    this.log = log;
    this.keyOrder = keyOrder;
    this.expireHours = expireHours;
  }

  /** Give a key back by hand (long press, or `claude-micro keys free N`). */
  free(slot) {
    const s = this.bySlot(slot);
    if (!s) return false;
    this.sessions.delete(s.id);
    if (this.focused === s.id) this.focused = null;
    this.log(`key ${slot + 1} freed (session ${short(s.id)}, ${s.cwd || "no cwd"})`);
    this.emit("change");
    return true;
  }

  start() {
    mkdirSync(STATE_DIR, { recursive: true });
    if (!existsSync(EVENTS_PATH)) writeFileSync(EVENTS_PATH, "");
    this.#load();
    this.reslot();
    this.on("change", () => this.#save());
    // Start at the end: old events describe sessions that may be long gone.
    this.#offset = statSync(EVENTS_PATH).size;
    try {
      watch(EVENTS_PATH, () => this.#drain());
    } catch {}
    this.#timer = setInterval(() => this.#drain(), 1000);
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#save();
  }

  #save() {
    try {
      writeFileSync(SESSIONS_PATH, JSON.stringify({ focused: this.focused, sessions: [...this.sessions.values()] }));
    } catch {}
  }

  #load() {
    try {
      const saved = JSON.parse(readFileSync(SESSIONS_PATH, "utf8"));
      const now = Date.now();
      for (const s of saved.sessions ?? []) {
        if (now - s.seen > this.expireHours() * 60 * 60 * 1000) continue;
        // Whatever was "working" when the helper stopped may have finished since.
        if (s.status === "working") s.status = "idle";
        this.sessions.set(s.id, s);
      }
      this.focused = saved.focused && this.sessions.has(saved.focused) ? saved.focused : null;
      if (this.sessions.size) this.log(`restored ${this.sessions.size} session(s) on their keys`);
    } catch {}
  }

  #drain() {
    let size;
    try {
      size = statSync(EVENTS_PATH).size;
    } catch {
      return;
    }
    if (size < this.#offset) this.#offset = 0; // rotated or truncated
    if (size === this.#offset) return;
    const fd = openSync(EVENTS_PATH, "r");
    try {
      const buf = Buffer.alloc(size - this.#offset);
      readSync(fd, buf, 0, buf.length, this.#offset);
      const text = buf.toString("utf8");
      const end = text.lastIndexOf("\n");
      if (end === -1) return; // partial line, wait for the rest
      this.#offset += Buffer.byteLength(text.slice(0, end + 1));
      for (const line of text.slice(0, end).split("\n")) if (line.trim()) this.#ingest(line);
    } finally {
      closeSync(fd);
    }
    if (size > ROTATE_BYTES) this.#rotate();
  }

  #rotate() {
    try {
      renameSync(EVENTS_PATH, EVENTS_PATH + ".old");
      writeFileSync(EVENTS_PATH, "");
      this.#offset = 0;
    } catch {}
  }

  /** A relay message {sid, ev, nt, repo, cloud} becomes a hook-shaped event. */
  ingestRelay(message) {
    if (!message || typeof message !== "object" || !message.sid || !message.ev) return;
    const where = [message.host, message.repo].filter(Boolean).join(":");
    this.#apply({
      t: message.t,
      cloud: true,
      bridge: message.bridge || "",
      hook: { session_id: message.sid, hook_event_name: message.ev, notification_type: message.nt, cwd: where ? `remote:${where}` : "remote" },
    });
  }

  #ingest(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    this.#apply(event);
  }

  #apply(event) {
    const hook = event.hook ?? {};
    const id = hook.session_id;
    const name = hook.hook_event_name;
    if (!id || !name) return;
    const now = Date.now();
    if (name === "SessionEnd") {
      if (this.sessions.delete(id)) this.log(`session ${short(id)} ended, key freed`);
      if (this.focused === id) this.focused = null;
      this.emit("change");
      return;
    }
    let session = this.sessions.get(id);
    if (!session) {
      const slot = this.#freeSlot(now);
      if (slot === null) {
        this.log(`session ${short(id)} started but all six keys are busy`);
        return;
      }
      session = { id, slot, status: "idle", cwd: hook.cwd ?? "", host: "", iterm: "", term: "", cloud: event.cloud === true, seen: now };
      this.sessions.set(id, session);
      this.log(`session ${short(id)} -> key ${slot + 1} (${session.cwd || "no cwd"})`);
    }
    if (event.host) session.host = event.host;
    if (event.bridge) session.bridge = event.bridge;
    if (event.iterm) session.iterm = event.iterm;
    if (event.term) session.term = event.term;
    if (hook.cwd) session.cwd = hook.cwd;
    session.seen = now;
    let status = EVENT_STATUS[name];
    if (name === "Notification") {
      // Only a permission prompt or a question needs you. Claude Code also
      // sends an "idle" reminder a while after finishing; that changes nothing.
      const type = hook.notification_type || "";
      if (type.startsWith("idle")) status = undefined;
    }
    if (status && status !== session.status) {
      session.status = status;
      const why = name === "Notification" ? ` (${hook.notification_type || "notification"}${hook.message ? `: ${hook.message}` : ""})` : "";
      this.log(`session ${short(id)} key ${session.slot + 1}: ${status}${why}`);
    }
    if (name === "UserPromptSubmit") this.focused = id;
    this.emit("change");
  }

  // First free key; otherwise take the key of the stalest finished/idle
  // session, never one that is working or waiting for you.
  #freeSlot(now) {
    const used = new Set([...this.sessions.values()].map((s) => s.slot));
    for (const slot of this.keyOrder()) if (!used.has(slot)) return slot;
    const victims = [...this.sessions.values()]
      .filter((s) => s.status === "done" || s.status === "idle")
      .sort((a, b) => a.seen - b.seen);
    const oldest = victims[0];
    if (!oldest || now - oldest.seen < 60 * 1000) return null;
    this.sessions.delete(oldest.id);
    this.log(`session ${short(oldest.id)} evicted from key ${oldest.slot + 1}`);
    return oldest.slot;
  }

  /** Move sessions off keys that the config no longer allows. */
  reslot() {
    const allowed = this.keyOrder();
    let changed = false;
    for (const s of [...this.sessions.values()].sort((a, b) => b.seen - a.seen)) {
      if (allowed.includes(s.slot)) continue;
      const used = new Set([...this.sessions.values()].map((x) => x.slot));
      const free = allowed.find((slot) => !used.has(slot));
      if (free === undefined) {
        this.log(`session ${short(s.id)} stays on key ${s.slot + 1}: no allowed key is free`);
        continue;
      }
      this.log(`session ${short(s.id)} moved from key ${s.slot + 1} to key ${free + 1}`);
      s.slot = free;
      changed = true;
    }
    if (changed) this.emit("change");
    return changed;
  }

  /** Drop sessions silent for a long time. Returns true if anything changed. */
  expire() {
    const now = Date.now();
    let changed = false;
    const limit = this.expireHours() * 60 * 60 * 1000;
    for (const [id, s] of this.sessions) {
      if (s.status !== "working" && now - s.seen > limit) {
        this.sessions.delete(id);
        this.log(`key ${s.slot + 1} freed: session ${short(id)} silent for ${this.expireHours()} h`);
        changed = true;
      }
    }
    if (changed) this.emit("change");
    return changed;
  }

  bySlot(slot) {
    for (const s of this.sessions.values()) if (s.slot === slot) return s;
    return null;
  }

  /** The lit session that most needs you: red first, then working, then done, newest first. */
  mostUrgent() {
    let best = null;
    for (const s of this.sessions.values()) {
      if (!best || URGENCY[s.status] > URGENCY[best.status] || (URGENCY[s.status] === URGENCY[best.status] && s.seen > best.seen)) best = s;
    }
    return best;
  }

  /** The next (+1) or previous (-1) lit session in key order, relative to the focused one. */
  neighbour(step) {
    const lit = [...this.sessions.values()].sort((a, b) => a.slot - b.slot);
    if (lit.length === 0) return null;
    const index = lit.findIndex((s) => s.id === this.focused);
    if (index === -1) return step > 0 ? lit[0] : lit[lit.length - 1];
    return lit[(index + step + lit.length) % lit.length];
  }

  /** Pressing a key marks a finished session as seen and makes it the focus. */
  press(slot) {
    const s = this.bySlot(slot);
    if (!s) return null;
    if (s.status === "done") s.status = "idle";
    this.focused = s.id;
    this.emit("change");
    return s;
  }

  keyLights() {
    return Array.from({ length: KEY_COUNT }, (_, slot) => {
      const s = this.bySlot(slot);
      if (!s) return keyLight(slot, 0);
      const l = STATUS_LIGHT[s.status];
      return { id: slot, c: l.c, b: l.b, e: l.e, s: l.s };
    });
  }

  /** Ring colour: the focused session's status, else the most urgent one. */
  ringStatus() {
    const focused = this.focused ? this.sessions.get(this.focused) : null;
    if (focused) return focused.status;
    let best = null;
    for (const s of this.sessions.values()) if (!best || URGENCY[s.status] > URGENCY[best.status]) best = s;
    return best?.status ?? null;
  }
}

const short = (id) => String(id).slice(0, 8);
