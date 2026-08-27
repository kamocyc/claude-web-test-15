/**
 * The application shell as a page object.
 *
 * Everything the specs need in order to *wait* lives here. There is no
 * `waitForTimeout` in this suite: the app publishes `data-sim-ready`,
 * `data-validation-state`, `data-autosave-state` and `data-index-generation`
 * on the document root, and Playwright waits on those instead of sleeping.
 */

import { expect, type Download, type Locator, type Page } from '@playwright/test';

import { ROUTES, STATE_ATTR, TID, type RouteName } from '../testids';

export interface SnapshotDigest {
  t: number;
  active: number;
  trains: Array<{ id: string; number: string; phase: string; km: number }>;
}

export interface RenderDigest {
  view: string;
  width: number;
  height: number;
  trains: Array<{ id: string; sx: number; sy: number }>;
  stations: Array<{ id: string; sx: number; sy: number }>;
}

/**
 * The test hook surface, described locally.
 *
 * `src/testMode.ts` already augments `Window` for the application build; a
 * second augmentation here would be a duplicate-identifier error under
 * `tsc --noEmit`, which is part of `npm run build` and therefore part of the
 * Playwright web server. So the page objects cast instead of declaring.
 */
interface HookWindow {
  __sim?: {
    setTime(sec: number): void;
    step(sec: number): void;
    setSpeed(n: number): void;
    play(): void;
    pause(): void;
    getTime(): number;
    isReady(): boolean;
    snapshotDigest(): SnapshotDigest;
  };
  __render?: { digest(view: 'line' | 'diagram'): RenderDigest };
}

const EMPTY_DIGEST: SnapshotDigest = { t: -1, active: 0, trains: [] };

export class AppPage {
  constructor(readonly page: Page) {}

  // -- lifecycle -----------------------------------------------------------

  /** Open the app in deterministic mode and wait until the first index exists. */
  async open(query = 'e2e=1'): Promise<void> {
    // Relative, so it resolves against `baseURL` — which carries the
    // production `base` path the preview server serves the build under.
    await this.page.goto(`?${query}`);
    await this.waitReady();
  }

  async waitReady(): Promise<void> {
    await expect(this.page.locator('html')).toHaveAttribute(STATE_ATTR.ready, '1');
    await expect(this.root).toHaveAttribute(STATE_ATTR.ready, '1');
    await this.page.waitForFunction(
      () => (window as unknown as HookWindow).__sim?.isReady() === true,
    );
    await this.settle();
  }

  /** Wait for the debounced validator to finish the pass the last edit started. */
  async settle(): Promise<void> {
    await expect(this.page.locator('html')).toHaveAttribute(STATE_ATTR.validation, 'idle');
  }

  /** The `data-index-generation` counter; changes whenever the index rebuilds. */
  async indexGeneration(): Promise<number> {
    const raw = await this.page.locator('html').getAttribute(STATE_ATTR.indexGeneration);
    return raw === null ? -1 : Number(raw);
  }

  get root(): Locator {
    return this.page.getByTestId(TID.app);
  }

  // -- navigation ----------------------------------------------------------

  async goto(route: RouteName): Promise<void> {
    await this.page.getByTestId(TID.navLink(route)).click();
    await expect(this.page.getByTestId(TID.navLink(route))).toHaveAttribute(
      'aria-current',
      'page',
    );
  }

  // -- file menu -----------------------------------------------------------

  private async openFileMenu(): Promise<void> {
    await this.page.getByTestId(TID.menuFile).click();
    await expect(this.page.getByTestId(TID.menuLoadSample('oimachi'))).toBeVisible();
  }

  /**
   * Load a bundled sample through the real menu item.
   *
   * Defaults to 大井町線 so every spec written before there was a second one
   * still says what it meant.
   */
  async loadSample(line: 'oimachi' | 'kodomonokuni' = 'oimachi'): Promise<void> {
    await this.openFileMenu();
    await this.page.getByTestId(TID.menuLoadSample(line)).click();
    await expect(this.page.getByTestId(TID.statusBar)).toContainText('サンプルを読み込みました');
    await this.settle();
  }

