/** 乗務員 — 行路 composition, the 行路表, and who works which duty. */

import { expect, type Locator, type Page } from '@playwright/test';

import { TID } from '../testids';
import type { AppPage } from './appPage';

export class CrewPage {
  readonly page: Page;

  constructor(readonly app: AppPage) {
    this.page = app.page;
  }

  async open(): Promise<void> {
    await this.app.goto('crew');
    await expect(this.page.getByTestId(TID.crewBoard)).toBeVisible();
  }

  get board(): Locator {
    return this.page.getByTestId(TID.crewBoard);
  }

  get chart(): Locator {
    return this.page.getByTestId(TID.crewChart);
  }

  rows(): Locator {
    return this.page.locator('[data-testid^="crew-duty-row-"]');
  }

  chartRows(): Locator {
    return this.page.locator('[data-testid^="crew-chart-row-"]');
  }

  chartBars(): Locator {
    return this.page.locator('[data-testid^="crew-chart-bar-"]');
  }

  async crewDutyIds(): Promise<string[]> {
    return this.rows().evaluateAll((nodes) =>
      nodes.map((n) => (n.getAttribute('data-testid') ?? '').replace('crew-duty-row-', '')),
    );
  }

  /** Rows the 行路表 believes it drew, and how many of them clash. */
  async chartCounts(): Promise<{ rows: number; conflicts: number }> {
    const rows = await this.chart.getAttribute('data-row-count');
    const conflicts = await this.chart.getAttribute('data-conflict-count');
    return { rows: Number(rows ?? 0), conflicts: Number(conflicts ?? 0) };
  }

  async window(): Promise<string> {
    return (await this.page.getByTestId(TID.crewChartWindow).textContent()) ?? '';
  }

  async zoomIn(): Promise<void> {
    await this.page.getByTestId(TID.crewZoomIn).click();
  }

  async resetZoom(): Promise<void> {
    await this.page.getByTestId(TID.crewZoomReset).click();
  }

  /** 行路を自動組成 for the role currently filtered (運転士 by default). */
  async autoAssign(): Promise<void> {
    await this.page.getByTestId(TID.crewAutoAssign).click();
    await this.app.settle();
    await expect(this.rows().first()).toBeVisible();
  }

  async autoFillPeople(): Promise<void> {
    await this.page.getByTestId(TID.crewAssignAutoFill).click();
    await this.app.settle();
  }

  async expandDuty(crewDutyId: string): Promise<void> {
    await this.page.getByTestId(TID.crewDutyExpand(crewDutyId)).click();
    await expect(this.page.getByTestId(TID.crewLegList(crewDutyId))).toBeVisible();
  }

  legs(crewDutyId: string): Locator {
    return this.page.locator(`[data-testid^="crew-leg-${crewDutyId}-"]`);
  }

  async addBreak(crewDutyId: string): Promise<void> {
    const before = await this.legs(crewDutyId).count();
    await this.page.getByTestId(TID.crewAddBreakLeg(crewDutyId)).click();
    await expect(this.legs(crewDutyId)).toHaveCount(before + 1);
    await this.app.settle();
  }

  async personOf(crewDutyId: string): Promise<string> {
    return this.page.getByTestId(TID.crewDutyPersonSelect(crewDutyId)).inputValue();
  }
}
