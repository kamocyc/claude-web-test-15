/**
 * 東急大井町線 — the researched facts, as plain data.
 *
 * ===========================================================================
 * PROVENANCE — read this before trusting any number in this file
 * ===========================================================================
 *
 * **Researched fact** (structure that is verifiably true of the real line):
 *   - the 16 station names, codes and km posts 大井町 0.0 … 溝の口 12.4 (the
 *     table was checked for internal consistency: every hop is positive and
 *     the hops sum to 12.4 km);
 *   - three passenger train types — 急行 (7両) and two 各駅停車 (5両) that
 *     differ by ROUTE, not merely by stopping pattern;
 *   - 急行 stops only at 大井町・旗の台・大岡山・自由が丘・二子玉川・溝の口;
 *   - 二子玉川〜溝の口 is a 方向別複々線: the 大井町線 uses the inner pair, the
 *     田園都市線 the outer pair, and 二子新地・高津 have platforms ONLY on the
 *     outer (田園都市線) tracks — hence one 各停 stops there and one cannot;
 *   - overtaking is possible at exactly two places: 旗の台 (島式2面4線,
 *     3・6番線 待避, both directions, all day) and 上野毛 (上り側のみ待避線);
 *   - 大岡山 and 自由が丘 look like four-track stations but the other two
 *     tracks belong to the 目黒線 / 東横線, so they cannot be used to overtake;
 *   - 大井町 is a 頭端式1面2線 stub terminal with no tail track;
 *   - 溝の口 is 島式2面4線 (outer 1・4 田園都市線, inner 2・3 大井町線) with two
 *     引上線 on the 梶が谷 side;
 *   - rolling stock: 急行 = 7両 6000系×6 + 6020系×2; 各停 = 5両 9000系・9020系
 *     (+ a handful of new 6020系5両); home 長津田検車区, day-to-day 鷺沼;
 *   - inspection intervals from the 省令: 列車検査 10日 / 月(交番)検査 3か月
 *     または30,000km / 重要部検査 4年または600,000km / 全般検査 8年.
 *
 * **Approximate** (stated as such by the source material):
 *   - 梶が谷 13.7 / 宮前平 15.4 / 鷺沼 16.9 km. These are 田園都市線 stations
 *     and their km posts here are measured on the 大井町線 axis by continuing
 *     the 大井町 origin past 溝の口; the real 田園都市線 km posts are measured
 *     from 渋谷. They are good enough to draw a string diagram and to give the
 *     depot runs a plausible length, and nothing else depends on them.
 *   - 鷺沼車庫 (17.4) and 長津田車両工場 (30.0) are synthetic stub nodes.
 *
 * **Reconstruction** (invented here, consistent with the structure above but
 * NOT copied from any published timetable):
 *   - every `baseRunSec`, `startPenaltySec`, `stopPenaltySec`, `minDwellSec`,
 *     `minTurnbackSec`, `approachSec`, `clearSec`, `minHeadwaySec`;
 *   - the individual 番線 numbers at 旗の台 / 上野毛 / 二子玉川 / 溝の口 / 鷺沼
 *     (the *counts* and the 待避 capability are fact, the numbering is not);
 *   - all 列車番号 and 運用番号;
 *   - the odometer readings and inspection history.
 *
 * The run times were tuned against two sanity targets that DO come from the
 * real line: 急行 大井町→溝の口 in 18–20 minutes and 各停 in 24–27 minutes.
 * With the values below a clear run is 急行 19分35秒, 緑各停 25分25秒,
 * 青各停 26分45秒.
 *
 * Determinism: every id in this file comes from `makeIdFactory`, which is a
 * plain counter. `buildFacts()` called twice returns byte-identical output.
 */

import { ID_PREFIX, asId, makeIdFactory } from '@/domain/ids';
import type {
  DayTypeId,
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
  StationTrack,
  StopKind,
  StopPattern,
  TrainType,
} from '@/domain/model';
import { kmToMeters, type Meters } from '@/domain/units';
import type { InspectionRuleId } from '@/domain/ids';
import { SeedError } from '../errors';

// ---------------------------------------------------------------------------
// Station keys
// ---------------------------------------------------------------------------

export const STATION_KEYS = [
  'oimachi',
  'shimoshimmei',
  'togoshikoen',
  'nakanobu',
  'ebaramachi',
  'hatanodai',
  'kitasenzoku',
  'ookayama',
  'midorigaoka',
  'jiyugaoka',
  'kuhombutsu',
  'oyamadai',
  'todoroki',
  'kaminoge',
  'futakotamagawa',
  'futakoshinchi',
  'takatsu',
  'mizonokuchi',
  'kajigaya',
  'miyamaedaira',
  'saginuma',
  'saginumaDepot',
  'nagatsutaWorks',
] as const;

export type StationKey = (typeof STATION_KEYS)[number];

/** The 16 numbered 大井町線 stations, in `down` order. */
export const OIMACHI_LINE_KEYS: readonly StationKey[] = [
  'oimachi',
  'shimoshimmei',
  'togoshikoen',
  'nakanobu',
  'ebaramachi',
  'hatanodai',
  'kitasenzoku',
  'ookayama',
  'midorigaoka',
  'jiyugaoka',
  'kuhombutsu',
  'oyamadai',
  'todoroki',
  'kaminoge',
  'futakotamagawa',
  'mizonokuchi',
];

