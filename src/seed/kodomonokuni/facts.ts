/**
 * 東急こどもの国線 — the facts, as plain data.
 *
 * ===========================================================================
 * PROVENANCE — read this before trusting any number in this file
 * ===========================================================================
 *
 * **This file is a larger reconstruction than `oimachi/facts.ts` is, and the
 * difference matters.** The Oimachi Line's structure — its passing places, its
 * quadruple-track section, its stub terminal — was researched, and only the
 * clock was invented. Here the operating pattern *itself* was specified by the
 * person who asked for the line, as an intent rather than as a finding. What
 * follows separates the two as carefully as it can.
 *
 * **Researched fact** (structure that is verifiably true of the real line):
 *   - three stations — 長津田 / 恩田 / こどもの国 — in that order, with 恩田
 *     roughly midway;
 *   - the line is about 3.4 km long and is single track throughout;
 *   - it is operated by 東急電鉄 over infrastructure owned by 横浜高速鉄道
 *     (第三種鉄道事業者);
 *   - rolling stock is the Y000系 in two-car sets, and there are three of them;
 *   - it is worked ワンマン — driver only, no conductor;
 *   - 長津田 and こどもの国 are both single-platform terminals, and a train
 *     reverses on the platform it arrived at;
 *   - 恩田 is adjacent to 東急テクノシステム長津田工場.
 *
 * **Approximate** (good enough for the drawing and the clock, not surveyed):
 *   - 恩田 at 1.8 km and こどもの国 at 3.4 km. Only the *ratio* of the two hops
 *     affects anything here — it decides whether a meet at 恩田 is symmetric.
 *   - the Y000系 commissioning dates, which are used only to date the
 *     inspection history backwards from.
 *
 * **Reconstruction — INCLUDING THE PREMISE.** Invented here, consistent with
 * the structure above, but NOT copied from any published source:
 *   - **恩田 as a passing place (1面2線).** The real track layout at 恩田 was
 *     not researched. A 交換駅 there is the arrangement this document was
 *     asked to model, not a fact this file establishes.
 *   - **「ラッシュ時のみ恩田で交換」.** Likewise the operating pattern: two sets
 *     in the peaks meeting once a cycle, one set shuttling the rest of the
 *     day. Stated as the intended model, not as a property of the real
 *     timetable, which was not consulted.
 *   - every `baseRunSec`, `startPenaltySec`, `stopPenaltySec`, `minDwellSec`,
 *     `minTurnbackSec`, `approachSec`, `clearSec`, `minHeadwaySec`;
 *   - all 列車番号, all 運用番号, all 行路番号;
 *   - 長津田検車区 drawn as a four-road stub of this line, and the works at 恩田
 *     as a second depot node that only does heavy examinations;
 *   - the odometer readings and the inspection history.
 *
 * No sources are cited because none were consulted for the reconstructed part,
 * and citing one for the researched part would imply the rest was checked too.
 *
 * ## Why the numbers are round
 *
 * A clear run one way is **exactly 300 seconds**: 150 s 長津田→恩田, 20 s
 * standing, 130 s 恩田→こどもの国. That is deliberate. The whole interest of
 * this line is that a meet at 恩田 either works or does not, and a five-minute
 * half-journey makes both the 20-minute off-peak cycle and the 12-minute peak
 * cycle close exactly, so the meet is a consequence of the pattern rather than
 * a fudge in the run times. See `service.ts`.
 *
 * Determinism: every id comes from `makeIdFactory`, which is a plain counter.
 * There is no `Date`, no `Date.now()` and no `Math.random()`.
 */

import { ID_PREFIX, asId, makeIdFactory } from '@/domain/ids';
import type {
  DepotId,
  LinkId,
  PerfProfileId,
  SeriesId,
  StationId,
  StationTrackId,
  StopPatternId,
  TrainTypeId,
} from '@/domain/ids';
import type {
  Depot,
  Direction,
  FormationSeries,
  InspectionRule,
  Line,
  Link,
  LinkRunTime,
  PerfProfile,
  Station,
  StationCrossover,
  StationTrack,
  StopKind,
  StopPattern,
  TrainType,
  TrackWiring,
} from '@/domain/model';
import { kmToMeters, type Meters } from '@/domain/units';
import { SeedError } from '../errors';
import type { GeneratorFacts, TrackRole } from '../generator/facts';

