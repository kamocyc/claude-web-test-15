/** 運行図表 — the string diagram, asserted through its layout shadow. */

import { expect, type Locator, type Page } from '@playwright/test';

import { TID } from '../testids';
import type { AppPage } from './appPage';

export class DiagramPage {
  readonly page: Page;

  constructor(readonly app: AppPage) {
    this.page = app.page;
  }

  async open(): Promise<void> {
    await this.app.goto('diagram');
    await expect(this.page.getByTestId(TID.diagram)).toBeVisible();
    await expect(this.shadow).toHaveCount(1);
  }

  get shadow(): Locator {
    return this.page.getByTestId(TID.diagramTrains);
  }

  lines(): Locator {
    return this.page.getByTestId(TID.diagramTrainLine);
  }

  line(trainId: string): Locator {
    return this.page.locator(
      `[data-testid="${TID.diagramTrainLine}"][data-train-id="${trainId}"]`,
    );
  }

  overtakeMarkers(): Locator {
    return this.page.getByTestId(TID.overtakeMarker);
  }

  connectionMarkers(): Locator {
    return this.page.getByTestId(TID.connectionMarker);
  }

  /** Overtake rows the engine judged illegal — should always be empty. */
  illegalOvertakes(): Locator {
    return this.page.locator(`[data-testid="${TID.overtakeMarker}"][data-legal="0"]`);
  }

  async pointCount(trainId: string): Promise<number> {
    const raw = await this.line(trainId).getAttribute('data-point-count');
    return raw === null ? 0 : Number(raw);
  }
}