/** 急行停車駅 — researched fact, and the single most load-bearing constraint. */
export const EXPRESS_STOP_KEYS: readonly StationKey[] = [
  'oimachi',
  'hatanodai',
  'ookayama',
  'jiyugaoka',
  'futakotamagawa',
  'mizonokuchi',
];

/** The two stations with no 大井町線 platform. */
export const NO_OIMACHI_PLATFORM_KEYS: readonly StationKey[] = ['futakoshinchi', 'takatsu'];

/**
 * The ONLY stations at which a train may be overtaken, and in which direction.
 * The generator asserts every declared overtake against this table.
 */
export const OVERTAKE_STATIONS: Readonly<Record<string, readonly Direction[]>> = {
  hatanodai: ['down', 'up'],
  kaminoge: ['up'],
};

// ---------------------------------------------------------------------------
// Track layouts
// ---------------------------------------------------------------------------

type TrackRole = 'om' | 'dt' | 'stabling' | 'depot';

type LayoutKind =
  | 'terminalStub' // 大井町: 頭端式1面2線
  | 'double' // 相対式/島式 2線
  | 'hatanodai' // 島式2面4線 with 待避 both ways
  | 'kaminoge' // 島式1面3線, 上り待避のみ
  | 'futakotamagawa' // 大井町線2線 + 田園都市線2線
  | 'noOimachiPlatform' // 二子新地・高津
  | 'mizonokuchi' // 島式2面4線 + 引上線2
  | 'saginumaStation' // 4線, 折返可
  | 'depotYard'
  | 'works';

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
}

const MAIN = { approachSec: 30, clearSec: 20 } as const;
/**
 * 大井町 only. A 頭端式 terminal is approached at crawl speed over a short
 * final block and cleared as soon as the train is at a stand, so the berth is
 * booked for much less time than at a through platform. With only two roads and
 * ~40 movements an hour at peak this is the difference between a workable
 * 構内ダイヤ and an impossible one — which is precisely why the real 大井町 is
 * the capacity ceiling of the whole line.
 */
const STUB = { approachSec: 20, clearSec: 10 } as const;
const WAIT = { approachSec: 45, clearSec: 30 } as const;
const THRU = { approachSec: 20, clearSec: 15 } as const;
const YARD = { approachSec: 60, clearSec: 60 } as const;

function omPlatform(
  name: string,
  number: number,
  directions: Direction[],
  extra: Partial<TrackSpec> = {},
): TrackSpec {
  return {
    name,
    number,
    usage: 'main',
    hasPlatform: true,
    directions,
    canTurnBack: false,
    canBeOvertaken: false,
    maxCars: 7,
    ...MAIN,
    role: 'om',
    ...extra,
  };
}