// ---------------------------------------------------------------------------
// Station keys
// ---------------------------------------------------------------------------

export const STATION_KEYS = [
  'nagatsutaDepot',
  'nagatsuta',
  'onda',
  'nagatsutaWorks',
  'kodomonokuni',
] as const;

export type StationKey = (typeof STATION_KEYS)[number];

/** The three passenger stations, in `down` order. */
export const LINE_KEYS: readonly StationKey[] = ['nagatsuta', 'onda', 'kodomonokuni'];

/**
 * 交換可能駅 — where two trains can be at once.
 *
 * The single entry is the whole operating problem of this line. It is also,
 * unlike the Oimachi Line's table, a *reconstruction*: see the header.
 *
 * The generator reads this as `overtakeAt`, which is the 待避 table. On a
 * single line the two questions have the same answer — the second road is the
 * second road, whether the train it holds is being passed by one going the
 * same way or one coming the other. Nothing on this line overtakes, so the
 * entry exists to state where a train can stand aside at all.
 */
export const PASSING_STATIONS: Readonly<Record<string, readonly Direction[]>> = {
  onda: ['down', 'up'],
};

/** 2両編成. */
export const CARS = 2;

// ---------------------------------------------------------------------------
// Track layouts
// ---------------------------------------------------------------------------

/** The yard lead every stabling road fans off. */
const YARD_LEAD = '構内';

const MAIN = { approachSec: 30, clearSec: 20 } as const;
const LOOP = { approachSec: 45, clearSec: 30 } as const;
const YARD = { approachSec: 60, clearSec: 60 } as const;

interface TrackSpec {
  name: string;
  number?: number;
  usage: StationTrack['usage'];
  hasPlatform: boolean;
  directions: Direction[];
  canTurnBack: boolean;
  canBeOvertaken: boolean;
  maxCars: number;
  approachSec: number;
  clearSec: number;
  role: TrackRole;
  wiring?: TrackWiring;
}

type LayoutKind =
  | 'throughTerminus' // 長津田: 1面1線, but open at both ends — the yard is beyond
  | 'passingLoop' // 恩田: 1面2線, the only place two trains can be at once
  | 'stubTerminus' // こどもの国: 1面1線 against the buffers
  | 'depotYard' // 長津田検車区: four roads off one lead
  | 'works'; // 長津田工場: two roads, heavy examinations only

