// Renders public/icons/icon.svg to the PNG sizes needed by iOS/Android.
// Usage: node scripts/make-icons.mjs
import fs from 'node:fs';
import { chromium } from 'playwright';

const svg = fs.readFileSync('public/icons/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
async function render(size, file, padding = 0) {
  await page.setViewportSize({ width: size, height: size });
  const inner = size - padding * 2;
  await page.setContent(
    `<body style="margin:0;background:${padding ? '#4f46e5' : 'transparent'};display:grid;place-items:center;height:100vh">` +
      svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `) + '</body>',
  );
  await page.screenshot({ path: file, omitBackground: !padding });
}
await render(192, 'public/icons/icon-192.png');
await render(512, 'public/icons/icon-512.png');
await render(512, 'public/icons/icon-maskable-512.png', 60);
await browser.close();