function layoutTracks(layout: LayoutKind): TrackSpec[] {
  switch (layout) {
    case 'terminalStub':
      // 頭端式1面2線. Both faces of a single island; a train reverses in place,
      // there is no tail track, and that is exactly why 大井町 is the bottleneck.
      return [
        omPlatform('1番線', 1, ['down', 'up'], { canTurnBack: true, ...STUB }),
        omPlatform('2番線', 2, ['down', 'up'], { canTurnBack: true, ...STUB }),
      ];
    case 'double':
      return [omPlatform('1番線', 1, ['down']), omPlatform('2番線', 2, ['up'])];
    case 'hatanodai':
      // 島式2面4線 方向別. 3・6 = 待避線, 4・5 = 本線 (researched); which
      // number faces which direction is a reconstruction.
      return [
        omPlatform('3番線', 3, ['down'], { usage: 'passing', canBeOvertaken: true, ...WAIT }),
        omPlatform('4番線', 4, ['down']),
        omPlatform('5番線', 5, ['up']),
        omPlatform('6番線', 6, ['up'], { usage: 'passing', canBeOvertaken: true, ...WAIT }),
      ];
    case 'kaminoge':
      // 島式1面3線 — the extra track is a 上り (大井町方向) 待避線 only.
      return [
        omPlatform('1番線', 1, ['down']),
        omPlatform('2番線', 2, ['up']),
        omPlatform('3番線', 3, ['up'], { usage: 'passing', canBeOvertaken: true, ...WAIT }),
      ];
    case 'futakotamagawa':
      // Divergence point. 大井町線 trains use 2・3; the 田園都市線 faces are
      // modelled so the 構内ダイヤ looks right but carry no seeded traffic.
      return [
        {
          name: '1番線',
          number: 1,
          usage: 'main',
          hasPlatform: true,
          directions: ['down'],
          canTurnBack: false,
          canBeOvertaken: false,
          maxCars: 10,
          ...MAIN,
          role: 'dt',
        },
        omPlatform('2番線', 2, ['down']),
        omPlatform('3番線', 3, ['up']),
        {
          name: '4番線',
          number: 4,
          usage: 'main',
          hasPlatform: true,
          directions: ['up'],
          canTurnBack: false,
          canBeOvertaken: false,
          maxCars: 10,
          ...MAIN,
          role: 'dt',
        },
      ];
    case 'noOimachiPlatform':
      // 二子新地・高津. 相対式2面2線 on the OUTER (田園都市線) pair; the inner
      // 大井町線 pair runs between the platforms with no platform face at all.
      // 急行 and 緑各停 pass on the inner pair; 青各停 stops on the outer pair.
      return [
        {
          name: '1番線',
          number: 1,
          usage: 'main',
          hasPlatform: true,
          directions: ['down'],
          canTurnBack: false,
          canBeOvertaken: false,
          maxCars: 10,
          ...MAIN,
          role: 'dt',
        },
        {
          name: '大井町線下り線',
          usage: 'through',
          hasPlatform: false,
          directions: ['down'],
          canTurnBack: false,
          canBeOvertaken: false,
          maxCars: 10,
          ...THRU,
          role: 'om',
        },
        {
          name: '大井町線上り線',
          usage: 'through',
          hasPlatform: false,
          directions: ['up'],
          canTurnBack: false,
          canBeOvertaken: false,
          maxCars: 10,
          ...THRU,
          role: 'om',
        },
        {
          name: '2番線',
          number: 2,
          usage: 'main',
          hasPlatform: true,
          directions: ['up'],
          canTurnBack: false,
          canBeOvertaken: false,
          maxCars: 10,
          ...MAIN,
          role: 'dt',
        },
      ];
    case 'mizonokuchi':
      // 島式2面4線: outer 1・4 = 田園都市線, inner 2・3 = 大井町線, plus two
      // 引上線 on the 梶が谷 side used for 折り返し and the last 入庫.
      return [
        {
          name: '1番線',
          number: 1,
          usage: 'main',
          hasPlatform: true,
          directions: ['down', 'up'],
          canTurnBack: true,
          canBeOvertaken: false,
          maxCars: 10,
          ...MAIN,
          role: 'dt',
        },
        omPlatform('2番線', 2, ['down', 'up'], { canTurnBack: true }),
        omPlatform('3番線', 3, ['down', 'up'], { canTurnBack: true }),
        {
          name: '4番線',
          number: 4,
          usage: 'main',
          hasPlatform: true,
          directions: ['down', 'up'],
          canTurnBack: true,
          canBeOvertaken: false,
          maxCars: 10,
          ...MAIN,
          role: 'dt',
        },
        {
          name: '引上1号線',
          usage: 'stabling',
          hasPlatform: false,
          directions: ['down', 'up'],
          canTurnBack: true,
          canBeOvertaken: false,
          maxCars: 7,
          ...YARD,
          role: 'stabling',
        },
        {
          name: '引上2号線',
          usage: 'stabling',
          hasPlatform: false,
          directions: ['down', 'up'],
          canTurnBack: true,
          canBeOvertaken: false,
          maxCars: 7,
          ...YARD,
          role: 'stabling',
        },
      ];
    case 'saginumaStation':
      return [1, 2, 3, 4].map((n) => ({
        name: `${n}番線`,
        number: n,
        usage: 'main' as const,
        hasPlatform: true,
        directions: ['down', 'up'] as Direction[],
        canTurnBack: true,
        canBeOvertaken: false,
        maxCars: 10,
        ...MAIN,
        role: 'dt' as const,
      }));
    case 'depotYard':
      return Array.from({ length: 10 }, (_, i) => ({
        name: `留置${i + 1}番線`,
        number: i + 1,
        usage: 'stabling' as const,
        hasPlatform: false,
        directions: ['down', 'up'] as Direction[],
        canTurnBack: true,
        canBeOvertaken: false,
        maxCars: 10,
        ...YARD,
        role: 'depot' as const,
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
        maxCars: 10,
        ...YARD,
        role: 'depot' as const,
      }));
  }
}

// ---------------------------------------------------------------------------
// The station table
// ---------------------------------------------------------------------------

interface StationSpec {
  key: StationKey;
  name: string;
  kana: string;
  code?: string;
  km: number;
  /**
   * Reconstruction: base running time from the previous station in km order,
   * for BOTH performance profiles. Chosen at ~50 km/h and rounded to the
   * 5-second grain so that no computed time ever needs rounding.
   */
  runSecFromPrev?: number;
  minDwellSec: number;
  minTurnbackSec: number;
  layout: LayoutKind;
  kind?: Station['kind'];
  isConnectionPoint?: boolean;
  transfers?: string[];
  defaultDown?: string;
  defaultUp?: string;
}