function layoutTracks(kind: LayoutKind): TrackSpec[] {
  switch (kind) {
    case 'throughTerminus':
      // Trains terminate here, but the road is not a stub: the yard sits
      // beyond it at negative km, so the 上り方 throat is how a 出庫 gets in.
      return [
        {
          name: '1番線',
          number: 1,
          usage: 'main',
          hasPlatform: true,
          directions: ['down', 'up'],
          canTurnBack: true,
          canBeOvertaken: false,
          maxCars: 3,
          ...MAIN,
          role: 'om',
          wiring: { ends: ['down', 'up'], ladder: 0, line: ['down', 'up'] },
        },
      ];
    case 'passingLoop':
      // 1番線 is the road the running line goes straight into; 2番線 diverges.
      // That distinction is what makes the line view draw a 交換 as a dip out
      // of the through road and back, and it is why `line` is set on one road
      // and not the other.
      return [
        {
          name: '1番線',
          number: 1,
          usage: 'main',
          hasPlatform: true,
          directions: ['down', 'up'],
          canTurnBack: false,
          canBeOvertaken: false,
          maxCars: 3,
          ...MAIN,
          role: 'om',
          wiring: { ends: ['down', 'up'], ladder: 0, line: ['down', 'up'] },
        },
        {
          // A platform road, not a bare loop. Both trains in a meet here are
          // in service, and putting one of them on a road with no platform
          // would turn a passenger stop into a 運転停車 — on a line with three
          // stations there is no reason to do that to half the service.
          name: '2番線',
          number: 2,
          usage: 'passing',
          hasPlatform: true,
          directions: ['down', 'up'],
          canTurnBack: false,
          canBeOvertaken: true,
          maxCars: 3,
          ...LOOP,
          role: 'om',
          wiring: { ends: ['down', 'up'], ladder: 1 },
        },
      ];
    case 'stubTerminus':
      // Buffers at the 下り方 end; everything arrives and leaves by 上り方.
      return [
        {
          name: '1番線',
          number: 1,
          usage: 'main',
          hasPlatform: true,
          directions: ['down', 'up'],
          canTurnBack: true,
          canBeOvertaken: false,
          maxCars: 3,
          ...MAIN,
          role: 'om',
          wiring: { ends: ['up'], ladder: 0, line: ['down', 'up'] },
        },
      ];
    case 'depotYard':
      // Mirror image of 鷺沼車庫's throat. That yard is beyond the far end of
      // its line so its lead faces 上り方; this one sits behind the origin, at
      // negative km, so its lead faces 下り方. The km heuristic guesses the
      // wrong one in both cases, which is exactly why the end is authored.
      return Array.from({ length: 4 }, (_, i) => ({
        name: `留置${i + 1}番線`,
        number: i + 1,
        usage: 'stabling' as const,
        hasPlatform: false,
        directions: ['down', 'up'] as Direction[],
        canTurnBack: true,
        canBeOvertaken: false,
        maxCars: 4,
        ...YARD,
        role: 'depot' as TrackRole,
        wiring: { ends: ['down'] as const, ladder: i, connects: { down: [YARD_LEAD] } },
      }));
    case 'works':
      return [1, 2].map((n) => ({
        name: `工場${n}番線`,
        number: n,
        usage: 'depot' as const,
        hasPlatform: false,
        directions: ['down', 'up'] as Direction[],
        canTurnBack: true,
        canBeOvertaken: false,
        maxCars: 4,
        ...YARD,
        role: 'depot' as TrackRole,
        wiring: { ends: ['up'] as const, ladder: n - 1, connects: { up: [YARD_LEAD] } },
      }));
  }
}

/** 出入庫線 — the yard lead onto the running line, past every road turnout. */
const YARD_NECK: StationCrossover[] = [
  { end: 'down', from: YARD_LEAD, to: 'down', name: '出入庫線' },
  { end: 'down', from: YARD_LEAD, to: 'up', name: '出入庫線' },
];

const WORKS_NECK: StationCrossover[] = [
  { end: 'up', from: YARD_LEAD, to: 'down', name: '工場入出場線' },
  { end: 'up', from: YARD_LEAD, to: 'up', name: '工場入出場線' },
];

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

interface StationSpec {
  key: StationKey;
  name: string;
  kana: string;
  code?: string;
  km: number;
  minDwellSec: number;
  minTurnbackSec: number;
  layout: LayoutKind;
  kind?: Station['kind'];
  crossovers?: StationCrossover[];
  crewChange?: boolean;
  crewBase?: boolean;
  transfers?: string[];
}

