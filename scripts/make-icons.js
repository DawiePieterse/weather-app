// Renders site/icons/icon.svg to the PNG sizes the manifest and iOS need.
// Run with `npm run icons` after changing the SVG.
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { launchOptions } from "../tests/e2e/browser.js";

const svg = await readFile(new URL("../site/icons/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
for (const [size, name, pad] of [[192, "icon-192"], [512, "icon-512"], [180, "icon-180"], [512, "icon-maskable-512", 0.1]]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = pad ? size * (1 - pad * 2) : size;
  await page.setContent(`<body style="margin:0;background:#0A2F6B;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div></body>`);
  await page.screenshot({ path: new URL(`../site/icons/${name}.png`, import.meta.url).pathname, omitBackground: false });
}
await browser.close();
