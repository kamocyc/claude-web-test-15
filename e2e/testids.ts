/**
 * The single catalogue of `data-testid` values.
 *
 * Imported by BOTH `src/ui/**` and the Playwright page objects, so renaming a
 * testid is a TypeScript error rather than a test that mysteriously starts
 * failing. Add entries here first, then use them on both sides.
 */

export const TID = {
  // shell ------------------------------------------------------------------
  app: 'app',
  navLink: (route: string) => `nav-${route}`,
  menuFile: 'menu-file',
  menuNewProject: 'menu-new-project',
  menuLoadSample: 'menu-load-sample',
  menuImport: 'menu-import',
  menuExport: 'menu-export',
  undo: 'undo',
  redo: 'redo',
  statusBar: 'status-bar',
  statusTrainCount: 'status-train-count',
  statusErrorCount: 'status-error-count',
  statusWarningCount: 'status-warning-count',

  // transport bar ----------------------------------------------------------
  transportBar: 'transport-bar',
  playPause: 'play-pause',
  clockReadout: 'clock-readout',
  clockSlider: 'clock-slider',
  speedSelect: 'speed-select',
  dateInput: 'date-input',
  dayTypeSelect: 'day-type-select',

  // problem panel ----------------------------------------------------------
  problemPanel: 'problem-panel',
  problemList: 'problem-list',
  problemItem: 'problem-item',
  problemFilterError: 'problem-filter-error',
  problemFilterWarning: 'problem-filter-warning',
  problemFilterInfo: 'problem-filter-info',
  problemEmpty: 'problem-empty',

  // stations ---------------------------------------------------------------
  stationList: 'station-list',
  stationRow: 'station-row',
  stationAdd: 'station-add',
  stationNameInput: 'station-name-input',
  stationKmInput: 'station-km-input',
  stationCodeInput: 'station-code-input',
  stationSubmit: 'station-submit',
  stationSelect: 'station-select',
  stationMinDwell: 'station-min-dwell',
  stationMinTurnback: 'station-min-turnback',
  stationIsConnectionPoint: 'station-is-connection-point',

  // station tracks (番線) ---------------------------------------------------
  trackList: 'track-list',
  trackRow: 'track-row',
  trackAdd: 'track-add',
  trackNameInput: 'track-name-input',
  trackUsageSelect: 'track-usage-select',
  trackHasPlatform: 'track-has-platform',
  trackCanTurnBack: 'track-can-turn-back',
  trackCanBeOvertaken: 'track-can-be-overtaken',
  trackMaxCars: 'track-max-cars',
  trackDirectionDown: 'track-direction-down',
  trackDirectionUp: 'track-direction-up',
  trackSubmit: 'track-submit',

  // links ------------------------------------------------------------------
  linkList: 'link-list',
  linkRow: 'link-row',
  linkRunTimeInput: 'link-run-time-input',
  linkHeadwayInput: 'link-headway-input',

  // depots -----------------------------------------------------------------
  depotList: 'depot-list',
  depotRow: 'depot-row',
  depotAdd: 'depot-add',
  depotNameInput: 'depot-name-input',
  depotStationSelect: 'depot-station-select',
  depotAccessSecInput: 'depot-access-sec-input',
  depotCapacityInput: 'depot-capacity-input',
  depotSubmit: 'depot-submit',

  // train types & patterns -------------------------------------------------
  trainTypeList: 'train-type-list',
  trainTypeRow: 'train-type-row',
  trainTypeAdd: 'train-type-add',
  trainTypeNameInput: 'train-type-name-input',
  trainTypeShortInput: 'train-type-short-input',
  trainTypeColorInput: 'train-type-color-input',
  trainTypeSubmit: 'train-type-submit',
  patternAdd: 'pattern-add',
  patternNameInput: 'pattern-name-input',
  patternTypeSelect: 'pattern-type-select',
  patternDirectionSelect: 'pattern-direction-select',
  patternOriginSelect: 'pattern-origin-select',
  patternTerminusSelect: 'pattern-terminus-select',
  patternSubmit: 'pattern-submit',
  patternMatrix: 'pattern-matrix',
  /** One cell of the stop-pattern matrix. Click cycles 停 → 通 → −. */
  patternCell: (patternId: string, stationId: string) => `pattern-cell-${patternId}-${stationId}`,

  // timetable grid ---------------------------------------------------------
  timetableGrid: 'timetable-grid',
  trainAdd: 'train-add',
  trainNumberInput: 'train-number-input',
  trainTypeSelect: 'train-type-select',
  trainPatternSelect: 'train-pattern-select',
  trainOriginDepInput: 'train-origin-dep-input',
  trainSubmit: 'train-submit',
  trainColumn: (trainId: string) => `train-col-${trainId}`,
  /** field is 'arr' | 'dep'. */
  timeCell: (trainId: string, stopIndex: number, field: string) =>
    `time-cell-${trainId}-${stopIndex}-${field}`,
  trackCell: (trainId: string, stopIndex: number) => `track-cell-${trainId}-${stopIndex}`,
  autoAssignTracks: 'auto-assign-tracks',
  recomputeTimes: 'recompute-times',

  // duties -----------------------------------------------------------------
  dutyBoard: 'duty-board',
  dutyAdd: 'duty-add',
  dutyCodeInput: 'duty-code-input',
  dutySubmit: 'duty-submit',
  dutyRow: (dutyId: string) => `duty-row-${dutyId}`,
  dutyLeg: (dutyId: string, legIndex: number) => `duty-leg-${dutyId}-${legIndex}`,
  dutyAutoAssign: 'duty-auto-assign',
  unassignedTrains: 'unassigned-trains',
  unassignedTrain: (trainId: string) => `unassigned-train-${trainId}`,
  /** Keyboard/menu path used by E2E in place of drag and drop. */
  addTrainToDuty: (trainId: string) => `add-train-to-duty-${trainId}`,
  addTrainToDutyChoice: (dutyId: string) => `add-train-to-duty-choice-${dutyId}`,
  dutyFormationSelect: (dutyId: string) => `duty-formation-select-${dutyId}`,

  // formations & inspections -----------------------------------------------
  formationList: 'formation-list',
  formationRow: (formationId: string) => `formation-row-${formationId}`,
  formationAdd: 'formation-add',
  formationCodeInput: 'formation-code-input',
  formationSeriesSelect: 'formation-series-select',
  formationCarsInput: 'formation-cars-input',
  formationDepotSelect: 'formation-depot-select',
  formationOdometerInput: 'formation-odometer-input',
  formationSubmit: 'formation-submit',
  seriesAdd: 'series-add',
  seriesNameInput: 'series-name-input',
  seriesCarsInput: 'series-cars-input',
  seriesSubmit: 'series-submit',
  inspectionTable: 'inspection-table',
  inspectionBadge: (formationId: string, kind: string) => `inspection-badge-${formationId}-${kind}`,
  inspectionSchedule: (formationId: string) => `inspection-schedule-${formationId}`,
  inspectionRuleList: 'inspection-rule-list',

  // line view --------------------------------------------------------------
  lineView: 'line-view',
  lineViewCanvas: 'line-view-canvas',
  /** Hidden DOM shadow of what the canvas drew. Primary E2E assertion target. */
  lineViewTrains: 'line-view-trains',
  trainMarker: 'train-marker',
  lineViewDepot: (depotId: string) => `line-view-depot-${depotId}`,
  lineViewLegend: 'line-view-legend',

  // string diagram (運行図表) ------------------------------------------------
  diagram: 'diagram',
  diagramCanvas: 'diagram-canvas',
  diagramTrains: 'diagram-trains',
  diagramTrainLine: 'diagram-train-line',
  overtakeMarker: 'overtake-marker',
  connectionMarker: 'connection-marker',
  diagramShowDeadhead: 'diagram-show-deadhead',
  diagramHighlightDuty: 'diagram-highlight-duty',

  // station yard chart (構内ダイヤ) -------------------------------------------
  yardChart: 'yard-chart',
  yardChartStationSelect: 'yard-chart-station-select',
  yardLane: (trackId: string) => `yard-lane-${trackId}`,
  yardBar: (trainId: string) => `yard-bar-${trainId}`,
  yardConflict: 'yard-conflict',

  // inspector --------------------------------------------------------------
  inspector: 'inspector',
  inspectorTitle: 'inspector-title',
} as const;

/**
 * Root-level state attributes. Playwright waits on these instead of sleeping —
 * there is no `waitForTimeout` anywhere in the suite.
 */
export const STATE_ATTR = {
  /** 'running' | 'idle' */
  validation: 'data-validation-state',
  /** 'saving' | 'saved' | 'idle' | 'error' */
  autosave: 'data-autosave-state',
  /** '1' once the app has mounted and the first index is built. */
  ready: 'data-sim-ready',
  /** Increments whenever the simulation index is rebuilt. */
  indexGeneration: 'data-index-generation',
} as const;

export const ROUTES = {
  line: 'line',
  diagram: 'diagram',
  timetable: 'timetable',
  duties: 'duties',
  formations: 'formations',
  stations: 'stations',
  types: 'types',
  inspections: 'inspections',
} as const;

export type RouteName = (typeof ROUTES)[keyof typeof ROUTES];
