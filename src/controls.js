// Turns pad input into actions. The six agent keys (AG00-AG05) are reported
// to the owner (session focus comes with the status-light step); every other
// input runs the binding configured for whichever target app is frontmost.
// Key bindings tap by default or mirror press/release when "hold" is set.
//
// Joystick sweep model and hold bookkeeping adapted from
// alasano/house-of-herdr packages/codex-micro/src/controls.ts (MIT).
import { spawn } from "node:child_process";
import { frontmostApp, postKey, postScroll } from "./tapkey.js";

const DEBOUNCE_MS = 150;
// A held key auto-repeats as press/release pairs ~150 ms apart. A release
// followed by a press of the same key inside this window is one long hold.
const HOLD_GRACE_MS = 260;
// Holding an agent key this long frees it instead of opening its session.
const AGENT_HOLD_MS = 1200;
const ENGAGE_DISTANCE = 0.75;
const RELEASE_DISTANCE = 0.3;
// Angle is a 0..1 turn clockwise from east; sector centres at 0, .25, .5, .75.
const SECTOR_DIRECTIONS = ["right", "down", "left", "up"];

export class Controls {
  // input name -> { combo, allow } held right now; release resolves through
  // this, never through the current config, so a reload can't strand a key.
  #held = new Map();
  #lastSector = null;
  // Temporary dial re-binding opened by a binding with "menu"; expires on idle.
  #menu = null;
  // Last accepted press per key: the pad occasionally reports one press as
  // several within a few tens of milliseconds, far faster than a finger.
  #lastPress = new Map();
  // Keys currently held, so a repeat while held never counts as a new press.
  #down = new Set();
  // Releases waiting out the grace period: key -> timer.
  #pendingRelease = new Map();

  // Agent key in progress: { slot, holdTimer, finalizeTimer, consumed }.
  #agent = null;

  constructor(getConfig, log, { onAgentKey = () => {}, onAgentHold = () => {} } = {}) {
    this.getConfig = getConfig;
    this.log = log;
    this.onAgentKey = onAgentKey;
    this.onAgentHold = onAgentHold;
  }

  onHid(key, act) {
    this.#dispatchHid(key, act).catch((e) => this.log(`input ${key} failed: ${e.message}`));
  }

  onJoystick(angle, distance) {
    this.#dispatchJoystick(angle, distance).catch((e) => this.log(`joystick failed: ${e.message}`));
  }

  /** Release anything still held (device gone, shutdown, ChatGPT takeover). */
  // A short press fires on release; holding for AGENT_HOLD_MS fires the hold
  // action instead. The pad repeats a held key as press/release pairs, so a
  // release only counts once no re-press follows within the grace period.
  #agentKey(slot, act) {
    const current = this.#agent;
    if (act === 1) {
      if (current && current.slot === slot && current.finalizeTimer) {
        clearTimeout(current.finalizeTimer);
        current.finalizeTimer = null;
        return;
      }
      if (current) this.#agentFinish(current);
      const entry = { slot, finalizeTimer: null, consumed: false };
      entry.holdTimer = setTimeout(() => {
        entry.consumed = true;
        this.onAgentHold(slot);
      }, AGENT_HOLD_MS);
      this.#agent = entry;
      return;
    }
    if (act === 0 && current && current.slot === slot && !current.finalizeTimer) {
      current.finalizeTimer = setTimeout(() => this.#agentFinish(current), HOLD_GRACE_MS);
    }
  }

  #agentFinish(entry) {
    clearTimeout(entry.holdTimer);
    clearTimeout(entry.finalizeTimer);
    if (this.#agent === entry) this.#agent = null;
    if (!entry.consumed) this.onAgentKey(entry.slot);
  }

