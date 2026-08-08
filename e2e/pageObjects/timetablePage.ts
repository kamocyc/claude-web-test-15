/** 時刻表 — the OuDia-style grid, its 列車を追加 form and the keyboard editor. */

import { expect, type Locator, type Page } from '@playwright/test';

import { TID } from '../testids';
import type { AppPage } from './appPage';

export class TimetablePage {
  readonly page: Page;

  constructor(readonly app: AppPage) {
    this.page = app.page;
  }

  async open(): Promise<void> {
    await this.app.goto('timetable');
    await expect(this.page.getByTestId(TID.trainAdd)).toBeVisible();
  }

  get grid(): Locator {
    return this.page.getByTestId(TID.timetableGrid);
  }

  /** Every rendered train column. Columns are virtualized, so this is a window. */
  columns(): Locator {
    return this.page.locator('[data-testid^="train-col-"]');
  }

  column(trainId: string): Locator {
    return this.page.getByTestId(TID.trainColumn(trainId));
  }

  /** Add a train through the 列車を追加 form and return its id. */
  async addTrain(options: {
    number: string;
    typeName: string;
    patternName?: string;
    originDep: string;
  }): Promise<string> {
    const before = await this.columns().count();
    await this.page.getByTestId(TID.trainNumberInput).fill(options.number);
    await this.page.getByTestId(TID.trainTypeSelect).selectOption({ label: options.typeName });
    if (options.patternName !== undefined) {
      await this.page
        .getByTestId(TID.trainPatternSelect)
        .selectOption({ label: options.patternName });
    }
    await this.page.getByTestId(TID.trainOriginDepInput).fill(options.originDep);
    await this.page.getByTestId(TID.trainAdd).click();
    await expect(this.columns()).toHaveCount(before + 1);
    await this.app.settle();
    return this.trainIdOf(options.number);
  }

  /** Look a train's id up from the column header, never from the store. */
  async trainIdOf(number: string): Promise<string> {
    const column = this.columns().filter({ hasText: number }).first();
    await expect(column).toHaveCount(1);
    const id = await column.getAttribute('data-testid');
    expect(id).not.toBeNull();
    return (id as string).replace('train-col-', '');
  }

  timeCell(trainId: string, stopIndex: number, field: 'arr' | 'dep'): Locator {
    return this.page.getByTestId(TID.timeCell(trainId, stopIndex, field));
  }

  trackCell(trainId: string, stopIndex: number): Locator {
    return this.page.getByTestId(TID.trackCell(trainId, stopIndex));
  }

  /** Read the underlying seconds a cell holds (`data-value`), not its text. */
  async cellSeconds(
    trainId: string,
    stopIndex: number,
    field: 'arr' | 'dep',
  ): Promise<number | undefined> {
    const raw = await this.timeCell(trainId, stopIndex, field).getAttribute('data-value');
    return raw === null || raw === '' ? undefined : Number(raw);
  }

  /**
   * Edit one cell exactly the way a timetable author does: focus it, type
   * `0805`, press Enter.
   */
  async typeTime(
    trainId: string,
    stopIndex: number,
    field: 'arr' | 'dep',
    text: string,
  ): Promise<void> {
    const cell = this.timeCell(trainId, stopIndex, field);
    await cell.click();
    await expect(cell).toBeFocused();
    await cell.fill(text);
    await cell.press('Enter');
    await this.app.settle();
  }

  /** Select a train by clicking its column header. */
  async selectTrain(trainId: string): Promise<void> {
    await this.column(trainId).locator('button').first().click();
    await this.app.settle();
  }

  async recomputeTimes(): Promise<void> {
    await this.page.getByTestId(TID.recomputeTimes).click();
    await this.app.settle();
  }

  async autoAssignTracks(): Promise<void> {
    await this.page.getByTestId(TID.autoAssignTracks).click();
    await this.app.settle();
  }
}
