/** 種別・パターン — train types and the stop-pattern matrix. */

import { expect, type Locator, type Page } from '@playwright/test';

import { TID } from '../testids';
import type { AppPage } from './appPage';

export type CellKind = 'stop' | 'pass' | 'none';

export class TypesPage {
  readonly page: Page;

  constructor(readonly app: AppPage) {
    this.page = app.page;
  }

  async open(): Promise<void> {
    await this.app.goto('types');
    await expect(this.page.getByTestId(TID.trainTypeList)).toBeVisible();
  }

  get typeRows(): Locator {
    return this.page.getByTestId(TID.trainTypeRow);
  }

  typeRow(name: string): Locator {
    return this.typeRows.filter({ has: this.page.getByLabel(`${name} の名称`) });
  }

  async addType(name: string, shortName: string): Promise<void> {
    const before = await this.typeRows.count();
    await this.page.getByTestId(TID.trainTypeNameInput).fill(name);
    await this.page.getByTestId(TID.trainTypeShortInput).fill(shortName);
    await this.page.getByTestId(TID.trainTypeAdd).click();
    await expect(this.typeRows).toHaveCount(before + 1);
    await expect(this.typeRow(name)).toHaveCount(1);
    await this.app.settle();
  }

  async typeIdOf(name: string): Promise<string> {
    const id = await this.typeRow(name).getAttribute('data-type-id');
    expect(id, `train type ${name} should exist`).not.toBeNull();
    return id as string;
  }

  /** Create a stop pattern; it starts out stopping at every station. */
  async addPattern(options: {
    name: string;
    typeName: string;
    direction?: 'down' | 'up' | 'both';
    origin: string;
    terminus: string;
  }): Promise<void> {
    await this.page.getByTestId(TID.patternNameInput).fill(options.name);
    await this.page.getByTestId(TID.patternTypeSelect).selectOption({ label: options.typeName });
    await this.page
      .getByTestId(TID.patternDirectionSelect)
      .selectOption(options.direction ?? 'down');
    await this.page.getByTestId(TID.patternOriginSelect).selectOption({ label: options.origin });
    await this.page
      .getByTestId(TID.patternTerminusSelect)
      .selectOption({ label: options.terminus });
    await this.page.getByTestId(TID.patternAdd).click();
    await expect(this.page.getByTestId(TID.patternMatrix)).toBeVisible();
    await this.app.settle();
  }

  matrix(): Locator {
    return this.page.getByTestId(TID.patternMatrix);
  }

  cell(patternId: string, stationId: string): Locator {
    return this.page.getByTestId(TID.patternCell(patternId, stationId));
  }

  /** Click a matrix cell until it shows the wanted 停 / 通 / − state. */
  async setCell(patternId: string, stationId: string, want: CellKind): Promise<void> {
    const cell = this.cell(patternId, stationId);
    for (let i = 0; i < 4; i++) {
      if ((await cell.getAttribute('data-kind')) === want) break;
      await cell.click();
    }
    await expect(cell).toHaveAttribute('data-kind', want);
    await this.app.settle();
  }

  /** The pattern ids currently rendered as matrix columns, in column order. */
  async patternIds(): Promise<string[]> {
    const ids = await this.page
      .locator(`[data-testid^="pattern-cell-"]`)
      .evaluateAll((nodes) =>
        nodes.map((n) => (n.getAttribute('data-testid') ?? '').replace('pattern-cell-', '')),
      );
    const out: string[] = [];
    for (const composite of ids) {
      const patternId = composite.split('-stn-')[0];
      if (patternId !== undefined && !out.includes(patternId)) out.push(patternId);
    }
    return out;
  }
}