  /** Click エクスポート and return the captured download's parsed JSON. */
  async exportProject(): Promise<{ download: Download; json: Record<string, unknown> }> {
    await this.openFileMenu();
    const [download] = await Promise.all([
      this.page.waitForEvent('download'),
      this.page.getByTestId(TID.menuExport).click(),
    ]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    return { download, json: JSON.parse(text) as Record<string, unknown> };
  }

  // -- history -------------------------------------------------------------

  async undo(): Promise<void> {
    await this.page.getByTestId(TID.undo).click();
    await this.settle();
  }

  async redo(): Promise<void> {
    await this.page.getByTestId(TID.redo).click();
    await this.settle();
  }

  // -- status bar / problem panel -----------------------------------------

  private static countIn(text: string): number {
    const m = /(-?\d+)/.exec(text);
    return m === null ? Number.NaN : Number(m[1]);
  }

  async errorCount(): Promise<number> {
    await this.settle();
    const text = (await this.page.getByTestId(TID.statusErrorCount).textContent()) ?? '';
    return AppPage.countIn(text);
  }

  async warningCount(): Promise<number> {
    await this.settle();
    const text = (await this.page.getByTestId(TID.statusWarningCount).textContent()) ?? '';
    return AppPage.countIn(text);
  }

  async trainCount(): Promise<number> {
    const text = (await this.page.getByTestId(TID.statusTrainCount).textContent()) ?? '';
    return AppPage.countIn(text);
  }

  get problemPanel(): Locator {
    return this.page.getByTestId(TID.problemPanel);
  }

  get problemItems(): Locator {
    return this.page.getByTestId(TID.problemItem);
  }

  /** Collapse or expand the problem panel (the ▾ / ▸ toggle in its header). */
  async setProblemPanelOpen(open: boolean): Promise<void> {
    const toggle = this.problemPanel.locator('button[aria-expanded]').first();
    if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', String(open));
  }

  /** Every problem row whose severity attribute says `error`. */
  errorItems(): Locator {
    return this.page.locator(`[data-testid="${TID.problemItem}"][data-severity="error"]`);
  }

  async expectNoErrors(): Promise<void> {
    expect(await this.errorCount()).toBe(0);
    await expect(this.errorItems()).toHaveCount(0);
  }

  // -- the clock -----------------------------------------------------------

  async setTime(sec: number): Promise<void> {
    await this.page.evaluate((t) => {
      (window as unknown as HookWindow).__sim?.setTime(t);
    }, sec);
  }

  async step(sec: number): Promise<void> {
    await this.page.evaluate((d) => {
      (window as unknown as HookWindow).__sim?.step(d);
    }, sec);
  }

  async setSpeed(n: number): Promise<void> {
    await this.page.evaluate((s) => {
      (window as unknown as HookWindow).__sim?.setSpeed(s);
    }, n);
  }

  async play(): Promise<void> {
    await this.page.evaluate(() => {
      (window as unknown as HookWindow).__sim?.play();
    });
  }

  async pause(): Promise<void> {
    await this.page.evaluate(() => {
      (window as unknown as HookWindow).__sim?.pause();
    });
  }

  async time(): Promise<number> {
    return this.page.evaluate(() => (window as unknown as HookWindow).__sim?.getTime() ?? -1);
  }

  async snapshotDigest(): Promise<SnapshotDigest> {
    return this.page.evaluate(
      (empty) => (window as unknown as HookWindow).__sim?.snapshotDigest() ?? empty,
      EMPTY_DIGEST,
    );
  }

  /** Rounded screen geometry of what the canvas actually drew. */
  async renderDigest(view: 'line' | 'diagram'): Promise<RenderDigest> {
    return this.page.evaluate(
      (v) =>
        (window as unknown as HookWindow).__render?.digest(v) ?? {
          view: v,
          width: 0,
          height: 0,
          trains: [],
          stations: [],
        },
      view,
    );
  }

  /**
   * Force one synchronous canvas frame.
   *
   * Under `?e2e=1` the rAF loop is never installed, so the canvases only paint
   * when `__render.digest` asks them to. Screenshots need that.
   */
  async paint(view: 'line' | 'diagram'): Promise<void> {
    await this.renderDigest(view);
  }

  static readonly routes = ROUTES;
}

export type { RouteName };
