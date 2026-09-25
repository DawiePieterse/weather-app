// Chromium launch options: the sandbox this was built in ships its own
// Chromium under /opt/pw-browsers; CI installs Playwright's.
import { existsSync } from "node:fs";

export function launchOptions() {
  const local = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  return existsSync(local) && !process.env.CI ? { executablePath: local } : {};
}
