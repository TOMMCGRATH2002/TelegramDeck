/**
 * Builds tab / PWA icons from public/logo.png (tighter crop = reads better at 16–32px).
 * Run: node scripts/gen-icons.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const src = path.join(root, 'public', 'logo.png');
const outDir = path.join(root, 'public', 'icons');

async function main() {
  if (!fs.existsSync(src)) {
    console.error('Missing', src);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const meta = await sharp(src).metadata();
  const w = meta.width || 512;
  const h = meta.height || 512;
  const crop = 0.58;
  const cw = Math.max(1, Math.round(w * crop));
  const ch = Math.max(1, Math.round(h * crop));
  const left = Math.max(0, Math.round((w - cw) / 2));
  const top = Math.max(0, Math.round((h - ch) / 2));

  const zoomed = sharp(src).extract({ left, top, width: cw, height: ch });

  await zoomed.clone().resize(32, 32).png({ compressionLevel: 9 }).toFile(path.join(outDir, 'favicon-32.png'));
  await zoomed.clone().resize(180, 180).png({ compressionLevel: 9 }).toFile(path.join(outDir, 'apple-touch-icon.png'));
  await zoomed.clone().resize(192, 192).png({ compressionLevel: 9 }).toFile(path.join(outDir, 'icon-192.png'));
  await zoomed.clone().resize(512, 512).png({ compressionLevel: 9 }).toFile(path.join(outDir, 'icon-512.png'));

  console.log('Wrote icons to public/icons/');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