const STATION_SPECS: readonly StationSpec[] = [
  {
    key: 'oimachi',
    name: '大井町',
    kana: 'おおいまち',
    code: 'OM01',
    km: 0.0,
    minDwellSec: 30,
    minTurnbackSec: 240, // stub terminal, in-place reversal, no tail track
    layout: 'terminalStub',
    transfers: ['JR京浜東北線', '東京臨海高速鉄道りんかい線'],
    defaultDown: '1番線',
    defaultUp: '2番線',
  },
  {
    key: 'shimoshimmei',
    name: '下神明',
    kana: 'しもしんめい',
    code: 'OM02',
    km: 0.6,
    runSecFromPrev: 45,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
  },
  {
    key: 'togoshikoen',
    name: '戸越公園',
    kana: 'とごしこうえん',
    code: 'OM03',
    km: 1.3,
    runSecFromPrev: 50,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
  },
  {
    key: 'nakanobu',
    name: '中延',
    kana: 'なかのぶ',
    code: 'OM04',
    km: 1.9,
    runSecFromPrev: 45,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
    transfers: ['都営浅草線'],
  },
  {
    key: 'ebaramachi',
    name: '荏原町',
    kana: 'えばらまち',
    code: 'OM05',
    km: 2.4,
    runSecFromPrev: 35,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
  },
  {
    key: 'hatanodai',
    name: '旗の台',
    kana: 'はたのだい',
    code: 'OM06',
    km: 3.1,
    runSecFromPrev: 50,
    minDwellSec: 30,
    minTurnbackSec: 180,
    layout: 'hatanodai',
    isConnectionPoint: true,
    transfers: ['東急池上線'],
    defaultDown: '4番線',
    defaultUp: '5番線',
  },
  {
    key: 'kitasenzoku',
    name: '北千束',
    kana: 'きたせんぞく',
    code: 'OM07',
    km: 4.0,
    runSecFromPrev: 65,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
  },
  {
    key: 'ookayama',
    name: '大岡山',
    kana: 'おおおかやま',
    code: 'OM08',
    km: 4.8,
    runSecFromPrev: 60,
    minDwellSec: 30,
    minTurnbackSec: 180,
    // Four tracks exist, but the other two are the 目黒線's — they can never
    // be used to overtake a 大井町線 train, so only two are modelled.
    layout: 'double',
    transfers: ['東急目黒線'],
  },
  {
    key: 'midorigaoka',
    name: '緑が丘',
    kana: 'みどりがおか',
    code: 'OM09',
    km: 5.5,
    runSecFromPrev: 50,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
  },
  {
    key: 'jiyugaoka',
    name: '自由が丘',
    kana: 'じゆうがおか',
    code: 'OM10',
    km: 6.4,
    runSecFromPrev: 65,
    minDwellSec: 30,
    minTurnbackSec: 180,
    // Same story as 大岡山: the other two faces belong to the 東横線.
    layout: 'double',
    transfers: ['東急東横線'],
  },
  {
    key: 'kuhombutsu',
    name: '九品仏',
    kana: 'くほんぶつ',
    code: 'OM11',
    km: 7.2,
    runSecFromPrev: 60,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
  },
  {
    key: 'oyamadai',
    name: '尾山台',
    kana: 'おやまだい',
    code: 'OM12',
    km: 8.1,
    runSecFromPrev: 65,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
  },
  {
    key: 'todoroki',
    name: '等々力',
    kana: 'とどろき',
    code: 'OM13',
    km: 8.7,
    runSecFromPrev: 45,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
  },
  {
    key: 'kaminoge',
    name: '上野毛',
    kana: 'かみのげ',
    code: 'OM14',
    km: 9.5,
    runSecFromPrev: 60,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'kaminoge',
    isConnectionPoint: true,
    defaultDown: '1番線',
    defaultUp: '2番線',
  },
  {
    key: 'futakotamagawa',
    name: '二子玉川',
    kana: 'ふたこたまがわ',
    code: 'OM15',
    km: 10.4,
    runSecFromPrev: 65,
    minDwellSec: 30,
    minTurnbackSec: 180,
    layout: 'futakotamagawa',
    transfers: ['東急田園都市線'],
    defaultDown: '2番線',
    defaultUp: '3番線',
  },
  {
    key: 'futakoshinchi',
    name: '二子新地',
    kana: 'ふたこしんち',
    code: 'DT08',
    km: 11.1,
    runSecFromPrev: 50,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'noOimachiPlatform',
    transfers: ['東急田園都市線'],
    defaultDown: '大井町線下り線',
    defaultUp: '大井町線上り線',
  },
  {
    key: 'takatsu',
    name: '高津',
    kana: 'たかつ',
    code: 'DT09',
    km: 11.7,
    runSecFromPrev: 45,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'noOimachiPlatform',
    transfers: ['東急田園都市線'],
    defaultDown: '大井町線下り線',
    defaultUp: '大井町線上り線',
  },
  {
    key: 'mizonokuchi',
    name: '溝の口',
    kana: 'みぞのくち',
    code: 'OM16',
    km: 12.4,
    runSecFromPrev: 50,
    minDwellSec: 30,
    minTurnbackSec: 180, // 引上線 available, so quicker than 大井町
    layout: 'mizonokuchi',
    transfers: ['東急田園都市線', 'JR南武線(武蔵溝ノ口)'],
    defaultDown: '2番線',
    defaultUp: '3番線',
  },
  // --- 田園都市線 section: km posts are APPROXIMATE, measured on the 大井町
  //     axis rather than the real 渋谷 origin. See the file header.
  {
    key: 'kajigaya',
    name: '梶が谷',
    kana: 'かじがや',
    code: 'DT11',
    km: 13.7,
    runSecFromPrev: 95,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
  },
  {
    key: 'miyamaedaira',
    name: '宮前平',
    kana: 'みやまえだいら',
    code: 'DT12',
    km: 15.4,
    runSecFromPrev: 125,
    minDwellSec: 20,
    minTurnbackSec: 180,
    layout: 'double',
  },
  {
    key: 'saginuma',
    name: '鷺沼',
    kana: 'さぎぬま',
    code: 'DT14',
    km: 16.9,
    runSecFromPrev: 110,
    minDwellSec: 30,
    minTurnbackSec: 240,
    layout: 'saginumaStation',
    transfers: ['東急田園都市線'],
    defaultDown: '1番線',
    defaultUp: '4番線',
  },
  // --- synthetic depot nodes -------------------------------------------------
  {
    key: 'saginumaDepot',
    name: '鷺沼車庫',
    kana: 'さぎぬましゃこ',
    km: 17.4,
    runSecFromPrev: 75, // yard speed
    minDwellSec: 30,
    minTurnbackSec: 300,
    layout: 'depotYard',
    kind: 'depot',
  },
  {
    key: 'nagatsutaWorks',
    name: '長津田車両工場',
    kana: 'ながつたしゃりょうこうじょう',
    // Deliberately far off the 大井町 axis: this node exists only as the
    // destination of 重要部検査 / 全般検査. No seeded train ever reaches it.
    km: 30.0,
    runSecFromPrev: 900,
    minDwellSec: 60,
    minTurnbackSec: 600,
    layout: 'works',
    kind: 'depot',
  },
];

