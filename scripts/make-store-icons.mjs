// Renders public/icons/icon.svg into the icons the two app stores need:
//  - iPhone: the 1024×1024 App Store icon (square, no transparency; iOS rounds the corners)
//  - Android: the launcher icons for older phones (mipmap-*/ic_launcher.png and
//    ic_launcher_round.png); newer phones use the adaptive icon in mipmap-anydpi-v26
//  - Google Play: the 512×512 store icon and the 1024×500 feature graphic (docs/store/)
// Usage: node scripts/make-store-icons.mjs   (CHROMIUM_PATH=/path/to/chromium if needed)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const svg = fs.readFileSync(path.join(ROOT, 'public/icons/icon.svg'), 'utf8');
// The same picture without its rounded corners: the stores round (or mask) it themselves.
const square = svg.replace('rx="112" fill="url(#g)"', 'fill="url(#g)"');
const sized = (s, w, h = w) => s.replace('<svg ', `<svg width="${w}" height="${h}" `);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();

async function shot(file, width, height, html, transparent) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><body style="margin:0;width:${width}px;height:${height}px;overflow:hidden;${transparent ? '' : 'background:#4f46e5;'}">${html}</body>`);
  await page.screenshot({ path: file, omitBackground: !!transparent });
  console.log(path.relative(ROOT, file));
}

// iPhone: square, opaque.
await shot(path.join(ROOT, 'ios/RecordAI.swiftpm/Assets.xcassets/AppIcon.appiconset/AppIcon.png'), 1024, 1024, sized(square, 1024));

// Android launcher icons for phones without adaptive icons.
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, px] of Object.entries(densities)) {
  const dir = path.join(ROOT, `android/app/src/main/res/mipmap-${d}`);
  await shot(path.join(dir, 'ic_launcher.png'), px, px, sized(svg, px), true);
  await shot(path.join(dir, 'ic_launcher_round.png'), px, px,
    `<div style="width:${px}px;height:${px}px;border-radius:50%;overflow:hidden">${sized(square, px)}</div>`, true);
}

// Google Play listing: the store icon (Google adds the rounded corners) and the feature graphic.
await shot(path.join(ROOT, 'docs/store/play-icon-512.png'), 512, 512, sized(square, 512));
await shot(path.join(ROOT, 'docs/store/play-feature-graphic-1024x500.png'), 1024, 500, `
  <div style="width:1024px;height:500px;display:flex;align-items:center;gap:56px;padding:0 80px;box-sizing:border-box;
              background:linear-gradient(135deg,#6366f1,#4338ca);font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#fff">
    ${sized(svg, 260)}
    <div>
      <div style="font-size:84px;font-weight:800;letter-spacing:-1px">SortMemo</div>
      <div style="font-size:36px;opacity:.92;margin-top:12px;line-height:1.25">Write it down.<br>The AI sorts it.</div>
    </div>
  </div>`);

await browser.close();
