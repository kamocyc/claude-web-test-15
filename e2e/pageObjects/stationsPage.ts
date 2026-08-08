/** 駅・線路 — stations, 番線, 駅間 run times, depots and the 構内ダイヤ. */

import { expect, type Locator, type Page } from '@playwright/test';

import { TID } from '../testids';
import type { AppPage } from './appPage';

export interface TrackOptions {
  name?: string;
  usage?: 'main' | 'passing' | 'through' | 'depot' | 'stabling';
  hasPlatform?: boolean;
  canTurnBack?: boolean;
  canBeOvertaken?: boolean;
  down?: boolean;
  up?: boolean;
  maxCars?: number;
}

export class StationsPage {
  readonly page: Page;

  constructor(readonly app: AppPage) {
    this.page = app.page;
  }

  async open(): Promise<void> {
    await this.app.goto('stations');
    await expect(this.page.getByTestId(TID.stationList)).toBeVisible();
  }

  // -- 駅 ------------------------------------------------------------------

  get rows(): Locator {
    return this.page.getByTestId(TID.stationRow);
  }

  row(name: string): Locator {
    return this.rows.filter({ has: this.page.getByLabel(`${name} の駅名`) });
  }

  /** Add one station through the form. Every field is typed, nothing injected. */
  async addStation(name: string, km: number): Promise<void> {
    const before = await this.rows.count();
    await this.page.getByTestId(TID.stationNameInput).fill(name);
    await this.page.getByTestId(TID.stationKmInput).fill(String(km));
    await this.page.getByTestId(TID.stationAdd).click();
    await expect(this.rows).toHaveCount(before + 1);
    await expect(this.row(name)).toHaveCount(1);
    await this.app.settle();
  }

  /** Point the 番線 editor and the 構内ダイヤ at one station. */
  async selectStation(name: string): Promise<void> {
    await this.page.getByTestId(TID.stationSelect).selectOption({ label: name });
    await expect(this.page.getByTestId(TID.stationSelect)).toHaveValue(
      await this.stationIdOf(name),
    );
  }

  async stationIdOf(name: string): Promise<string> {
    const id = await this.row(name).getAttribute('data-station-id');
    expect(id, `station ${name} should exist`).not.toBeNull();
    return id as string;
  }

  // -- 番線 ----------------------------------------------------------------

  get trackRows(): Locator {
    return this.page.getByTestId(TID.trackRow);
  }

  trackRow(name: string): Locator {
    return this.trackRows.filter({ has: this.page.getByLabel(`${name} の名称`) });
  }

  private async setCheck(testid: string, value: boolean): Promise<void> {
    const box = this.page.getByTestId(testid);
    if ((await box.isChecked()) !== value) await box.click();
    await expect(box).toBeChecked({ checked: value });
  }

  /** Add a 番線 to the currently selected station through the form. */
  async addTrack(options: TrackOptions = {}): Promise<void> {
    const before = await this.trackRows.count();
    if (options.name !== undefined) {
      await this.page.getByTestId(TID.trackNameInput).fill(options.name);
    }
    if (options.usage !== undefined) {
      await this.page.getByTestId(TID.trackUsageSelect).selectOption(options.usage);
    }
    if (options.maxCars !== undefined) {
      await this.page.getByTestId(TID.trackMaxCars).fill(String(options.maxCars));
    }
    if (options.hasPlatform !== undefined) {
      await this.setCheck(TID.trackHasPlatform, options.hasPlatform);
    }
    if (options.canTurnBack !== undefined) {
      await this.setCheck(TID.trackCanTurnBack, options.canTurnBack);
    }
    if (options.canBeOvertaken !== undefined) {
      await this.setCheck(TID.trackCanBeOvertaken, options.canBeOvertaken);
    }
    if (options.down !== undefined) await this.setCheck(TID.trackDirectionDown, options.down);
    if (options.up !== undefined) await this.setCheck(TID.trackDirectionUp, options.up);

    await this.page.getByTestId(TID.trackAdd).click();
    await expect(this.trackRows).toHaveCount(before + 1);
    await this.app.settle();
  }

  /** Toggle 下り / 上り for an existing 番線 from the table. */
  async setTrackDirection(
    trackName: string,
    direction: 'down' | 'up',
    on: boolean,
  ): Promise<void> {
    const label = `${trackName} の${direction === 'down' ? '下り' : '上り'}`;
    const box = this.trackRow(trackName).getByLabel(label);
    if ((await box.isChecked()) !== on) await box.click();
    await expect(box).toBeChecked({ checked: on });
    await this.app.settle();
  }

  /** Make a 番線 the station's default road for a direction (the 既定 radio). */
  async makeDefaultTrack(trackName: string, direction: 'down' | 'up'): Promise<void> {
    const label = `${trackName} を${direction === 'down' ? '下り' : '上り'}既定にする`;
    const radio = this.trackRow(trackName).getByLabel(label);
    await radio.check();
    await expect(radio).toBeChecked();
    await this.app.settle();
  }

  async trackCanBeOvertaken(trackName: string): Promise<boolean> {
    return this.trackRow(trackName).getByLabel(`${trackName} の待避可`).isChecked();
  }

  // -- 駅間 ----------------------------------------------------------------

  get linkRows(): Locator {
    return this.page.getByTestId(TID.linkRow);
  }

  /**
   * Type the base run time into every 駅間 row.
   *
   * The first keystroke here is what creates the 標準性能 profile — the app
   * makes it on demand rather than stranding the user behind a disabled input.
   */
  async fillRunTimes(seconds: number): Promise<void> {
    const rows = await this.linkRows.count();
    expect(rows).toBeGreaterThan(0);
    for (let i = 0; i < rows; i++) {
      await this.linkRows.nth(i).getByTestId(TID.linkRunTimeInput).fill(String(seconds));
      await expect(this.linkRows.nth(i).getByTestId(TID.linkRunTimeInput)).toHaveValue(
        String(seconds),
      );
    }
    await this.app.settle();
  }

  // -- 車庫 ----------------------------------------------------------------

  get depotRows(): Locator {
    return this.page.getByTestId(TID.depotRow);
  }

  async addDepot(name: string, attachedStationName: string): Promise<void> {
    const before = await this.depotRows.count();
    await this.page.getByTestId(TID.depotNameInput).fill(name);
    await this.page
      .getByTestId(TID.depotStationSelect)
      .selectOption({ label: attachedStationName });
    await this.page.getByTestId(TID.depotAdd).click();
    await expect(this.depotRows).toHaveCount(before + 1);
    await this.app.settle();
  }

  // -- 構内ダイヤ -----------------------------------------------------------

  get yardChart(): Locator {
    return this.page.getByTestId(TID.yardChart);
  }

  get yardConflicts(): Locator {
    return this.page.getByTestId(TID.yardConflict);
  }

  yardLanes(): Locator {
    return this.page.locator(`[data-testid^="yard-lane-"]`);
  }

  yardBars(): Locator {
    return this.page.locator(`[data-testid^="yard-bar-"]`);
  }
}
