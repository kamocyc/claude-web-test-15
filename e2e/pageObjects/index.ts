/**
 * Page objects for the railway operation simulator.
 *
 * The headline spec should read like the requirement it proves, so every
 * locator, every wait and every "click the add button then confirm the row
 * appeared" handshake lives behind one of these classes.
 */

import type { Page } from '@playwright/test';

import { AppPage } from './appPage';
import { DiagramPage } from './diagramPage';
import { DutiesPage } from './dutiesPage';
import { FormationsPage } from './formationsPage';
import { InspectionsPage } from './inspectionsPage';
import { LineViewPage } from './lineViewPage';
import { StationsPage } from './stationsPage';
import { TimetablePage } from './timetablePage';
import { TypesPage } from './typesPage';

export { AppPage } from './appPage';
export { DiagramPage } from './diagramPage';
export { DutiesPage } from './dutiesPage';
export { FormationsPage } from './formationsPage';
export { InspectionsPage } from './inspectionsPage';
export { LineViewPage } from './lineViewPage';
export { StationsPage } from './stationsPage';
export { TimetablePage } from './timetablePage';
export { TypesPage } from './typesPage';
export type { MarkerRow } from './lineViewPage';

/** Every screen, wired to one browser page. */
export class Simulator {
  readonly app: AppPage;
  readonly stations: StationsPage;
  readonly types: TypesPage;
  readonly timetable: TimetablePage;
  readonly duties: DutiesPage;
  readonly formations: FormationsPage;
  readonly line: LineViewPage;
  readonly diagram: DiagramPage;
  readonly inspections: InspectionsPage;

  constructor(readonly page: Page) {
    this.app = new AppPage(page);
    this.stations = new StationsPage(this.app);
    this.types = new TypesPage(this.app);
    this.timetable = new TimetablePage(this.app);
    this.duties = new DutiesPage(this.app);
    this.formations = new FormationsPage(this.app);
    this.line = new LineViewPage(this.app);
    this.diagram = new DiagramPage(this.app);
    this.inspections = new InspectionsPage(this.app);
  }

  /** Open the app in deterministic mode. */
  async open(query?: string): Promise<void> {
    await this.app.open(query);
  }

  /**
   * Look a station's id up by name, through the 駅・線路 list.
   *
   * Leaves the app on that screen — callers navigate on afterwards.
   */
  async stationIdByName(name: string): Promise<string> {
    await this.stations.open();
    return this.stations.stationIdOf(name);
  }
}
