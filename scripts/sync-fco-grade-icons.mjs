/** Render the official datacenter's CSS badges to fourteen reusable PNGs.
 * Nexon uses CSS + INGAME text (not fourteen standalone source images).
 * 0 is rendered as 0 rather than the search control's '-' placeholder.
 * Run: node scripts/sync-fco-grade-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const source = 'https://js.nexon.com/s3/fc/online/obt/fo4_ssl.css';
const font = 'https://fco.vod.nexoncdn.co.kr/fonts/YoonGothic540.woff2';
const background = 'https://ssl.nexon.com/s2/game/fc/online/obt/datacenter/bg_plt.png';
async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const [css, fontData, backgroundData] = await Promise.all([get(source), get(font), get(background)]);
const text = css.toString();
const rules = Array.from({length:14}, (_,grade) => {
  const rule = text.match(new RegExp(`\\.en_level${grade},\\.buildup__${grade}\\{[^}]+\\}`))?.[0];
  if (!rule) throw new Error(`Official grade ${grade} rule missing`);
  return rule.replace('//ssl.nexon.com/s2/game/fc/online/obt/datacenter/bg_plt.png', `data:image/png;base64,${backgroundData.toString('base64')}`);
});
const directory = fileURLToPath(new URL('../apps/web/public/images/fco-grades/', import.meta.url));
await mkdir(directory, {recursive:true});
const browser = await chromium.launch();
try {
  const page = await browser.newPage({viewport:{width:300,height:800},deviceScaleFactor:3});
  await page.setContent(`<style>
    @font-face {font-family:INGAME;src:url(data:font/woff2;base64,${fontData.toString('base64')}) format('woff2');font-weight:400}
    body{margin:0;background:transparent}.badge{box-sizing:border-box;width:58px;height:36px;display:flex;align-items:center;justify-content:center;font:900 27px/36px INGAME;margin:8px;}
    ${rules.join('\n')}
  </style>${rules.map((_,n)=>`<div id="grade-${n}" class="badge en_level${n}">${n}</div>`).join('')}`);
  await page.evaluate(async () => { await document.fonts.ready; });
  // Wait for the official platinum background to decode before capturing it.
  await page.evaluate(src => new Promise((resolve,reject)=>{const i=new Image();i.onload=resolve;i.onerror=reject;i.src=src;}), `data:image/png;base64,${backgroundData.toString('base64')}`);
  for(let n=0;n<=13;n++) await page.locator(`#grade-${n}`).screenshot({path:`${directory}/${n}.png`,omitBackground:true});
  await writeFile(`${directory}/sources.json`,JSON.stringify({sourcePage:'https://fconline.nexon.com/datacenter',stylesheet:source,font,platinumBackground:background,method:'Official en_level0..13 CSS rendered with INGAME font at 3x; zero uses the numeral 0.',grades:Array.from({length:14},(_,n)=>`${n}.png`)},null,2)+'\n');
  console.log('Saved 14 official-style grade badges (0–13).');
} finally {await browser.close();}
