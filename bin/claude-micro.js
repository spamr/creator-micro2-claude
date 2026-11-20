#!/usr/bin/env node
// claude-micro: drive Claude from a Work Louder Creator Micro 2.
//   claude-micro run            start the helper in the foreground
//   claude-micro probe [colour] print raw pad events, set the ring colour
//   claude-micro front          print the frontmost app's bundle id
//   claude-micro config         print the parsed key map
import { frontmostApp } from "../src/tapkey.js";

const [command = "help", ...rest] = process.argv.slice(2);

switch (command) {
  case "run": {
    const { Daemon } = await import("../src/daemon.js");
    const daemon = new Daemon();
    const shutdown = () => void daemon.stop().finally(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await daemon.start();
    break;
  }
  case "doctor": {
    const { run } = await import("../src/doctor.js");
    process.exit((await run()) ? 0 : 1);
  }
  case "agent": {
    const agent = await import("../src/agent.js");
    const sub = rest[0] ?? "status";
    if (sub === "install") {
      const r = agent.install();
      console.log(`login item installed: ${r.plist}\nruns ${r.node}; log at ${r.log}`);
    } else if (sub === "uninstall") {
      agent.uninstall();
      console.log("login item removed");
    } else if (sub === "plist") {
      process.stdout.write(agent.plist());
    } else {
      console.log(JSON.stringify(agent.status()));
    }
    break;
  }
  case "cloud": {
    const { run } = await import("../src/cloud.js");
    await run(rest[0]);
    break;
  }
  case "remote": {
    const { run } = await import("../src/remote.js");
    await run(rest[0], rest[1]);
    break;
  }
  case "keys": {
    const { ask } = await import("../src/control.js");
    if (rest[0] === "free" && /^[1-6]$/.test(rest[1] ?? "")) {
      const reply = await ask(`free ${rest[1]}`);
      console.log(!reply ? "helper is not running" : reply.freed ? `key ${rest[1]} freed` : `key ${rest[1]} held no session`);
      break;
    }
    const status = await ask("status");
    if (!status) {
      console.log("helper is not running");
      break;
    }
    for (let key = 1; key <= 6; key++) {
      const s = status.sessions.find((x) => x.key === key);
      console.log(`key ${key}: ${s ? `${s.status.padEnd(7)} ${s.where.padEnd(7)} ${s.cwd}` : "free"}`);
    }
    break;
  }
  case "status": {
    const { ask } = await import("../src/control.js");
    const status = await ask("status");
    console.log(status ? JSON.stringify(status, null, 2) : "helper is not running");
    break;
  }
  case "stop": {
    const { ask } = await import("../src/control.js");
    const reply = await ask("stop");
    console.log(reply ? "helper stopping" : "helper is not running");
    break;
  }
  case "probe":
    process.argv = [process.argv[0], "probe", ...rest];
    await import("../src/probe.js");
    break;
  case "front":
    console.log(await frontmostApp());
    break;
  case "config": {
    const { loadConfig, BUTTON_INPUTS } = await import("../src/config.js");
    const { targets } = loadConfig();
    for (const [bundleId, target] of Object.entries(targets)) {
      console.log(`\n${target.name} (${bundleId})`);
      for (const input of BUTTON_INPUTS) console.log(`  ${input.padEnd(8)} ${target.buttons[input].label ?? "none"}`);
      for (const dir of ["up", "down", "left", "right"]) {
        const b = target.joystick[dir];
        if (b.kind !== "none") console.log(`  stick ${dir.padEnd(6)} ${b.label}`);
      }
    }
    break;
  }
  case "hooks": {
    const hooks = await import("../src/hooks.js");
    const sub = rest[0] ?? "diff";
    if (sub === "diff") hooks.printDiff();
    else if (sub === "install") {
      const { backup } = hooks.install();
      console.log(`hooks installed in ${hooks.SETTINGS_PATH}; original kept at ${backup}`);
    } else if (sub === "uninstall") {
      hooks.uninstall();
      console.log(`claude-micro hooks removed from ${hooks.SETTINGS_PATH}`);
    } else if (sub === "status") {
      console.log(hooks.installed() ? "hooks: installed" : "hooks: not installed");
    } else {
      console.log("usage: claude-micro hooks <diff|install|uninstall|status>");
      process.exit(2);
    }
    break;
  }
  default:
    console.log("usage: claude-micro <run|status|stop|keys [free N]|doctor|probe [colour]|front|config|hooks <diff|install|uninstall|status>|agent <install|uninstall|status>|remote <add|remove|list> [ssh-alias]|cloud <setup|test|repo-files|remote-install>>");
    process.exit(command === "help" ? 0 : 2);
}
