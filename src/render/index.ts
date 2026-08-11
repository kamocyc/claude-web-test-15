/**
 * The render stream's public surface.
 *
 * The UI stream imports the three components and, once, wires the scene source
 * (`setRenderSceneSource`) so the views can read application state
 * imperatively inside the animation frame. Nothing here imports from
 * `src/ui` — the dependency runs one way.
 */

// Side effect: installs the app's stores as the default scene source, so the
// three components work as soon as they are mounted.
import './storeScene';

export * from './types';
export { LineViewCanvas } from './lineView/LineViewCanvas';
export { StringDiagramCanvas } from './stringDiagram/StringDiagramCanvas';
export { StationYardChart } from './stationYard/StationYardChart';
export { StationWiringDiagram } from './stationWiring/StationWiringDiagram';
export { CrewDutyChart } from './crewDuty/CrewDutyChart';
export { computeCrewChartLayout, rowAtY, CREW_LANE_H } from './crewDuty/layout';
export type { CrewChartBar, CrewChartLayout, CrewChartRow } from './crewDuty/layout';
export {
  clampTimeWindow,
  niceTimeTicks,
  panTimeWindow,
  timeScale,
  zoomTimeWindow,
  TIME_TICK_STEPS,
  TIME_TICK_MIN_PX,
  type TimeScale,
  type TimeWindow,
} from './timeAxis';
export { computeWiringDiagram, routesOfRoad } from './stationWiring/layout';

// State wiring -------------------------------------------------------------
export {
  getRenderScene,
  hasRenderScene,
  setDefaultRenderSceneSource,
  setRenderSceneSource,
  staticSceneSource,
  subscribeRenderScene,
  SHADOW_HZ,
  type RenderScene,
  type RenderSceneSource,
} from './scene';
export { connectRenderToStores, storeSceneSource } from './storeScene';

// Frame loop ---------------------------------------------------------------
export { registerFrameTask, renderOnce, requestFrame, stopLoop } from './canvas/rafLoop';

// Camera — exported so the shell can implement "focus this issue". ----------
export {
  centerOn,
  createCamera,
  fitToBounds,
  screenToWorld,
  worldToScreen,
  type Camera2D,
  type WorldBounds,
} from './canvas/camera';

// Layouts, for panels that need the same geometry the canvas uses. ----------
export { computeLineLayout, LANE_HEIGHT, type LineLayout } from './lineView/layout';
export {
  computeDiagramLayout,
  type DiagramLayout,
  type VerticalScale,
} from './stringDiagram/layout';
export { computeYardLayout, type YardLayout } from './stationYard/layout';

export { getTheme, resetThemeCache, type RenderTheme } from './canvas/theme';
export { digestOf } from './testHooks';
