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

  get canvas(): Locator {
    return this.page.getByTestId(TID.diagramCanvas);
  }

  /**
   * Zoom the sheet in around one station at the current clock position, the
   * way a user does with the wheel, so a screenshot shows a legible region
   * rather than a whole 27-hour day compressed into 900 pixels.
   */
  async zoomAround(stationId: string, steps = 3): Promise<void> {
    const box = await this.canvas.boundingBox();
    if (box === null) return;
    const digest = await this.app.renderDigest('diagram');
    const station = digest.stations.find((s) => s.id === stationId);
    const nowX = digest.trains[0]?.sx ?? Math.round(box.width / 2);
    const y = box.y + (station?.sy ?? Math.round(box.height / 2));
    const x = box.x + nowX;

    await this.page.mouse.move(x, y);
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, -400);
    }
    await this.page.keyboard.down('Control');
    await this.page.mouse.wheel(0, -400);
    await this.page.keyboard.up('Control');
    await this.app.paint('diagram');
  }

  async pointCount(trainId: string): Promise<number> {
    const raw = await this.line(trainId).getAttribute('data-point-count');
    return raw === null ? 0 : Number(raw);
  }
}
