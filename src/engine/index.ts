/**
 * Public engine surface. The concrete implementations live in the sibling
 * modules; this file is the import target for everyone else so that internal
 * file layout can change without touching call sites.
 */

export * from './types';
export { buildIndex } from './buildIndex';
export { trainRuntimeAt, interpolateKm } from './position';
export { snapshotAt, snapshotInto, createEmptySnapshot } from './snapshot';
export { detectOvertakes, detectConnections } from './overtake';
export { detectMeets } from './meet';
export { buildTrackIntervals } from './occupancy';
export { computeInspectionStatus, currentOdometerKm } from './inspection';
export { createClockDriver } from './clock';
export type { ClockDriver } from './clock';
