import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4173/?e2e=1');
await page.waitForSelector('[data-testid="app"][data-sim-ready="1"]');
for (const name of ['新規プロジェクト.rosim.json', 'plain.rosim.json', 'plain.json']) {
  for (const rel of ['', 'noopener']) {
    const dl = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
    await page.evaluate(([n, r]) => {
      const url = URL.createObjectURL(new Blob(['{}'], { type: 'application/json;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = n; if (r) a.rel = r; a.style.display = 'none';
      document.body.appendChild(a); a.click();
    }, [name, rel]);
    const d = await dl;
    console.log(JSON.stringify(name), 'rel=' + JSON.stringify(rel), '->', d ? d.suggestedFilename() : 'none');
  }
}
await browser.close();