// ---------------------------------------------------------------------------
// Performance profiles and penalties
// ---------------------------------------------------------------------------

/**
 * Reconstruction. Both profiles share `baseRunSec`; they differ only in the
 * start/stop penalties, which is enough to make a 7-car 急行 slightly heavier
 * on the clock at each stop than a 5-car 各停 — longer train, longer berth,
 * longer door cycle. Everything stays on the 5-second grain.
 */
export const PENALTY = {
  car7: { startPenaltySec: 15, stopPenaltySec: 15 },
  car5: { startPenaltySec: 10, stopPenaltySec: 10 },
} as const;

export const CARS = { express: 7, local: 5 } as const;

// ---------------------------------------------------------------------------
// Train types & stop patterns
// ---------------------------------------------------------------------------

export type TrainTypeKey = 'express' | 'localGreen' | 'localBlue' | 'deadhead';

export type PatternKey =
  | 'expressDown'
  | 'expressUp'
  | 'expressDownSaginuma'
  | 'expressUpSaginuma'
  | 'greenDown'
  | 'greenUp'
  | 'blueDown'
  | 'blueUp'
  | 'blueDownSaginuma'
  | 'blueUpSaginuma';

interface PatternSpec {
  key: PatternKey;
  name: string;
  typeKey: Exclude<TrainTypeKey, 'deadhead'>;
  direction: Direction;
  originKey: StationKey;
  terminusKey: StationKey;
}

const PATTERN_SPECS: readonly PatternSpec[] = [
  { key: 'expressDown', name: '急行 大井町→溝の口', typeKey: 'express', direction: 'down', originKey: 'oimachi', terminusKey: 'mizonokuchi' },
  { key: 'expressUp', name: '急行 溝の口→大井町', typeKey: 'express', direction: 'up', originKey: 'mizonokuchi', terminusKey: 'oimachi' },
  { key: 'expressDownSaginuma', name: '急行 大井町→鷺沼(直通)', typeKey: 'express', direction: 'down', originKey: 'oimachi', terminusKey: 'saginuma' },
  { key: 'expressUpSaginuma', name: '急行 鷺沼→大井町(直通)', typeKey: 'express', direction: 'up', originKey: 'saginuma', terminusKey: 'oimachi' },
  { key: 'greenDown', name: '各停(緑) 大井町→溝の口', typeKey: 'localGreen', direction: 'down', originKey: 'oimachi', terminusKey: 'mizonokuchi' },
  { key: 'greenUp', name: '各停(緑) 溝の口→大井町', typeKey: 'localGreen', direction: 'up', originKey: 'mizonokuchi', terminusKey: 'oimachi' },
  { key: 'blueDown', name: '各停(青) 大井町→溝の口', typeKey: 'localBlue', direction: 'down', originKey: 'oimachi', terminusKey: 'mizonokuchi' },
  { key: 'blueUp', name: '各停(青) 溝の口→大井町', typeKey: 'localBlue', direction: 'up', originKey: 'mizonokuchi', terminusKey: 'oimachi' },
  { key: 'blueDownSaginuma', name: '各停(青) 大井町→鷺沼', typeKey: 'localBlue', direction: 'down', originKey: 'oimachi', terminusKey: 'saginuma' },
  { key: 'blueUpSaginuma', name: '各停(青) 鷺沼→大井町', typeKey: 'localBlue', direction: 'up', originKey: 'saginuma', terminusKey: 'oimachi' },
];

/**
 * What each type does at a station it passes through.
 *
 * `undefined` = not served at all (outside the route). The 急行 / 緑各停 vs
 * 青各停 split at 二子新地・高津 is the whole reason the two 各停 are separate
 * types rather than two stopping patterns of one type: they are on different
 * pairs of rails.
 */
function behaviourAt(typeKey: Exclude<TrainTypeKey, 'deadhead'>, key: StationKey): StopKind {
  if (typeKey === 'express') {
    return EXPRESS_STOP_KEYS.includes(key) || isBeyondMizonokuchi(key) ? 'stop' : 'pass';
  }
  if (typeKey === 'localGreen') {
    return NO_OIMACHI_PLATFORM_KEYS.includes(key) ? 'pass' : 'stop';
  }
  // 青各停 stops everywhere on its route, 二子新地・高津 included.
  return 'stop';
}

function isBeyondMizonokuchi(key: StationKey): boolean {
  return key === 'kajigaya' || key === 'miyamaedaira' || key === 'saginuma';
}

// ---------------------------------------------------------------------------
// Rolling stock
// ---------------------------------------------------------------------------

