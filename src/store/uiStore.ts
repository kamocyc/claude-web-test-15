/**
 * View state: which screen is showing, what is selected, and where the app was
 * last told to look.
 *
 * `focusOn` is the one cross-view jump. The problem panel, the canvases and the
 * editors all call it; each view honours `focusTarget` in whatever way makes
 * sense for it (scroll a row into view, pan a camera, expand a group).
 */

import { create } from 'zustand';

import type { Sec, Meters } from '@/domain/units';
import type { EntityRef } from '@/validation/types';
import { ROUTES, type RouteName } from '@e2e/testids';

import { useClockStore } from './clockStore';

export interface FocusTarget {
  ref: EntityRef;
  at?: Sec;
  km?: Meters;
  /** Bumped on every focus so a view can react even to a repeated target. */
  seq: number;
}

export interface FocusRequest {
  ref: EntityRef;
  at?: Sec;
  km?: Meters;
}

export interface UiStoreState {
  route: RouteName;
  selected: EntityRef[];
  hovered: EntityRef | undefined;
  focusTarget: FocusTarget | undefined;
  problemPanelOpen: boolean;
  inspectorOpen: boolean;
  setRoute(route: RouteName): void;
  select(ref: EntityRef | undefined, additive?: boolean): void;
  setSelected(refs: EntityRef[]): void;
  setHovered(ref: EntityRef | undefined): void;
  focusOn(request: FocusRequest): void;
  toggleProblemPanel(): void;
  toggleInspector(): void;
}

/** Routes that can already show a given kind of entity, best first. */
const ROUTE_FOR_KIND: Record<EntityRef['kind'], RouteName[]> = {
  train: [ROUTES.timetable, ROUTES.diagram, ROUTES.line],
  station: [ROUTES.stations, ROUTES.line, ROUTES.diagram],
  stationTrack: [ROUTES.stations, ROUTES.timetable],
  link: [ROUTES.stations, ROUTES.line],
  duty: [ROUTES.duties, ROUTES.diagram],
  formation: [ROUTES.formations, ROUTES.duties],
  depot: [ROUTES.stations, ROUTES.line],
  inspection: [ROUTES.inspections, ROUTES.formations],
};

export function refKey(ref: EntityRef): string {
  switch (ref.kind) {
    case 'train':
      return `train:${ref.trainId}`;
    case 'station':
      return `station:${ref.stationId}`;
    case 'stationTrack':
      return `stationTrack:${ref.stationTrackId}`;
    case 'link':
      return `link:${ref.linkId}`;
    case 'duty':
      return `duty:${ref.dutyId}`;
    case 'formation':
      return `formation:${ref.formationId}`;
    case 'depot':
      return `depot:${ref.depotId}`;
    case 'inspection':
      return `inspection:${ref.formationId}:${ref.ruleId}`;
    default:
      return JSON.stringify(ref);
  }
}

let focusSeq = 0;

export const useUiStore = create<UiStoreState>((set, get) => ({
  route: ROUTES.timetable,
  selected: [],
  hovered: undefined,
  focusTarget: undefined,
  problemPanelOpen: true,
  inspectorOpen: true,

  setRoute: (route) => set({ route }),

  select: (ref, additive = false) => {
    if (ref === undefined) {
      set({ selected: [] });
      return;
    }
    if (!additive) {
      set({ selected: [ref] });
      return;
    }
    const key = refKey(ref);
    const current = get().selected;
    const without = current.filter((r) => refKey(r) !== key);
    set({ selected: without.length === current.length ? [...current, ref] : without });
  },

  setSelected: (refs) => set({ selected: refs }),

  setHovered: (ref) => set({ hovered: ref }),

  focusOn: ({ ref, at, km }) => {
    if (at !== undefined) useClockStore.getState().seek(at);

    const candidates = ROUTE_FOR_KIND[ref.kind] ?? [];
    const current = get().route;
    const route = candidates.includes(current) ? current : (candidates[0] ?? current);

    focusSeq += 1;
    const target: FocusTarget = { ref, seq: focusSeq };
    if (at !== undefined) target.at = at;
    if (km !== undefined) target.km = km;

    set({ route, selected: [ref], focusTarget: target });
  },

  toggleProblemPanel: () => set({ problemPanelOpen: !get().problemPanelOpen }),
  toggleInspector: () => set({ inspectorOpen: !get().inspectorOpen }),
}));

/** Convenience for the many call sites that focus a bare ref. */
export function focusOn(ref: EntityRef, at?: Sec, km?: Meters): void {
  const request: FocusRequest = { ref };
  if (at !== undefined) request.at = at;
  if (km !== undefined) request.km = km;
  useUiStore.getState().focusOn(request);
}
