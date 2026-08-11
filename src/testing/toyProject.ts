/**
 * A tiny, fully-valid 4-station line used as the base fixture for unit tests.
 *
 * Every validation-rule test starts from `toyProject()` (which must produce
 * zero issues) and then breaks exactly one thing. That gives each rule both a
 * positive and a negative case with almost no setup.
 *
 * Layout — km 0.0 / 1.0 / 2.0 / 3.0, plus a depot stub off station A:
 *
 *     [DEPOT]
 *        |
 *        A ---- B ---- C ---- D
 *      2 trk  1 trk  3 trk  2 trk
 *                    (待避)
 *
 * Station C has a passing loop, so an express can overtake a local there. The
 * express *calls* at C on the through road while the local stands aside on the
 * loop: a cross-platform 緩急接続, which is what makes C a connection point.
 * A 待避 where the faster train runs straight through is a spacing move and
 * carries no connection — that case is deliberately not what this fixture
 * models, because `detectConnections` must reject it.
 */

import { ID_PREFIX, asId } from '@/domain/ids';
import type {
  DayTypeId,
  DepotId,
  DutyId,
  FormationId,
  LinkId,
  PerfProfileId,
  SeriesId,
  StationId,
  StationTrackId,
  StopPatternId,
  TrainId,
  TrainTypeId,
} from '@/domain/ids';
import type {
  Crew,
  CrewDuty,
  Depot,
  Duty,
  Formation,
  FormationSeries,
  InspectionRule,
  Link,
  LinkRunTime,
  PerfProfile,
  ProjectDocument,
  Station,
  StationTrack,
  StopPattern,
  Train,
  TrainStop,
  TrainType,
} from '@/domain/model';
import { createEmptyProject } from '@/domain/project';
import { entitiesFrom, kmToMeters } from '@/domain/units';

export const TOY = {
  dayType: asId<'DayType'>(`${ID_PREFIX.dayType}-1`),
  profile: asId<'PerfProfile'>(`${ID_PREFIX.perfProfile}-1`),
  stationA: asId<'Station'>(`${ID_PREFIX.station}-1`),
  stationB: asId<'Station'>(`${ID_PREFIX.station}-2`),
  stationC: asId<'Station'>(`${ID_PREFIX.station}-3`),
  stationD: asId<'Station'>(`${ID_PREFIX.station}-4`),
  stationDepot: asId<'Station'>(`${ID_PREFIX.station}-9`),
  // Track ids: a1/a2 at A, b1 at B, c1/c2/c3 at C, d1/d2 at D, x1 at the depot.
  a1: asId<'StationTrack'>(`${ID_PREFIX.stationTrack}-1`),
  a2: asId<'StationTrack'>(`${ID_PREFIX.stationTrack}-2`),
  b1: asId<'StationTrack'>(`${ID_PREFIX.stationTrack}-3`),
  c1: asId<'StationTrack'>(`${ID_PREFIX.stationTrack}-4`),
  c2: asId<'StationTrack'>(`${ID_PREFIX.stationTrack}-5`),
  c3: asId<'StationTrack'>(`${ID_PREFIX.stationTrack}-6`),
  d1: asId<'StationTrack'>(`${ID_PREFIX.stationTrack}-7`),
  d2: asId<'StationTrack'>(`${ID_PREFIX.stationTrack}-8`),
  x1: asId<'StationTrack'>(`${ID_PREFIX.stationTrack}-9`),
  linkAB: asId<'Link'>(`${ID_PREFIX.link}-1`),
  linkBC: asId<'Link'>(`${ID_PREFIX.link}-2`),
  linkCD: asId<'Link'>(`${ID_PREFIX.link}-3`),
  linkDepot: asId<'Link'>(`${ID_PREFIX.link}-4`),
  depot: asId<'Depot'>(`${ID_PREFIX.depot}-1`),
  typeLocal: asId<'TrainType'>(`${ID_PREFIX.trainType}-1`),
  typeExpress: asId<'TrainType'>(`${ID_PREFIX.trainType}-2`),
  typeDeadhead: asId<'TrainType'>(`${ID_PREFIX.trainType}-3`),
  patLocalDown: asId<'StopPattern'>(`${ID_PREFIX.stopPattern}-1`),
  patExpressDown: asId<'StopPattern'>(`${ID_PREFIX.stopPattern}-2`),
  series: asId<'FormationSeries'>(`${ID_PREFIX.series}-1`),
  formation1: asId<'Formation'>(`${ID_PREFIX.formation}-1`),
  formation2: asId<'Formation'>(`${ID_PREFIX.formation}-2`),
  ruleTrain: asId<'InspectionRule'>(`${ID_PREFIX.inspectionRule}-1`),
  ruleMonthly: asId<'InspectionRule'>(`${ID_PREFIX.inspectionRule}-2`),
  // Trains: a local overtaken at C by an express.
  localDown: asId<'Train'>(`${ID_PREFIX.train}-1`),
  expressDown: asId<'Train'>(`${ID_PREFIX.train}-2`),
  depotOut: asId<'Train'>(`${ID_PREFIX.train}-3`),
  depotIn: asId<'Train'>(`${ID_PREFIX.train}-4`),
  dutyLocal: asId<'Duty'>(`${ID_PREFIX.duty}-1`),
  dutyExpress: asId<'Duty'>(`${ID_PREFIX.duty}-2`),
  // 乗務員: two drivers based at the depot, one 行路 each. The express driver
  // 添乗s out and back on the other duty's 回送, which is what makes the pair
  // start and finish at the base.
  crewDutyLocal: asId<'CrewDuty'>(`${ID_PREFIX.crewDuty}-1`),
  crewDutyExpress: asId<'CrewDuty'>(`${ID_PREFIX.crewDuty}-2`),
  driver1: asId<'Crew'>(`${ID_PREFIX.crew}-1`),
  driver2: asId<'Crew'>(`${ID_PREFIX.crew}-2`),
} as const;

