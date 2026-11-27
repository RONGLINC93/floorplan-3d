import { chromium } from 'file:///C:/Users/chenr/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:8791/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
const out = await page.evaluate(async () => {
  const txt = await (await fetch('/index.html')).text();
  const a = txt.indexOf('    function drawNewSignFace(');
  const b = txt.indexOf('    function signFaceTexture(');
  (0, eval)(txt.slice(a, b));
  const defs = [['signSteepUp', { zh: '上陡坡', shape: 'tri', style: 'warn', art: 'steepUp' }], ['signSteepDown', { zh: '下陡坡', shape: 'tri', style: 'warn', art: 'steepDown' }]];
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d'); g.fillStyle = '#444'; g.fillRect(0, 0, 512, 256);
  defs.forEach((it, i) => {
    const one = document.createElement('canvas'); one.width = one.height = 256;
    drawCenteredSignFace(one.getContext('2d'), { type: it[0] }, it[1]);
    g.drawImage(one, i * 256, 0);
  });
  return { img: c.toDataURL('image/png') };
});
fs.writeFileSync('.codebuddy/steep-now.png', Buffer.from(out.img.split(',')[1], 'base64'));
await browser.close();
