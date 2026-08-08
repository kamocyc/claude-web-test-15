/** 検査 — inspection rules, the per-formation projection and its badges. */

import { expect, type Locator, type Page } from '@playwright/test';

import { TID } from '../testids';
import type { AppPage } from './appPage';

export class InspectionsPage {
  readonly page: Page;

  constructor(readonly app: AppPage) {
    this.page = app.page;
  }

  async open(): Promise<void> {
    await this.app.goto('inspections');
    await expect(this.page.getByTestId(TID.inspectionTable)).toBeVisible();
  }

  get table(): Locator {
    return this.page.getByTestId(TID.inspectionTable);
  }

  get ruleList(): Locator {
    return this.page.getByTestId(TID.inspectionRuleList);
  }

  scheduleRows(): Locator {
    return this.page.locator('[data-testid^="inspection-schedule-"]');
  }

  scheduleRowsFor(formationId: string): Locator {
    return this.page.getByTestId(TID.inspectionSchedule(formationId));
  }
}