  async #release(key) {
    this.#down.delete(key);
    const held = this.#held.get(key);
    if (!held) return;
    this.#held.delete(key);
    if (held.release) this.#exec(held.release);
    else await postKey(held.combo, "up", held.allow, this.log);
  }

  async resetInputState() {
    if (this.#agent) {
      clearTimeout(this.#agent.holdTimer);
      clearTimeout(this.#agent.finalizeTimer);
      this.#agent = null;
    }
    for (const timer of this.#pendingRelease.values()) clearTimeout(timer);
    this.#pendingRelease.clear();
    this.#down.clear();
    for (const [input, held] of this.#held) {
      this.#held.delete(input);
      if (held.release) this.#exec(held.release);
      else await postKey(held.combo, "up", held.allow, this.log);
    }
    this.#lastSector = null;
  }

  async #target() {
    const front = await frontmostApp();
    const target = this.getConfig().targets[front];
    return { front, target };
  }

  async #dispatchHid(key, act) {
    const agent = /^AG0([0-5])$/.exec(key);
    if (agent) {
      this.#agentKey(Number(agent[1]), act);
      return;
    }
    if (act === 0) {
      if (this.#pendingRelease.has(key)) return;
      const timer = setTimeout(() => {
        this.#pendingRelease.delete(key);
        void this.#release(key);
      }, HOLD_GRACE_MS);
      this.#pendingRelease.set(key, timer);
      return;
    }
    // A press arriving while its release is in the grace period is the
    // pad repeating a held key: swallow it and keep holding.
    const pending = this.#pendingRelease.get(key);
    if (pending) {
      clearTimeout(pending);
      this.#pendingRelease.delete(key);
      return;
    }
    // Dial turns report act 2 per detent and never a release. Keys report
    // act 1 on press and act 0 on release; anything else from a key (a
    // long-hold code, a repeat) is logged and ignored.
    const isDial = key === "ENC_CW" || key === "ENC_CC";
    if (isDial ? act !== 2 : act !== 1) {
      this.log(`${key}: act=${act} ignored`);
      return;
    }
    if (!isDial) {
      const now = Date.now();
      if (this.#down.has(key)) {
        this.log(`${key}: repeat while held, ignored`);
        return;
      }
      this.#down.add(key);
      const last = this.#lastPress.get(key) ?? 0;
      this.#lastPress.set(key, now);
      if (now - last < DEBOUNCE_MS) {
        this.log(`${key}: repeat ${now - last}ms after the last press, ignored`);
        return;
      }
    }
    const { front, target } = await this.#target();
    if (!target) {
      this.log(`${key}: ignored, frontmost app is ${front || "unknown"} (not a configured target)`);
      return;
    }
    const menu = this.#activeMenu(key);
    if (menu) {
      await this.#run(key, menu, target, front);
      return;
    }
    await this.#run(key, target.buttons[key], target, front);
  }

  // Returns the menu binding for this input while a menu is open, refreshing
  // its timer; the dial click inside a menu both runs and closes it.
  #activeMenu(input) {
    const menu = this.#menu;
    if (!menu) return null;
    if (Date.now() > menu.until || !(input in menu.bindings)) {
      if (Date.now() > menu.until) this.#menu = null;
      return null;
    }
    if (input === "ENC_CLK") this.#menu = null;
    else menu.until = Date.now() + menu.timeoutMs;
    return menu.bindings[input];
  }

  async #run(input, binding, target, front) {
    if (!binding || binding.kind === "none") return;
    const allow = [front];
    this.log(`${input} -> ${binding.label} (${target.name})`);
    if (binding.menu) {
      // The app shortcut toggles its menu, so a second press of the same key
      // closes it: drop the dial re-binding too instead of starting it again.
      if (this.#menu && this.#menu.owner === input && Date.now() <= this.#menu.until) {
        this.#menu = null;
        this.log("dial menu closed");
      } else {
        this.#menu = { owner: input, bindings: binding.menu, timeoutMs: binding.menuTimeoutMs, until: Date.now() + binding.menuTimeoutMs };
        this.log(`dial menu open for ${binding.menuTimeoutMs / 1000}s: ${Object.entries(binding.menu).map(([i, b]) => `${i}=${b.label ?? "none"}`).join(", ")}`);
      }
    }
    if (binding.kind === "key") {
      if (binding.hold) {
        this.#held.set(input, { combo: binding.combo, allow });
        await postKey(binding.combo, "down", allow, this.log);
      } else {
        await postKey(binding.combo, "tap", allow, this.log);
      }
    } else if (binding.kind === "scroll") {
      await postScroll(binding.lines, this.log, binding.target);
    } else if (binding.kind === "exec") {
      if (binding.release) this.#held.set(input, { release: binding.release });
      this.#exec(binding.argv);
    }
  }

  #exec(argv) {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", (e) => this.log(`exec ${cmd} failed: ${e.message}`));
    child.unref();
  }

  async #dispatchJoystick(angle, distance) {
    if (distance < RELEASE_DISTANCE) {
      this.#lastSector = null;
      return;
    }
    if (distance < ENGAGE_DISTANCE && this.#lastSector === null) return;
    const sector = Math.round(angle * 4) % 4;
    if (sector === this.#lastSector) return;
    this.#lastSector = sector;
    const { front, target } = await this.#target();
    if (!target) return;
    const direction = SECTOR_DIRECTIONS[sector];
    await this.#run(`joystick.${direction}`, target.joystick[direction], target, front);
  }
}
