/**
 * What the generator needs to know about a line — and nothing else.
 *
 * `src/seed/generator/*` was always meant to be the line-agnostic layer, but
 * it read `../oimachi/facts` directly, so "agnostic" was an aspiration rather
 * than a property. This interface is the property: it names exactly the facts
 * the generator consults, and a second line satisfies it by supplying them.
 *
 * ## Stations are `StationId`s here, never keys
 *
 * The Oimachi facts file identifies stations by a short key — `'hatanodai'`,
 * `'saginumaDepot'` — which is the right thing *there*: it is a table of
 * researched facts about named places, and a union of 23 string literals
 * catches a typo at compile time. But the key is a convenience of that file,
 * not a concept of the generator, and letting it leak out cost twice:
 *
 * - Widening `Record<StationKey, StationId>` to `Record<string, StationId>`
 *   silently changes what `facts.S[k]` means under `noUncheckedIndexedAccess`
 *   — every lookup becomes `StationId | undefined` and every call site breaks.
 * - `Map<StationId, StationKey>` is not assignable to `Map<StationId, string>`
 *   at all, because `Map` is invariant in its value.
 *
 * Both problems are the same problem, and both vanish by not having the key.
 * The generator asks "which stations, in order" and gets stations.
 *
 * ## Line-specific tables are fields, not imports
 *
 * `overtakeStations`, the platform-less stations, the quadruple-track section:
 * these are facts about one railway that the generator has to consult. They
 * used to be module-level constants imported across the layer boundary, which
 * is what made the boundary fictional. As fields they are answered by whoever
 * built the facts, which is where the knowledge actually lives.
 */

import type {
  PerfProfileId,
  StationId,
  StationTrackId,
  TrainTypeId,
  DayTypeId,
} from '@/domain/ids';
import type {
  Direction,
  LinkRunTime,
  Station,
  StationTrack,
  StopPattern,
  TrainType,
} from '@/domain/model';

/**
 * What a road is for, from the timetable's point of view.
 *
 * `'om'` / `'dt'` name the two railways that share the tracks where the
 * Oimachi Line runs beside the Den-en-toshi Line, and a line with only one
 * railway on it simply uses one of them throughout. The names are historical;
 * what the generator does with them is compare a road's role against the
 * routing a train is booked over, and refuse the mismatch.
 */
export type TrackRole = 'om' | 'dt' | 'stabling' | 'depot';

export interface GeneratorFacts {
  dayTypeId: DayTypeId;
  stations: Station[];
  tracks: StationTrack[];
  trainTypes: TrainType[];
  stopPatterns: StopPattern[];

  stationById: ReadonlyMap<StationId, Station>;
  tracksOf: ReadonlyMap<StationId, StationTrack[]>;
  trackRole: ReadonlyMap<StationTrackId, TrackRole>;

  /** Passenger stations in `down` order. Depot stubs are not on it. */
  axisStations: readonly Station[];
  /**
   * The chain a 回送 may be pathed along, in km order, depot stubs included.
   *
   * Separate from `axisStations` because a depot is on the km axis but not on
   * the service one, and because which *end* it hangs off is a fact about the
   * place: 鷺沼車庫 is beyond the far end of the Oimachi Line, 長津田検車区 is
   * behind the origin of the Kodomonokuni Line. A list in km order says both.
   */
  deadheadAxis: readonly Station[];

  /** 待避可能駅 and the directions each allows. Declared overtakes are checked against it. */
  overtakeAt: ReadonlyMap<StationId, readonly Direction[]>;
  /** Stations this line has no platform at — a 回送 runs through them. */
  noPlatformAt: ReadonlySet<StationId>;
  /** Stations where the inner/outer pair of a 方向別複々線 has to be chosen. */
  chooseRailPairAt: ReadonlySet<StationId>;
  /**
   * Within `chooseRailPairAt`, stations where a train that *starts or finishes*
   * there must be on this line's own faces, whatever pair it is booked over.
   *
   * 溝の口 is the case: the Oimachi Line ends there, so a 各停(青) that ran the
   * outer pair through the quad section still has to terminate on 2・3番線.
   * The outer faces belong to a railway this document does not model, and a
   * train left standing on one only *looks* berthed.
   */
  railPairTerminusAt: ReadonlySet<StationId>;
  /**
   * Stations where every train of this line uses this line's own faces, even
   * one about to cross to the other pair — because the crossover is out on the
   * open line rather than in the station. 二子玉川 is the case.
   */
  ownRailsOnlyAt: ReadonlySet<StationId>;

  deadheadProfileId: PerfProfileId;
  deadheadTypeId: TrainTypeId;
  /**
   * 続行時隔 a 回送 is required to keep from every already-placed train.
   *
   * A field rather than a constant because it has to be at least the line's
   * own `Link.minHeadwaySec`. Hard-coded, the path search would call a gap
   * usable that the validator then calls too tight — the generator putting
   * down something the checker rejects, which is the one outcome this seed is
   * built to avoid.
   */
  deadheadHeadwaySec: number;

  runTime(from: StationId, to: StationId, profileId: PerfProfileId): LinkRunTime;

  /**
   * Is the section joining these two adjacent stations 単線?
   *
   * Symmetric — a section does not have a direction, which is the entire
   * point. The path search for a 回送 has to ask it because an empty move is
   * the one train whose timings are still free when it is planned, and on a
   * single line "is this section clear" means clear of *both* directions.
   *
   * This is the same question `headway.singleTrackOpposing` asks of a finished
   * document. It has to be the same question: a generator that places a path
   * the checker then rejects is worse than one that fails outright.
   */
  isSingleTrack(a: StationId, b: StationId): boolean;
}