const H = 3600;
const M = 60;

function track(
  id: StationTrackId,
  stationId: StationId,
  name: string,
  opts: Partial<StationTrack> = {},
): StationTrack {
  return {
    id,
    stationId,
    name,
    usage: 'main',
    hasPlatform: true,
    directions: ['down', 'up'],
    canTurnBack: true,
    canBeOvertaken: false,
    maxCars: 10,
    approachSec: 45,
    clearSec: 30,
    ...opts,
  };
}

function station(
  id: StationId,
  name: string,
  km: number,
  trackIds: StationTrackId[],
  opts: Partial<Station> = {},
): Station {
  const defaultTrackId: Station['defaultTrackId'] = {};
  const down = trackIds[0];
  const up = trackIds[trackIds.length - 1];
  if (down !== undefined) defaultTrackId.down = down;
  if (up !== undefined) defaultTrackId.up = up;

  return {
    id,
    name,
    kind: 'passenger',
    kmFromOrigin: kmToMeters(km),
    trackIds,
    minDwellSec: 20,
    minTurnbackSec: 180,
    defaultTrackId,
    isConnectionPoint: false,
    ...opts,
  };
}

function link(id: LinkId, from: StationId, to: StationId, km: number): Link {
  return {
    id,
    fromStationId: from,
    toStationId: to,
    distance: kmToMeters(km),
    trackCount: 2,
    minHeadwaySec: 120,
    maxSpeedKmh: 110,
  };
}

function runTime(linkId: LinkId, profileId: PerfProfileId, base: number): LinkRunTime {
  return { linkId, profileId, baseRunSec: base, startPenaltySec: 10, stopPenaltySec: 10 };
}

function stop(
  stationId: StationId,
  trackId: StationTrackId | undefined,
  arr: number | undefined,
  dep: number | undefined,
  extra: Partial<TrainStop> = {},
): TrainStop {
  const s: TrainStop = { stationId, kind: 'stop', ...extra };
  if (trackId !== undefined) s.trackId = trackId;
  if (arr !== undefined) s.arr = arr;
  if (dep !== undefined) s.dep = dep;
  return s;
}