const STATION_SPECS: readonly StationSpec[] = [
  {
    key: 'nagatsutaDepot',
    name: '長津田検車区',
    kana: 'ながつたけんしゃく',
    km: -0.6,
    minDwellSec: 30,
    minTurnbackSec: 300,
    layout: 'depotYard',
    kind: 'depot',
    crossovers: YARD_NECK,
    // 出庫回送に乗るのは車庫で乗り込む乗務員なので、ここが基地である。
    crewBase: true,
  },
  {
    key: 'nagatsuta',
    name: '長津田',
    kana: 'ながつた',
    code: 'KD01',
    km: 0.0,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'throughTerminus',
    transfers: ['東急田園都市線', 'JR横浜線'],
    // 乗務員基地. The shed is a base too — a driver taking the 出庫 out signs
    // on there — but 長津田 has to be one as well, and that is not a detail:
    // only the six empty moves touch the shed, so a covering that could only
    // begin and end there would have to 添乗 every single duty into place over
    // those six trains. Crews on a shuttle report to the station.
    crewBase: true,
  },
  {
    key: 'onda',
    name: '恩田',
    kana: 'おんだ',
    code: 'KD02',
    km: 1.8,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'passingLoop',
  },
  {
    key: 'nagatsutaWorks',
    name: '長津田工場',
    kana: 'ながつたこうじょう',
    km: 2.2,
    minDwellSec: 30,
    minTurnbackSec: 300,
    layout: 'works',
    kind: 'depot',
    crossovers: WORKS_NECK,
  },
  {
    key: 'kodomonokuni',
    name: 'こどもの国',
    kana: 'こどものくに',
    code: 'KD03',
    km: 3.4,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'stubTerminus',
    // 交代可能駅, though no relief is actually planned here.
    //
    // The model's edge for a crew is "can this person get from that train to
    // this one, at this station", and a driver reversing a two-car set at a
    // terminus is exactly that move — the same person, the same stock, the
    // other end of the train. Leaving こどもの国 out makes it impossible for
    // anybody to work a down train and then the up train it becomes, which on
    // a shuttle is the only shape a duty has: the covering falls apart into
    // one duty per pair of trains, each one 添乗ed into place from 長津田.
    //
    // The relief that is actually planned on this line all happens at 長津田.
    crewChange: true,
  },
];

// ---------------------------------------------------------------------------
// Performance, types, patterns
// ---------------------------------------------------------------------------

/**
 * Reconstruction. Chosen so a clear run is 150 s and 130 s over the two hops
 * — see the header on why the round numbers are the point.
 */
export const PENALTY = { startPenaltySec: 15, stopPenaltySec: 15 } as const;

export type TrainTypeKey = 'local' | 'deadhead';
export type PatternKey = 'localDown' | 'localUp';

interface PatternSpec {
  key: PatternKey;
  name: string;
  direction: Direction;
  originKey: StationKey;
  terminusKey: StationKey;
}

const PATTERN_SPECS: readonly PatternSpec[] = [
  {
    key: 'localDown',
    name: '各停 長津田→こどもの国',
    direction: 'down',
    originKey: 'nagatsuta',
    terminusKey: 'kodomonokuni',
  },
  {
    key: 'localUp',
    name: '各停 こどもの国→長津田',
    direction: 'up',
    originKey: 'kodomonokuni',
    terminusKey: 'nagatsuta',
  },
];

// ---------------------------------------------------------------------------
// Built facts
// ---------------------------------------------------------------------------

export interface Facts extends GeneratorFacts {
  line: Line;
  links: Link[];
  perfProfiles: PerfProfile[];
  linkRunTimes: LinkRunTime[];
  depots: Depot[];
  formationSeries: FormationSeries[];
  inspectionRules: InspectionRule[];

  S: Record<StationKey, StationId>;
  profileId: PerfProfileId;
  type: Record<TrainTypeKey, TrainTypeId>;
  pattern: Record<PatternKey, StopPatternId>;
  depotId: Record<'yard' | 'works', DepotId>;
  seriesId: SeriesId;
}