export interface SeriesSpec {
  key: string;
  name: string;
  cars: number;
  /** Formation codes, in fleet order. Codes follow the real 東急 convention. */
  codes: string[];
  commissionedOn: string;
  color: string;
}

/**
 * Fleet as researched. 急行 runs on 7両: 6000系 six sets plus 6020系 two sets.
 * 各停 runs on 5両: 9000系 (the bulk), 9020系 (ex-2000系), and a handful of new
 * 6020系5両. The individual formation NUMBERS are plausible but reconstructed.
 */
export const SERIES_SPECS: readonly SeriesSpec[] = [
  {
    key: 's6000',
    name: '6000系',
    cars: 7,
    codes: ['6101F', '6102F', '6103F', '6104F', '6105F', '6106F'],
    commissionedOn: '2008-03-28',
    color: '#dc2626',
  },
  {
    key: 's6020',
    name: '6020系',
    cars: 7,
    codes: ['6121F', '6122F'],
    commissionedOn: '2018-03-28',
    color: '#b91c1c',
  },
  {
    key: 's9000',
    name: '9000系',
    cars: 5,
    codes: [
      '9001F', '9002F', '9003F', '9004F', '9005F', '9006F', '9007F',
      '9008F', '9009F', '9010F', '9011F', '9012F', '9013F',
    ],
    commissionedOn: '1991-04-01',
    color: '#16a34a',
  },
  {
    key: 's9020',
    name: '9020系',
    cars: 5,
    codes: ['9021F', '9022F', '9023F'],
    commissionedOn: '1992-04-01',
    color: '#0d9488',
  },
  {
    key: 's6020five',
    name: '6020系(5両)',
    cars: 5,
    codes: ['6131F', '6132F', '6133F'],
    commissionedOn: '2025-04-01',
    color: '#2563eb',
  },
];

// ---------------------------------------------------------------------------
// Built facts
// ---------------------------------------------------------------------------

export interface Facts {
  dayTypeId: DayTypeId;
  line: Line;
  stations: Station[];
  tracks: StationTrack[];
  links: Link[];
  perfProfiles: PerfProfile[];
  linkRunTimes: LinkRunTime[];
  depots: Depot[];
  trainTypes: TrainType[];
  stopPatterns: StopPattern[];
  formationSeries: FormationSeries[];
  inspectionRules: InspectionRule[];

  /** key -> StationId */
  S: Record<StationKey, StationId>;
  keyOf: Map<StationId, StationKey>;
  stationById: Map<StationId, Station>;
  tracksOf: Map<StationId, StationTrack[]>;
  trackRole: Map<StationTrackId, TrackRole>;

  profile: Record<'car7' | 'car5', PerfProfileId>;
  type: Record<TrainTypeKey, TrainTypeId>;
  pattern: Record<PatternKey, StopPatternId>;
  patternSpec: Record<PatternKey, PatternSpec>;
  depotId: Record<'saginuma' | 'nagatsuta', DepotId>;
  seriesId: Record<string, SeriesId>;

  /** Stations in `down` order, depot nodes excluded. */
  axis: StationKey[];

  runTime(from: StationId, to: StationId, profileId: PerfProfileId): LinkRunTime;
}

