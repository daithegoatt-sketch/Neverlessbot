const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

async function main() {
  const assetsDir = path.join(process.cwd(), 'assets');
  const jpgPath = path.join(assetsDir, 'welcome-template.jpg');
  const svgPath = path.join(assetsDir, 'welcome-template.svg');

  if (fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 10000) {
    console.log('[prepare] Using welcome-template.jpg');
    return;
  }

  const image = await loadImage(svgPath);
  const canvas = createCanvas(1672, 941);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, 1672, 941);
  const output = await canvas.encode('jpeg');
  fs.writeFileSync(jpgPath, output);
  console.log('[prepare] Welcome template ready.');
}

main().catch((error) => {
  console.error('[prepare] Failed:', error);
  process.exit(1);
});
