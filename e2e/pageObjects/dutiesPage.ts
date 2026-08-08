/** 運用 — duty composition (never by drag and drop) and formation assignment. */

import { expect, type Locator, type Page } from '@playwright/test';

import { TID } from '../testids';
import type { AppPage } from './appPage';

export class DutiesPage {
  readonly page: Page;

  constructor(readonly app: AppPage) {
    this.page = app.page;
  }

  async open(): Promise<void> {
    await this.app.goto('duties');
    await expect(this.page.getByTestId(TID.dutyBoard)).toBeVisible();
  }

  get board(): Locator {
    return this.page.getByTestId(TID.dutyBoard);
  }

  rows(): Locator {
    return this.page.locator('[data-testid^="duty-row-"]');
  }

  async dutyIds(): Promise<string[]> {
    return this.rows().evaluateAll((nodes) =>
      nodes.map((n) => (n.getAttribute('data-testid') ?? '').replace('duty-row-', '')),
    );
  }

  async addDuty(code: string): Promise<void> {
    const before = await this.rows().count();
    await this.page.getByTestId(TID.dutyCodeInput).fill(code);
    await this.page.getByTestId(TID.dutyAdd).click();
    await expect(this.rows()).toHaveCount(before + 1);
    await this.app.settle();
  }

  /** 運用を自動組成 — the minimum-path-cover button. */
  async autoAssign(): Promise<void> {
    await this.page.getByTestId(TID.dutyAutoAssign).click();
    await this.app.settle();
    await expect(this.rows().first()).toBeVisible();
  }

  unassignedTrains(): Locator {
    return this.page.locator('[data-testid^="unassigned-train-"]');
  }

  /**
   * The keyboard/menu path in place of drag and drop: open the train's 運用に追加
   * menu, then pick the duty.
   */
  async addTrainToDuty(trainId: string, dutyId: string): Promise<void> {
    await this.page.getByTestId(TID.addTrainToDuty(trainId)).click();
    const choice = this.page.getByTestId(TID.addTrainToDutyChoice(dutyId));
    await expect(choice).toBeVisible();
    await choice.click();
    await this.app.settle();
  }

  formationSelect(dutyId: string): Locator {
    return this.page.getByTestId(TID.dutyFormationSelect(dutyId));
  }

  async assignFormation(dutyId: string, formationLabelPrefix: string): Promise<void> {
    const select = this.formationSelect(dutyId);
    const value = await select
      .locator('option')
      .filter({ hasText: formationLabelPrefix })
      .first()
      .getAttribute('value');
    expect(value, `formation ${formationLabelPrefix} should be selectable`).toBeTruthy();
    await select.selectOption(value as string);
    await expect(select).toHaveValue(value as string);
    await this.app.settle();
  }

  legs(dutyId: string): Locator {
    return this.page.locator(`[data-testid^="duty-leg-${dutyId}-"]`);
  }
}
