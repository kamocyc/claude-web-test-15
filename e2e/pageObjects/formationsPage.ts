/** 編成 — 形式, 編成 and the per-kind inspection badges. */

import { expect, type Locator, type Page } from '@playwright/test';

import { TID } from '../testids';
import type { AppPage } from './appPage';

export class FormationsPage {
  readonly page: Page;

  constructor(readonly app: AppPage) {
    this.page = app.page;
  }

  async open(): Promise<void> {
    await this.app.goto('formations');
    await expect(this.page.getByTestId(TID.formationList)).toBeVisible();
  }

  async addSeries(name: string, cars: number): Promise<void> {
    await this.page.getByTestId(TID.seriesNameInput).fill(name);
    await this.page.getByTestId(TID.seriesCarsInput).fill(String(cars));
    await this.page.getByTestId(TID.seriesAdd).click();
    await expect(this.page.getByTestId(TID.formationSeriesSelect)).toContainText(name);
    await this.app.settle();
  }

  rows(): Locator {
    return this.page.locator('[data-testid^="formation-row-"]');
  }

  row(code: string): Locator {
    return this.rows().filter({ has: this.page.getByLabel(`${code} の番号`) });
  }

  async addFormation(options: {
    code: string;
    seriesName?: string;
    cars?: number;
    depotName?: string;
  }): Promise<string> {
    const before = await this.rows().count();
    await this.page.getByTestId(TID.formationCodeInput).fill(options.code);
    if (options.seriesName !== undefined) {
      await this.page
        .getByTestId(TID.formationSeriesSelect)
        .selectOption({ label: options.seriesName });
    }
    if (options.cars !== undefined) {
      await this.page.getByTestId(TID.formationCarsInput).fill(String(options.cars));
    }
    if (options.depotName !== undefined) {
      await this.page
        .getByTestId(TID.formationDepotSelect)
        .selectOption({ label: options.depotName });
    }
    await this.page.getByTestId(TID.formationAdd).click();
    await expect(this.rows()).toHaveCount(before + 1);
    await this.app.settle();
    const id = await this.row(options.code).getAttribute('data-testid');
    return (id ?? '').replace('formation-row-', '');
  }

  badges(): Locator {
    return this.page.locator('[data-testid^="inspection-badge-"]');
  }
}