export function buildKodomonokuniFacts(): Facts {
  const nextStation = makeIdFactory(ID_PREFIX.station);
  const nextTrack = makeIdFactory(ID_PREFIX.stationTrack);
  const nextLink = makeIdFactory(ID_PREFIX.link);
  const nextProfile = makeIdFactory(ID_PREFIX.perfProfile);
  const nextDepot = makeIdFactory(ID_PREFIX.depot);
  const nextType = makeIdFactory(ID_PREFIX.trainType);
  const nextPattern = makeIdFactory(ID_PREFIX.stopPattern);
  const nextSeries = makeIdFactory(ID_PREFIX.series);
  const nextRule = makeIdFactory(ID_PREFIX.inspectionRule);

  const dayTypeId = asId<'DayType'>(`${ID_PREFIX.dayType}-1`);

  // -- profile --------------------------------------------------------------
  // One profile. Every train on the line is the same two-car set, so the
  // 急行/各停 split that gives the Oimachi Line two profiles has no analogue.
  const y000: PerfProfile = {
    id: nextProfile<'PerfProfile'>(),
    name: 'Y000系 2両',
    accelKmhps: 3.0,
    decelKmhps: 3.5,
    maxSpeedKmh: 70,
  };

  // -- stations & tracks ----------------------------------------------------
  const S = {} as Record<StationKey, StationId>;
  const stations: Station[] = [];
  const tracks: StationTrack[] = [];
  const tracksOf = new Map<StationId, StationTrack[]>();
  const trackRole = new Map<StationTrackId, TrackRole>();
  const stationById = new Map<StationId, Station>();

  for (const spec of STATION_SPECS) {
    const stationId = nextStation<'Station'>();
    S[spec.key] = stationId;

    const built: StationTrack[] = layoutTracks(spec.layout).map((t) => {
      const id = nextTrack<'StationTrack'>();
      trackRole.set(id, t.role);
      return {
        id,
        stationId,
        name: t.name,
        usage: t.usage,
        hasPlatform: t.hasPlatform,
        directions: [...t.directions],
        canTurnBack: t.canTurnBack,
        canBeOvertaken: t.canBeOvertaken,
        maxCars: t.maxCars,
        approachSec: t.approachSec,
        clearSec: t.clearSec,
        ...(t.number === undefined ? {} : { number: t.number }),
        ...(t.wiring === undefined ? {} : { wiring: t.wiring }),
      };
    });
    tracks.push(...built);
    tracksOf.set(stationId, built);

    // Both directions default to 1番線 everywhere, 恩田 included. That is the
    // point: the loop is used when a meet needs it and not otherwise, so
    // 「ラッシュ時のみ交換」 comes out of the timetable rather than out of a
    // default that quietly puts every up train on the second road.
    const first = built[0]!;
    const station: Station = {
      id: stationId,
      name: spec.name,
      nameKana: spec.kana,
      kind: spec.kind ?? 'passenger',
      kmFromOrigin: kmToMeters(spec.km),
      trackIds: built.map((t) => t.id),
      minDwellSec: spec.minDwellSec,
      minTurnbackSec: spec.minTurnbackSec,
      defaultTrackId: { down: first.id, up: first.id },
      isConnectionPoint: false,
      ...(spec.crossovers === undefined
        ? {}
        : { crossovers: spec.crossovers.map((c) => ({ ...c })) }),
      ...(spec.crewChange === true ? { crewChange: true } : {}),
      ...(spec.crewBase === true ? { crewBase: true } : {}),
      ...(spec.code === undefined ? {} : { code: spec.code }),
      ...(spec.transfers === undefined ? {} : { transfers: [...spec.transfers] }),
    };
    stations.push(station);
    stationById.set(stationId, station);
  }

  // -- links ----------------------------------------------------------------
  const links: Link[] = [];
  const linkRunTimes: LinkRunTime[] = [];

  const specOf = (key: StationKey): StationSpec =>
    STATION_SPECS.find((s) => s.key === key)!;

  /**
   * `baseRunSec` is passed rather than read off the destination station,
   * because a `Link` is always oriented low-km → high-km and the yard sits at
   * *negative* km: the depot stub's run time belongs to the depot, but the
   * destination of its link is 長津田. Reading it off the destination — which
   * is what a line whose yard is beyond its terminus can get away with —
   * would silently fall back to a default here.
   */
  function pushLink(
    from: StationKey,
    to: StationKey,
    baseRunSec: number,
    maxSpeedKmh: number,
  ): void {
    const id = nextLink<'Link'>();
    const a = specOf(from);
    const b = specOf(to);
    const distance: Meters = kmToMeters(b.km) - kmToMeters(a.km);
    links.push({
      id,
      fromStationId: S[from],
      toStationId: S[to],
      distance,
      // 単線 — the whole reason this line is here. Written on the yard stub
      // too, because it is true there as well; `isSingleTrackLine` discounts
      // the stubs when it decides how to *draw* the line, but the check that
      // keeps two trains out of one section reads every link the same way.
      trackCount: 1,
      minHeadwaySec: 180,
      maxSpeedKmh,
    });
    linkRunTimes.push({ linkId: id, profileId: y000.id, baseRunSec, ...PENALTY });
  }

  pushLink('nagatsutaDepot', 'nagatsuta', 90, 25);
  pushLink('nagatsuta', 'onda', 120, 70);
  pushLink('onda', 'nagatsutaWorks', 60, 25);
  pushLink('onda', 'kodomonokuni', 100, 70);

  const runTimeByKey = new Map<string, LinkRunTime>();
  const linkById = new Map<LinkId, Link>(links.map((l) => [l.id, l]));
  for (const rt of linkRunTimes) {
    const link = linkById.get(rt.linkId);
    if (link === undefined) continue;
    runTimeByKey.set(`${link.fromStationId}|${link.toStationId}|${rt.profileId}`, rt);
    runTimeByKey.set(`${link.toStationId}|${link.fromStationId}|${rt.profileId}`, rt);
  }

  const singleTrackPairs = new Set<string>();
  for (const link of links) {
    if (link.trackCount !== 1) continue;
    singleTrackPairs.add(`${link.fromStationId}>${link.toStationId}`);
    singleTrackPairs.add(`${link.toStationId}>${link.fromStationId}`);
  }

  // -- depots ---------------------------------------------------------------
  const yard: Depot = {
    id: nextDepot<'Depot'>(),
    name: '長津田検車区',
    stationId: S.nagatsutaDepot,
    attachedStationId: S.nagatsuta,
    accessRunSec: 110,
    prepSec: 300,
    capacityFormations: 4,
    capacityCars: 16,
    inspectionKinds: ['train', 'monthly'],
    // Negative: the yard is behind the origin, not beyond the terminus.
    stubOffsetMeters: kmToMeters(-0.6),
  };
  const works: Depot = {
    id: nextDepot<'Depot'>(),
    name: '長津田工場',
    stationId: S.nagatsutaWorks,
    attachedStationId: S.onda,
    accessRunSec: 300,
    prepSec: 600,
    capacityFormations: 2,
    capacityCars: 8,
    // Heavy examinations only, which is what makes `inspection.depotNotCapable`
    // a rule with something to say on this line: a 重要部検査 booked at the
    // running shed is an error, and the document can express the difference.
    inspectionKinds: ['bogie', 'general'],
    stubOffsetMeters: kmToMeters(0.4),
  };

  // -- train types ----------------------------------------------------------
  const typeIds: Record<TrainTypeKey, TrainTypeId> = {
    local: nextType<'TrainType'>(),
    deadhead: nextType<'TrainType'>(),
  };
  const trainTypes: TrainType[] = [
    {
      id: typeIds.local,
      name: '各駅停車',
      shortName: '各停',
      color: '#0aa66e',
      lineStyle: 'solid',
      lineWidth: 1.6,
      isPassengerService: true,
      perfProfileId: y000.id,
      sortOrder: 10,
      // `crewRoles` omitted = ['driver']: the line is ワンマン.
    },
    {
      id: typeIds.deadhead,
      name: '回送',
      shortName: '回',
      color: '#8a8f98',
      lineStyle: 'dashed',
      lineWidth: 1.2,
      isPassengerService: false,
      perfProfileId: y000.id,
      sortOrder: 90,
    },
  ];

  // -- stop patterns --------------------------------------------------------
  // Every train calls at all three stations. There is only one product, and a
  // three-station line has nothing to skip.
  const patternIds = {} as Record<PatternKey, StopPatternId>;
  const stopPatterns: StopPattern[] = [];
  for (const spec of PATTERN_SPECS) {
    const id = nextPattern<'StopPattern'>();
    patternIds[spec.key] = id;
    const entries: Record<string, StopKind> = {};
    for (const key of LINE_KEYS) entries[S[key]] = 'stop';
    stopPatterns.push({
      id,
      name: spec.name,
      trainTypeId: typeIds.local,
      direction: spec.direction,
      originStationId: S[spec.originKey],
      terminusStationId: S[spec.terminusKey],
      entries,
    });
  }

  // -- fleet & inspection ---------------------------------------------------
  const seriesId = nextSeries<'FormationSeries'>();
  const formationSeries: FormationSeries[] = [
    { id: seriesId, name: 'Y000系', perfProfileId: y000.id, allowedCarCounts: [2], color: '#0aa66e' },
  ];

  const rule = (
    kind: InspectionRule['kind'],
    name: string,
    rest: Omit<InspectionRule, 'id' | 'kind' | 'name' | 'appliesTo'>,
  ): InspectionRule => ({
    id: nextRule<'InspectionRule'>(),
    kind,
    name,
    appliesTo: 'all',
    ...rest,
  });

  // The intervals are the 省令 ones — the same table the Oimachi Line uses,
  // because it is the law rather than a property of either railway.
  const inspectionRules: InspectionRule[] = [
    rule('train', '列車検査', {
      intervalDays: 10,
      warnBeforeDays: 2,
      outOfServiceDays: 1,
      depotIds: [yard.id],
      sortOrder: 10,
    }),
    rule('monthly', '月検査(交番検査)', {
      intervalDays: 90,
      intervalKm: 30_000,
      warnBeforeDays: 7,
      warnBeforeKm: 2_000,
      outOfServiceDays: 2,
      depotIds: [yard.id],
      sortOrder: 20,
    }),
    rule('bogie', '重要部検査', {
      intervalDays: 1_460,
      intervalKm: 600_000,
      warnBeforeDays: 60,
      warnBeforeKm: 20_000,
      outOfServiceDays: 14,
      depotIds: [works.id],
      sortOrder: 30,
    }),
    rule('general', '全般検査', {
      intervalDays: 2_920,
      warnBeforeDays: 90,
      outOfServiceDays: 30,
      depotIds: [works.id],
      sortOrder: 40,
    }),
  ];

  const line: Line = {
    id: asId<'Line'>(`${ID_PREFIX.line}-1`),
    name: '東急こどもの国線',
    nameKana: 'とうきゅうこどものくにせん',
    downDirectionLabel: 'こどもの国方面',
    upDirectionLabel: '長津田方面',
    color: '#0aa66e',
  };

  const axisStations = LINE_KEYS.map((k) => stationById.get(S[k])!);

  return {
    dayTypeId,
    line,
    stations,
    tracks,
    links,
    perfProfiles: [y000],
    linkRunTimes,
    depots: [yard, works],
    trainTypes,
    stopPatterns,
    formationSeries,
    inspectionRules,

    S,
    profileId: y000.id,
    type: typeIds,
    pattern: patternIds,
    depotId: { yard: yard.id, works: works.id },
    seriesId,

    stationById,
    tracksOf,
    trackRole,
    axisStations,
    // The yard is behind the origin, so it goes on the *front* of the chain.
    // 鷺沼車庫 goes on the back of the Oimachi Line's. A list in km order says
    // which without anyone having to encode "before" or "after".
    deadheadAxis: [stationById.get(S.nagatsutaDepot)!, ...axisStations],
    overtakeAt: new Map(
      (Object.keys(PASSING_STATIONS) as StationKey[]).map((k) => [S[k], PASSING_STATIONS[k]!]),
    ),
    // Every station on this line has a platform on it, there is no second
    // railway sharing the rails, and nothing to choose between pairs.
    noPlatformAt: new Set(),
    chooseRailPairAt: new Set(),
    railPairTerminusAt: new Set(),
    ownRailsOnlyAt: new Set(),

    deadheadProfileId: y000.id,
    deadheadTypeId: typeIds.deadhead,
    // The line's own `minHeadwaySec` plus a margin, for the same reason the
    // Oimachi Line's is 95 against 90: a path found at exactly the minimum is
    // one the validator will call marginal for the rest of the document's life.
    deadheadHeadwaySec: 190,

    isSingleTrack(a, b) {
      return singleTrackPairs.has(`${a}>${b}`);
    },
    runTime(from, to, profileId) {
      const rt = runTimeByKey.get(`${from}|${to}|${profileId}`);
      if (rt === undefined) {
        throw new SeedError('no LinkRunTime for adjacent pair', {
          from: String(from),
          to: String(to),
          profileId: String(profileId),
        });
      }
      return rt;
    },
  };
}