export function buildFacts(): Facts {
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

  // -- profiles -------------------------------------------------------------
  const car7: PerfProfile = {
    id: nextProfile<'PerfProfile'>(),
    name: '7両編成 (6000系・6020系)',
    accelKmhps: 3.0,
    decelKmhps: 3.5,
    maxSpeedKmh: 110,
  };
  const car5: PerfProfile = {
    id: nextProfile<'PerfProfile'>(),
    name: '5両編成 (9000系・9020系・6020系5両)',
    accelKmhps: 3.2,
    decelKmhps: 3.5,
    maxSpeedKmh: 110,
  };

  // -- stations & tracks ----------------------------------------------------
  const S = {} as Record<StationKey, StationId>;
  const keyOf = new Map<StationId, StationKey>();
  const stations: Station[] = [];
  const tracks: StationTrack[] = [];
  const tracksOf = new Map<StationId, StationTrack[]>();
  const trackRole = new Map<StationTrackId, TrackRole>();
  const stationById = new Map<StationId, Station>();

  for (const spec of STATION_SPECS) {
    const stationId = nextStation<'Station'>();
    S[spec.key] = stationId;
    keyOf.set(stationId, spec.key);

    const specs = layoutTracks(spec.layout);
    const built: StationTrack[] = specs.map((t) => {
      const id = nextTrack<'StationTrack'>();
      trackRole.set(id, t.role);
      const track: StationTrack = {
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
      };
      return track;
    });
    tracks.push(...built);
    tracksOf.set(stationId, built);

    const byName = new Map(built.map((t) => [t.name, t]));
    const downTrack = spec.defaultDown === undefined ? built[0] : byName.get(spec.defaultDown);
    const upTrack =
      spec.defaultUp === undefined ? built[built.length - 1] : byName.get(spec.defaultUp);
    if (downTrack === undefined || upTrack === undefined) {
      throw new SeedError('default track not found', { station: spec.name });
    }

    const station: Station = {
      id: stationId,
      name: spec.name,
      nameKana: spec.kana,
      kind: spec.kind ?? 'passenger',
      kmFromOrigin: kmToMeters(spec.km),
      trackIds: built.map((t) => t.id),
      minDwellSec: spec.minDwellSec,
      minTurnbackSec: spec.minTurnbackSec,
      defaultTrackId: { down: downTrack.id, up: upTrack.id },
      isConnectionPoint: spec.isConnectionPoint ?? false,
      ...(spec.code === undefined ? {} : { code: spec.code }),
      ...(spec.transfers === undefined ? {} : { transfers: [...spec.transfers] }),
    };
    stations.push(station);
    stationById.set(stationId, station);
  }

  // -- links ----------------------------------------------------------------
  // The 二子玉川〜溝の口 方向別複々線 is modelled at the 番線 level (each station
  // carries both an 大井町線 pair and a 田園都市線 pair) rather than as parallel
  // Links, because `buildLinkLookup` keys links by station pair. Nothing in the
  // simulation needs two Link rows there — direction, platform and headway are
  // all already expressed on the tracks.
  const links: Link[] = [];
  const linkRunTimes: LinkRunTime[] = [];

  const chain = STATION_SPECS.filter((s) => (s.kind ?? 'passenger') !== 'depot');
  for (let i = 1; i < chain.length; i++) {
    const from = chain[i - 1]!;
    const to = chain[i]!;
    pushLink(from, to);
  }
  // Depot stubs. 鷺沼車庫 hangs off 鷺沼; 長津田車両工場 also hangs off 鷺沼 so
  // that the graph stays connected even though nothing is timetabled to it.
  pushLink(STATION_SPECS.find((s) => s.key === 'saginuma')!, STATION_SPECS.find((s) => s.key === 'saginumaDepot')!);
  pushLink(STATION_SPECS.find((s) => s.key === 'saginuma')!, STATION_SPECS.find((s) => s.key === 'nagatsutaWorks')!);

  function pushLink(from: StationSpec, to: StationSpec): void {
    const id = nextLink<'Link'>();
    const distance: Meters = kmToMeters(to.km) - kmToMeters(from.km);
    links.push({
      id,
      fromStationId: S[from.key],
      toStationId: S[to.key],
      distance,
      trackCount: 2,
      minHeadwaySec: 90,
      maxSpeedKmh: 110,
    });
    const base = to.runSecFromPrev ?? 60;
    linkRunTimes.push({ linkId: id, profileId: car7.id, baseRunSec: base, ...PENALTY.car7 });
    linkRunTimes.push({ linkId: id, profileId: car5.id, baseRunSec: base, ...PENALTY.car5 });
  }

  const runTimeByKey = new Map<string, LinkRunTime>();
  const linkById = new Map<LinkId, Link>(links.map((l) => [l.id, l]));
  for (const rt of linkRunTimes) {
    const link = linkById.get(rt.linkId);
    if (link === undefined) continue;
    runTimeByKey.set(`${link.fromStationId}|${link.toStationId}|${rt.profileId}`, rt);
    runTimeByKey.set(`${link.toStationId}|${link.fromStationId}|${rt.profileId}`, rt);
  }

  // -- depots ---------------------------------------------------------------
  const saginumaDepot: Depot = {
    id: nextDepot<'Depot'>(),
    name: '鷺沼車庫',
    stationId: S.saginumaDepot,
    attachedStationId: S.saginuma,
    accessRunSec: 90,
    prepSec: 300,
    capacityFormations: 32,
    capacityCars: 200,
    inspectionKinds: ['train', 'monthly'],
    stubOffsetMeters: kmToMeters(0.5),
  };
  const nagatsutaWorks: Depot = {
    id: nextDepot<'Depot'>(),
    name: '長津田車両工場',
    stationId: S.nagatsutaWorks,
    attachedStationId: S.saginuma,
    accessRunSec: 900,
    prepSec: 600,
    capacityFormations: 6,
    inspectionKinds: ['bogie', 'general'],
    stubOffsetMeters: kmToMeters(13.1),
  };

  // -- train types ----------------------------------------------------------
  const typeIds: Record<TrainTypeKey, TrainTypeId> = {
    express: nextType<'TrainType'>(),
    localGreen: nextType<'TrainType'>(),
    localBlue: nextType<'TrainType'>(),
    deadhead: nextType<'TrainType'>(),
  };

  // -- stop patterns --------------------------------------------------------
  const patternIds = {} as Record<PatternKey, StopPatternId>;
  const patternSpec = {} as Record<PatternKey, PatternSpec>;
  const stopPatterns: StopPattern[] = [];
  const kmOf = (key: StationKey): number => STATION_SPECS.find((s) => s.key === key)!.km;

  for (const spec of PATTERN_SPECS) {
    const id = nextPattern<'StopPattern'>();
    patternIds[spec.key] = id;
    patternSpec[spec.key] = spec;
    const lo = Math.min(kmOf(spec.originKey), kmOf(spec.terminusKey));
    const hi = Math.max(kmOf(spec.originKey), kmOf(spec.terminusKey));
    const entries: Record<string, StopKind> = {};
    for (const st of STATION_SPECS) {
      if ((st.kind ?? 'passenger') === 'depot') continue;
      if (st.km < lo || st.km > hi) continue;
      entries[S[st.key]] = behaviourAt(spec.typeKey, st.key);
    }
    stopPatterns.push({
      id,
      name: spec.name,
      trainTypeId: typeIds[spec.typeKey],
      direction: spec.direction,
      originStationId: S[spec.originKey],
      terminusStationId: S[spec.terminusKey],
      entries,
    });
  }

  const trainTypes: TrainType[] = [
    {
      id: typeIds.express,
      name: '急行',
      shortName: '急',
      color: '#dc2626',
      lineStyle: 'solid',
      lineWidth: 2.5,
      isPassengerService: true,
      perfProfileId: car7.id,
      defaultStopPatternId: patternIds.expressDown,
      sortOrder: 10,
    },
    {
      id: typeIds.localGreen,
      name: '各駅停車(緑)',
      shortName: '各緑',
      color: '#16a34a',
      lineStyle: 'solid',
      lineWidth: 1.5,
      isPassengerService: true,
      perfProfileId: car5.id,
      defaultStopPatternId: patternIds.greenDown,
      sortOrder: 20,
    },
    {
      id: typeIds.localBlue,
      name: '各駅停車(青)',
      shortName: '各青',
      color: '#2563eb',
      lineStyle: 'solid',
      lineWidth: 1.5,
      isPassengerService: true,
      perfProfileId: car5.id,
      defaultStopPatternId: patternIds.blueDown,
      sortOrder: 30,
    },
    {
      id: typeIds.deadhead,
      name: '回送',
      shortName: '回',
      color: '#94a3b8',
      lineStyle: 'dashed',
      lineWidth: 1.25,
      isPassengerService: false,
      // Both car counts run 回送; the 5両 table is the faster of the two, so a
      // 7両 回送 timed with the 7両 penalties always clears the 5両 minimum.
      perfProfileId: car5.id,
      sortOrder: 90,
    },
  ];

  // -- series ---------------------------------------------------------------
  const seriesId: Record<string, SeriesId> = {};
  const formationSeries: FormationSeries[] = SERIES_SPECS.map((s) => {
    const id = nextSeries<'FormationSeries'>();
    seriesId[s.key] = id;
    return {
      id,
      name: s.name,
      perfProfileId: s.cars === 7 ? car7.id : car5.id,
      allowedCarCounts: [s.cars],
      color: s.color,
    };
  });

  // -- inspection rules (省令 values) ---------------------------------------
  const rule = (
    id: InspectionRuleId,
    kind: InspectionRule['kind'],
    name: string,
    body: Omit<InspectionRule, 'id' | 'kind' | 'name' | 'appliesTo'>,
  ): InspectionRule => ({ id, kind, name, appliesTo: 'all', ...body });

  const inspectionRules: InspectionRule[] = [
    rule(nextRule<'InspectionRule'>(), 'train', '列車検査', {
      intervalDays: 10,
      warnBeforeDays: 2,
      outOfServiceDays: 1,
      depotIds: [saginumaDepot.id],
      sortOrder: 10,
    }),
    rule(nextRule<'InspectionRule'>(), 'monthly', '月検査(交番検査)', {
      intervalDays: 90,
      intervalKm: 30_000,
      warnBeforeDays: 7,
      warnBeforeKm: 2_000,
      outOfServiceDays: 2,
      depotIds: [saginumaDepot.id],
      sortOrder: 20,
    }),
    rule(nextRule<'InspectionRule'>(), 'bogie', '重要部検査', {
      intervalDays: 1_460,
      intervalKm: 600_000,
      warnBeforeDays: 60,
      warnBeforeKm: 20_000,
      outOfServiceDays: 14,
      depotIds: [nagatsutaWorks.id],
      sortOrder: 30,
    }),
    rule(nextRule<'InspectionRule'>(), 'general', '全般検査', {
      intervalDays: 2_920,
      warnBeforeDays: 90,
      outOfServiceDays: 30,
      depotIds: [nagatsutaWorks.id],
      sortOrder: 40,
    }),
  ];

  const line: Line = {
    id: asId<'Line'>(`${ID_PREFIX.line}-1`),
    name: '東急大井町線',
    nameKana: 'とうきゅうおおいまちせん',
    downDirectionLabel: '溝の口・鷺沼方面',
    upDirectionLabel: '大井町方面',
    color: '#f57e19',
  };

  return {
    dayTypeId,
    line,
    stations,
    tracks,
    links,
    perfProfiles: [car7, car5],
    linkRunTimes,
    depots: [saginumaDepot, nagatsutaWorks],
    trainTypes,
    stopPatterns,
    formationSeries,
    inspectionRules,
    S,
    keyOf,
    stationById,
    tracksOf,
    trackRole,
    profile: { car7: car7.id, car5: car5.id },
    type: typeIds,
    pattern: patternIds,
    patternSpec,
    depotId: { saginuma: saginumaDepot.id, nagatsuta: nagatsutaWorks.id },
    seriesId,
    axis: chain.map((s) => s.key),
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

/** km of a station key, in metres. Handy for tests and diagnostics. */
export function stationKm(key: StationKey): Meters {
  const spec = STATION_SPECS.find((s) => s.key === key);
  if (spec === undefined) throw new SeedError('unknown station key', { key });
  return kmToMeters(spec.km);
}

export function stationNameOf(key: StationKey): string {
  const spec = STATION_SPECS.find((s) => s.key === key);
  if (spec === undefined) throw new SeedError('unknown station key', { key });
  return spec.name;
}