/**
 * The base fixture. Times are chosen so that:
 *   - every section run time exactly meets its minimum plus slack,
 *   - the local waits at C from 08:04 to 08:08:30 while the express calls there
 *     08:06:00–08:06:30 on the other face of the island,
 *   - both duties begin with a 出庫 and end with an 入庫.
 */
export function toyProject(): ProjectDocument {
  const base = createEmptyProject({ name: 'テスト線プロジェクト', lineName: 'テスト線' });

  const profile: PerfProfile = {
    id: TOY.profile,
    name: '標準性能',
    accelKmhps: 3.0,
    decelKmhps: 3.5,
    maxSpeedKmh: 110,
  };

  const tracks: StationTrack[] = [
    track(TOY.a1, TOY.stationA, '1番線', { directions: ['down'] }),
    track(TOY.a2, TOY.stationA, '2番線', { directions: ['up'] }),
    track(TOY.b1, TOY.stationB, '1番線'),
    track(TOY.c1, TOY.stationC, '1番線', { directions: ['down'] }),
    track(TOY.c2, TOY.stationC, '2番線', { directions: ['down'], usage: 'passing', canBeOvertaken: true }),
    track(TOY.c3, TOY.stationC, '3番線', { directions: ['up'] }),
    track(TOY.d1, TOY.stationD, '1番線'),
    track(TOY.d2, TOY.stationD, '2番線'),
    track(TOY.x1, TOY.stationDepot, '留置1番', {
      usage: 'stabling',
      hasPlatform: false,
      canBeOvertaken: false,
      depotId: TOY.depot,
    }),
  ];

  const stations: Station[] = [
    station(TOY.stationA, 'A駅', 0.0, [TOY.a1, TOY.a2]),
    station(TOY.stationB, 'B駅', 1.0, [TOY.b1]),
    station(TOY.stationC, 'C駅', 2.0, [TOY.c1, TOY.c2, TOY.c3], {
      isConnectionPoint: true,
      defaultTrackId: { down: TOY.c1, up: TOY.c3 },
    }),
    station(TOY.stationD, 'D駅', 3.0, [TOY.d1, TOY.d2]),
    station(TOY.stationDepot, 'A車庫', -0.5, [TOY.x1], { kind: 'depot', crewBase: true }),
  ];

  const links: Link[] = [
    link(TOY.linkAB, TOY.stationA, TOY.stationB, 1.0),
    link(TOY.linkBC, TOY.stationB, TOY.stationC, 1.0),
    link(TOY.linkCD, TOY.stationC, TOY.stationD, 1.0),
    link(TOY.linkDepot, TOY.stationDepot, TOY.stationA, 0.5),
  ];

  const linkRunTimes: LinkRunTime[] = [
    runTime(TOY.linkAB, TOY.profile, 70),
    runTime(TOY.linkBC, TOY.profile, 70),
    runTime(TOY.linkCD, TOY.profile, 70),
    runTime(TOY.linkDepot, TOY.profile, 60),
  ];

  const depot: Depot = {
    id: TOY.depot,
    name: 'A車庫',
    stationId: TOY.stationDepot,
    attachedStationId: TOY.stationA,
    accessRunSec: 90,
    prepSec: 300,
    capacityFormations: 6,
    inspectionKinds: ['train', 'monthly'],
    stubOffsetMeters: kmToMeters(-0.5),
  };

  const trainTypes: TrainType[] = [
    {
      id: TOY.typeLocal,
      name: '各駅停車',
      shortName: '各',
      color: '#2563eb',
      lineStyle: 'solid',
      lineWidth: 1.5,
      isPassengerService: true,
      perfProfileId: TOY.profile,
      defaultStopPatternId: TOY.patLocalDown,
      sortOrder: 10,
    },
    {
      id: TOY.typeExpress,
      name: '急行',
      shortName: '急',
      color: '#dc2626',
      lineStyle: 'solid',
      lineWidth: 2.5,
      isPassengerService: true,
      perfProfileId: TOY.profile,
      defaultStopPatternId: TOY.patExpressDown,
      sortOrder: 20,
    },
    {
      id: TOY.typeDeadhead,
      name: '回送',
      shortName: '回',
      color: '#94a3b8',
      lineStyle: 'dashed',
      lineWidth: 1.5,
      isPassengerService: false,
      perfProfileId: TOY.profile,
      sortOrder: 90,
    },
  ];

  const stopPatterns: StopPattern[] = [
    {
      id: TOY.patLocalDown,
      name: '各停(下り)',
      trainTypeId: TOY.typeLocal,
      direction: 'down',
      originStationId: TOY.stationA,
      terminusStationId: TOY.stationD,
      entries: {
        [TOY.stationA]: 'stop',
        [TOY.stationB]: 'stop',
        [TOY.stationC]: 'stop',
        [TOY.stationD]: 'stop',
      },
    },
    {
      id: TOY.patExpressDown,
      name: '急行(下り)',
      trainTypeId: TOY.typeExpress,
      direction: 'down',
      originStationId: TOY.stationA,
      terminusStationId: TOY.stationD,
      entries: {
        [TOY.stationA]: 'stop',
        [TOY.stationB]: 'pass',
        // Calls at C — that is the whole point of the 待避 on the loop.
        [TOY.stationC]: 'stop',
        [TOY.stationD]: 'stop',
      },
    },
  ];

  // -- trains ---------------------------------------------------------------
  // Local: A 08:00 dep, B 08:01:30, C 08:04:00 arr / 08:08:30 dep (waits for
  // the express, which calls 08:06:00–08:06:30), D 08:10:30 arr. The 30 s
  // margin on the C departure is the 120 s link headway behind the express.
  const localDown: Train = {
    id: TOY.localDown,
    number: '101',
    typeId: TOY.typeLocal,
    direction: 'down',
    category: 'service',
    patternId: TOY.patLocalDown,
    dayTypeIds: [TOY.dayType],
    stops: [
      stop(TOY.stationA, TOY.a1, undefined, 8 * H),
      stop(TOY.stationB, TOY.b1, 8 * H + 90, 8 * H + 120),
      stop(TOY.stationC, TOY.c2, 8 * H + 4 * M, 8 * H + 8 * M + 30, {
        overtakenBy: [TOY.expressDown],
      }),
      stop(TOY.stationD, TOY.d1, 8 * H + 10 * M + 30, undefined),
    ],
  };

  // Express: A 08:03 dep, passes B 08:04:20, calls C 08:06:00–08:06:30,
  // D 08:08:00 arr (C->D is exactly the 90 s minimum).
  const expressDown: Train = {
    id: TOY.expressDown,
    number: '201',
    typeId: TOY.typeExpress,
    direction: 'down',
    category: 'service',
    patternId: TOY.patExpressDown,
    dayTypeIds: [TOY.dayType],
    stops: [
      stop(TOY.stationA, TOY.a1, undefined, 8 * H + 3 * M),
      // 80s from A: base 70 + 10s start penalty (the origin is a stand).
      { stationId: TOY.stationB, trackId: TOY.b1, arr: 8 * H + 4 * M + 20, dep: 8 * H + 4 * M + 20, kind: 'pass' },
      stop(TOY.stationC, TOY.c1, 8 * H + 6 * M, 8 * H + 6 * M + 30),
      stop(TOY.stationD, TOY.d2, 8 * H + 8 * M, undefined),
    ],
  };

  // 出庫: depot 07:50 dep -> A 07:52 arr. 入庫 from D at the end of the day.
  const depotOut: Train = {
    id: TOY.depotOut,
    number: '回8001',
    typeId: TOY.typeDeadhead,
    direction: 'down',
    category: 'deadhead',
    dayTypeIds: [TOY.dayType],
    stops: [
      stop(TOY.stationDepot, TOY.x1, undefined, 7 * H + 50 * M, { operation: 'depotOut' }),
      stop(TOY.stationA, TOY.a1, 7 * H + 52 * M, undefined),
    ],
  };

  const depotIn: Train = {
    id: TOY.depotIn,
    number: '回8002',
    typeId: TOY.typeDeadhead,
    direction: 'up',
    category: 'deadhead',
    dayTypeIds: [TOY.dayType],
    stops: [
      stop(TOY.stationD, TOY.d1, undefined, 8 * H + 20 * M),
      stop(TOY.stationC, TOY.c3, 8 * H + 22 * M, 8 * H + 22 * M + 30, { kind: 'pass' }),
      stop(TOY.stationB, TOY.b1, 8 * H + 24 * M, 8 * H + 24 * M + 30, { kind: 'pass' }),
      stop(TOY.stationA, TOY.a2, 8 * H + 26 * M, 8 * H + 28 * M),
      stop(TOY.stationDepot, TOY.x1, 8 * H + 30 * M, undefined, { operation: 'depotIn' }),
    ],
  };

  const duties: Duty[] = [
    {
      id: TOY.dutyLocal,
      code: '01',
      dayTypeIds: [TOY.dayType],
      legs: [
        { kind: 'train', trainId: TOY.depotOut },
        { kind: 'train', trainId: TOY.localDown },
        { kind: 'stable', stationId: TOY.stationD, trackId: TOY.d1, from: 8 * H + 10 * M + 30, to: 8 * H + 20 * M },
        { kind: 'train', trainId: TOY.depotIn },
      ],
      requiredCars: 6,
    },
    {
      id: TOY.dutyExpress,
      code: '02',
      dayTypeIds: [TOY.dayType],
      legs: [{ kind: 'train', trainId: TOY.expressDown }],
      requiredCars: 6,
    },
  ];

  // -- 乗務員 ---------------------------------------------------------------
  const crewDuties: CrewDuty[] = [
    {
      id: TOY.crewDutyLocal,
      code: '11仕',
      role: 'driver',
      baseStationId: TOY.stationDepot,
      dayTypeIds: [TOY.dayType],
      legs: [
        { kind: 'train', trainId: TOY.depotOut, fromIndex: 0, toIndex: 1 },
        { kind: 'train', trainId: TOY.localDown, fromIndex: 0, toIndex: 3 },
        { kind: 'standby', stationId: TOY.stationD, from: 8 * H + 10 * M + 30, to: 8 * H + 20 * M },
        { kind: 'train', trainId: TOY.depotIn, fromIndex: 0, toIndex: 4 },
      ],
    },
    {
      id: TOY.crewDutyExpress,
      code: '12仕',
      role: 'driver',
      baseStationId: TOY.stationDepot,
      dayTypeIds: [TOY.dayType],
      legs: [
        { kind: 'deadhead', trainId: TOY.depotOut, fromIndex: 0, toIndex: 1 },
        { kind: 'standby', stationId: TOY.stationA, from: 7 * H + 52 * M, to: 8 * H + 3 * M },
        { kind: 'train', trainId: TOY.expressDown, fromIndex: 0, toIndex: 3 },
        { kind: 'standby', stationId: TOY.stationD, from: 8 * H + 8 * M, to: 8 * H + 20 * M },
        { kind: 'deadhead', trainId: TOY.depotIn, fromIndex: 0, toIndex: 4 },
      ],
    },
  ];

  const crew: Crew[] = [
    { id: TOY.driver1, code: 'D01', name: '甲', role: 'driver', baseStationId: TOY.stationDepot },
    { id: TOY.driver2, code: 'D02', name: '乙', role: 'driver', baseStationId: TOY.stationDepot },
  ];

  const series: FormationSeries[] = [
    {
      id: TOY.series,
      name: 'T形',
      perfProfileId: TOY.profile,
      allowedCarCounts: [6],
      color: '#0ea5e9',
    },
  ];

  const formations: Formation[] = [
    {
      id: TOY.formation1,
      code: 'T01F',
      seriesId: TOY.series,
      cars: 6,
      homeDepotId: TOY.depot,
      status: 'active',
      odometerKm: 100_000,
      odometerAsOf: '2026-04-06',
      commissionedOn: '2016-04-01',
    },
    {
      id: TOY.formation2,
      code: 'T02F',
      seriesId: TOY.series,
      cars: 6,
      homeDepotId: TOY.depot,
      status: 'active',
      odometerKm: 120_000,
      odometerAsOf: '2026-04-06',
      commissionedOn: '2016-04-01',
    },
  ];

  const inspectionRules: InspectionRule[] = [
    {
      id: TOY.ruleTrain,
      kind: 'train',
      name: '列車検査',
      appliesTo: 'all',
      intervalDays: 10,
      warnBeforeDays: 2,
      outOfServiceDays: 1,
      depotIds: [TOY.depot],
      sortOrder: 10,
    },
    {
      id: TOY.ruleMonthly,
      kind: 'monthly',
      name: '月検査',
      appliesTo: 'all',
      intervalDays: 90,
      intervalKm: 30_000,
      warnBeforeDays: 7,
      warnBeforeKm: 2000,
      outOfServiceDays: 2,
      depotIds: [TOY.depot],
      sortOrder: 20,
    },
  ];

  return {
    ...base,
    stations: entitiesFrom(stations),
    stationTracks: entitiesFrom(tracks),
    links: entitiesFrom(links),
    perfProfiles: entitiesFrom([profile]),
    linkRunTimes,
    depots: entitiesFrom([depot]),
    trainTypes: entitiesFrom(trainTypes),
    stopPatterns: entitiesFrom(stopPatterns),
    trains: entitiesFrom([localDown, expressDown, depotOut, depotIn]),
    duties: entitiesFrom(duties),
    formationSeries: entitiesFrom(series),
    formations: entitiesFrom(formations),
    inspectionRules: entitiesFrom(inspectionRules),
    inspectionRecords: entitiesFrom([
      {
        id: asId<'InspectionRecord'>('irc-1'),
        formationId: TOY.formation1,
        ruleId: TOY.ruleTrain,
        kind: 'train' as const,
        status: 'completed' as const,
        from: '2026-04-02',
        to: '2026-04-02',
        odometerKmAt: 99_500,
        depotId: TOY.depot,
      },
      {
        id: asId<'InspectionRecord'>('irc-2'),
        formationId: TOY.formation2,
        ruleId: TOY.ruleTrain,
        kind: 'train' as const,
        status: 'completed' as const,
        from: '2026-04-04',
        to: '2026-04-04',
        odometerKmAt: 119_800,
        depotId: TOY.depot,
      },
    ]),
    assignments: entitiesFrom([
      { id: asId<'Assignment'>('asg-1'), date: '2026-04-06', dutyId: TOY.dutyLocal, formationId: TOY.formation1 },
      { id: asId<'Assignment'>('asg-2'), date: '2026-04-06', dutyId: TOY.dutyExpress, formationId: TOY.formation2 },
    ]),
    calendar: [{ date: '2026-04-06', dayTypeId: TOY.dayType }],
    crew: entitiesFrom(crew),
    crewDuties: entitiesFrom(crewDuties),
    crewAssignments: entitiesFrom([
      { id: asId<'CrewAssignment'>('cas-1'), date: '2026-04-06', crewDutyId: TOY.crewDutyLocal, crewId: TOY.driver1 },
      { id: asId<'CrewAssignment'>('cas-2'), date: '2026-04-06', crewDutyId: TOY.crewDutyExpress, crewId: TOY.driver2 },
    ]),
  };
}

/** Convenience: deep clone so a test can mutate freely. */
export function toyProjectCopy(): ProjectDocument {
  return structuredClone(toyProject());
}

export type ToyIds = typeof TOY;
export type { DayTypeId, DepotId, DutyId, FormationId, SeriesId, StationId, StationTrackId, TrainId, TrainTypeId, StopPatternId, LinkId, PerfProfileId };
