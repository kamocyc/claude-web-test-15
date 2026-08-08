import { chromium } from '@playwright/test';
const base = 'http://127.0.0.1:4173';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base + '/?e2e=1');
await page.waitForSelector('[data-testid="app"][data-sim-ready="1"]');

await page.getByTestId('nav-stations').click();
for (const [n,k] of [['A','0'],['B','1'],['C','2']]) {
  await page.getByTestId('station-name-input').fill(n);
  await page.getByTestId('station-km-input').fill(k);
  await page.getByTestId('station-submit').click();
}
await page.waitForSelector('html[data-validation-state="idle"]', { timeout: 10000 });
console.log('validation settles to idle: ok');

// autosave attribute
await page.waitForSelector('html[data-autosave-state="saved"]', { timeout: 10000 }).then(
  () => console.log('autosave: saved'), () => console.log('autosave attr:', 'not saved'));

// problem panel / empty state
console.log('problem empty visible:', await page.getByTestId('problem-empty').count());

// undo/redo through the top bar
const before = await page.getByTestId('station-row').count();
await page.getByTestId('undo').click();
const mid = await page.getByTestId('station-row').count();
await page.getByTestId('redo').click();
const after = await page.getByTestId('station-row').count();
console.log(`undo/redo rows: ${before} -> ${mid} -> ${after}`);

// keyboard undo
await page.keyboard.press('Control+z');
console.log('ctrl+z rows:', await page.getByTestId('station-row').count());
await page.keyboard.press('Control+Shift+z');
console.log('ctrl+shift+z rows:', await page.getByTestId('station-row').count());

// sample load must not throw out of the handler
await page.getByTestId('menu-file').click();
await page.getByTestId('menu-load-sample').click();
console.log('after sample click, still alive:', await page.getByTestId('status-bar').isVisible());
console.log('status message:', (await page.getByTestId('status-bar').textContent()).slice(-60));

// export triggers a download
const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await page.getByTestId('menu-file').click();
await page.getByTestId('menu-export').click();
const d = await dl;
console.log('export download:', d ? d.suggestedFilename() : 'none');

// transport
await page.getByTestId('play-pause').click();
console.log('playing:', await page.getByTestId('play-pause').getAttribute('aria-pressed'));
await page.getByTestId('speed-select').selectOption('300');
await page.getByTestId('day-type-select').selectOption({ index: 0 });

// every route mounts
for (const r of ['line','diagram','timetable','duties','formations','stations','types','inspections']) {
  await page.getByTestId('nav-' + r).click();
  await page.waitForTimeout(60);
}
console.log('all routes mounted');
console.log(errors.length ? 'ERRORS: ' + errors.slice(0,6).join(' | ') : 'no page errors');
await browser.close();
