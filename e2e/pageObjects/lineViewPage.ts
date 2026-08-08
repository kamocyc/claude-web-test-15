/**
 * 線区ビュー — asserted through the canvas's hidden DOM shadow, never pixels.
 *
 * `line-view-trains` mirrors exactly what the dynamic canvas layer drew, one
 * `train-marker` row per train with its phase, reason, km, station and track.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { TID } from '../testids';
import type { AppPage } from './appPage';

export interface MarkerRow {
  trainId: string;
  number: string;
  type: string;
  phase: string;
  reason: string;
  km: number;
  stationId: string;
  trackId: string;
  formation: string;
}

export class LineViewPage {
  readonly page: Page;

  constructor(readonly app: AppPage) {
    this.page = app.page;
  }

  async open(): Promise<void> {
    await this.app.goto('line');
    await expect(this.page.getByTestId(TID.lineView)).toBeVisible();
    await expect(this.shadow).toHaveCount(1);
  }

  get shadow(): Locator {
    return this.page.getByTestId(TID.lineViewTrains);
  }

  markers(): Locator {
    return this.page.getByTestId(TID.trainMarker);
  }

  withPhase(phase: string): Locator {
    return this.page.locator(`[data-testid="${TID.trainMarker}"][data-phase="${phase}"]`);
  }

  withReason(reason: string): Locator {
    return this.page.locator(`[data-testid="${TID.trainMarker}"][data-reason="${reason}"]`);
  }

  marker(trainId: string): Locator {
    return this.page.locator(
      `[data-testid="${TID.trainMarker}"][data-train-id="${trainId}"]`,
    );
  }

  /** Read every marker row out of the shadow in one round trip. */
  async rows(): Promise<MarkerRow[]> {
    return this.markers().evaluateAll((nodes) =>
      nodes.map((n) => ({
        trainId: n.getAttribute('data-train-id') ?? '',
        number: n.getAttribute('data-train-number') ?? '',
        type: n.getAttribute('data-type') ?? '',
        phase: n.getAttribute('data-phase') ?? '',
        reason: n.getAttribute('data-reason') ?? '',
        km: Number(n.getAttribute('data-km') ?? '0'),
        stationId: n.getAttribute('data-station') ?? '',
        trackId: n.getAttribute('data-track') ?? '',
        formation: n.getAttribute('data-formation') ?? '',
      })),
    );
  }

  depotRow(depotId: string): Locator {
    return this.page.getByTestId(TID.lineViewDepot(depotId));
  }

  get legend(): Locator {
    return this.page.getByTestId(TID.lineViewLegend);
  }
}
