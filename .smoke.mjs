import { chromium } from '@playwright/test';

const base = 'http://127.0.0.1:4173';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(base + '/?e2e=1');
await page.waitForSelector('[data-testid="app"][data-sim-ready="1"]', { timeout: 20000 });
console.log('ready ok');

// --- from-scratch flow: stations -> tracks -> types -> patterns -> trains ---
await page.getByTestId('nav-stations').click();
for (const [name, km] of [['大井町', '0'], ['旗の台', '2.6'], ['大岡山', '4.4'], ['溝の口', '10.4']]) {
  await page.getByTestId('station-name-input').fill(name);
  await page.getByTestId('station-km-input').fill(km);
  await page.getByTestId('station-submit').click();
}
console.log('stations:', await page.getByTestId('station-row').count());

// add a second track at the currently selected station
await page.getByTestId('track-name-input').fill('2番線');
await page.getByTestId('track-submit').click();
console.log('tracks at selected station:', await page.getByTestId('track-row').count());

// run times
const rt = page.getByTestId('link-run-time-input');
const n = await rt.count();
for (let i = 0; i < n; i++) await rt.nth(i).fill('180');
console.log('links:', n);

await page.getByTestId('nav-types').click();
await page.getByTestId('train-type-name-input').fill('各駅停車');
await page.getByTestId('train-type-short-input').fill('各');
await page.getByTestId('train-type-submit').click();
await page.getByTestId('pattern-name-input').fill('各停(下り)');
await page.getByTestId('pattern-submit').click();
console.log('pattern matrix present:', await page.getByTestId('pattern-matrix').isVisible());

await page.getByTestId('nav-timetable').click();
await page.getByTestId('train-number-input').fill('101');
await page.getByTestId('train-origin-dep-input').fill('0743');
await page.getByTestId('train-submit').click();
await page.getByTestId('train-number-input').fill('103');
await page.getByTestId('train-origin-dep-input').fill('0800');
await page.getByTestId('train-submit').click();
console.log('status:', await page.getByTestId('status-train-count').textContent());

const trainIds = await page.evaluate(() => Object.keys(window.__sim ? {} : {}));
const firstCell = page.locator('[data-testid^="time-cell-"]').first();
console.log('first cell value:', await firstCell.inputValue());
await firstCell.focus();
await page.keyboard.press('ArrowDown');
await page.keyboard.type('0750');
await page.keyboard.press('Enter');
console.log('after edit, dep cell:', await page.locator('[data-testid$="-0-dep"]').first().inputValue());

await page.getByTestId('auto-assign-tracks').click();
const trackSel = page.locator('[data-testid^="track-cell-"]').first();
console.log('assigned track:', await trackSel.inputValue());

// duties
await page.getByTestId('nav-duties').click();
await page.getByTestId('duty-auto-assign').click();
console.log('duty rows:', await page.locator('[data-testid^="duty-row-"]').count());
const unassignedBtn = page.locator('[data-testid^="add-train-to-duty-"]').first();
console.log('unassigned trains left:', await page.locator('[data-testid^="unassigned-train-"]').count());

// formations
await page.getByTestId('nav-stations').click();
await page.getByTestId('depot-submit').click();
await page.getByTestId('nav-formations').click();
await page.getByTestId('series-name-input').fill('6000系');
await page.getByTestId('series-submit').click();
await page.getByTestId('formation-code-input').fill('6101F');
await page.getByTestId('formation-submit').click();
console.log('formation rows:', await page.locator('[data-testid^="formation-row-"]').count());
console.log('badges:', await page.locator('[data-testid^="inspection-badge-"]').count());

await page.getByTestId('nav-duties').click();
const sel = page.locator('[data-testid^="duty-formation-select-"]').first();
if (await sel.count()) { await sel.selectOption({ index: 1 }); console.log('assigned formation ok'); }

// undo / sample / clock
await page.getByTestId('nav-line').click();
await page.getByTestId('nav-inspections').click();
await page.getByTestId('nav-diagram').click();
await page.evaluate(() => window.__sim.setTime(8 * 3600));
console.log('clock:', await page.getByTestId('clock-readout').textContent());
console.log('digest:', JSON.stringify(await page.evaluate(() => window.__sim.snapshotDigest())).slice(0, 120));

await page.getByTestId('menu-file').click();
await page.getByTestId('menu-load-sample').click();
await page.getByTestId('undo').click();
console.log('after undo, trains:', await page.getByTestId('status-train-count').textContent());

console.log('problem panel:', await page.getByTestId('problem-panel').isVisible());
console.log('validation attr:', await page.evaluate(() => document.documentElement.getAttribute('data-validation-state')));
console.log('index gen:', await page.evaluate(() => document.documentElement.getAttribute('data-index-generation')));

if (errors.length) { console.log('ERRORS:'); for (const e of errors.slice(0, 12)) console.log(' -', e); }
else console.log('no page errors');
await browser.close();
