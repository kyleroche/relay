/**
 * The service file that keeps `relay work` running on a machine (docs/WORKERS.md "Run it as a service"): a LaunchAgent
 * on macOS (user context, so the vendor CLIs find their keychain logins), a systemd user unit on Linux. Pure: it
 * returns the path, the content and the commands; `relay work --install` prints them and writes with --yes.
 */
import { join } from "node:path";

export const SERVICE_LABEL = "house.kyro.relay.work";
export const SYSTEMD_UNIT = "relay-work.service";

export interface ServiceSpec {
  platform: "darwin" | "linux";
  /** The node binary and the argv that runs the relay CLI (`runtimePaths().cliArgv`). */
  node: string;
  cliArgv: string[];
  /** Extra `relay work` arguments baked into the service (`--lanes claude,codex`, `--jobs 2`). */
  args?: string[];
  /** relay's home: the log file lives there as work.log. */
  home: string;
  userHome: string;
  /** PATH the service runs with (the CLIs' install directories). */
  path: string;
  env?: Record<string, string>;
  uid?: number;
}

export interface ServicePlan {
  path: string;
  content: string;
  logPath: string;
  /** Shell words that start the service after the file is written. */
  load: string[][];
  /** Shell words that stop and forget it. */
  unload: string[][];
  /** Shell words that print whether it is loaded. */
  status: string[];
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function servicePlan(spec: ServiceSpec): ServicePlan {
  const logPath = join(spec.home, "work.log");
  const argv = [spec.node, ...spec.cliArgv, "work", ...(spec.args ?? [])];
  const env: Record<string, string> = { PATH: spec.path, HOME: spec.userHome, RELAY_HOME: spec.home, ...(spec.env ?? {}) };
  if (spec.platform === "darwin") {
    const uid = spec.uid ?? 501;
    const path = join(spec.userHome, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${SERVICE_LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...argv.map((a) => `    <string>${xml(a)}</string>`),
      "  </array>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      ...Object.entries(env).flatMap(([k, v]) => [`    <key>${xml(k)}</key><string>${xml(v)}</string>`]),
      "  </dict>",
      `  <key>WorkingDirectory</key><string>${xml(spec.userHome)}</string>`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      "  <key>ThrottleInterval</key><integer>30</integer>",
      "  <key>ProcessType</key><string>Background</string>",
      `  <key>StandardOutPath</key><string>${xml(logPath)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(logPath)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    return {
      path,
      content,
      logPath,
      load: [["launchctl", "bootstrap", `gui/${uid}`, path]],
      unload: [["launchctl", "bootout", `gui/${uid}/${SERVICE_LABEL}`]],
      status: ["launchctl", "print", `gui/${uid}/${SERVICE_LABEL}`],
    };
  }
  const path = join(spec.userHome, ".config", "systemd", "user", SYSTEMD_UNIT);
  const quote = (a: string) => (/^[\w./:=-]+$/.test(a) ? a : `"${a.replace(/(["\\$])/g, "\\$1")}"`);
  const content = [
    "[Unit]",
    "Description=relay worker: runs claimed tasks with this machine's own CLI logins",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${argv.map(quote).join(" ")}`,
    `WorkingDirectory=${spec.userHome}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`),
    "Restart=always",
    "RestartSec=30",
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    path,
    content,
    logPath,
    load: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
    ],
    unload: [
      ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT],
      ["systemctl", "--user", "daemon-reload"],
    ],
    status: ["systemctl", "--user", "is-active", SYSTEMD_UNIT],
  };
}
