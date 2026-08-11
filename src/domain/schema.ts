/**
 * Zod schema for the project document.
 *
 * This guards the import boundary only — anything reaching the store has
 * already been through `parseProject`. Cross-reference checks live in
 * integrity.ts, because Zod cannot express "this id must exist elsewhere".
 */

import { z } from 'zod';
import { SCHEMA_VERSION, type ProjectDocument } from './model';

const id = z.string().min(1);
const sec = z.number().finite();
const meters = z.number().finite();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式である必要があります');

function entities<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    byId: z.record(z.string(), item),
    allIds: z.array(z.string()),
  });
}

const direction = z.enum(['down', 'up']);
const stationEnd = z.enum(['down', 'up']);
const inspectionKind = z.enum(['train', 'monthly', 'bogie', 'general']);

const lineSchema = z.object({
  id,
  name: z.string(),
  nameKana: z.string().optional(),
  downDirectionLabel: z.string(),
  upDirectionLabel: z.string(),
  color: z.string(),
});

const stationSchema = z.object({
  id,
  name: z.string(),
  nameKana: z.string().optional(),
  code: z.string().optional(),
  kind: z.enum(['passenger', 'signal', 'depot']),
  kmFromOrigin: meters,
  trackIds: z.array(id),
  minDwellSec: z.number().nonnegative(),
  minTurnbackSec: z.number().nonnegative(),
  defaultTrackId: z.object({ down: id.optional(), up: id.optional() }),
  isConnectionPoint: z.boolean(),
  transfers: z.array(z.string()).optional(),
  crossovers: z
    .array(
      z.object({
        end: stationEnd,
        from: z.string().min(1),
        to: z.string().min(1),
        name: z.string().optional(),
      }),
    )
    .optional(),
});

const stationTrackSchema = z.object({
  id,
  stationId: id,
  name: z.string(),
  number: z.number().optional(),
  usage: z.enum(['main', 'passing', 'through', 'depot', 'stabling']),
  hasPlatform: z.boolean(),
  directions: z.array(direction),
  canTurnBack: z.boolean(),
  canBeOvertaken: z.boolean(),
  maxCars: z.number().int().positive(),
  approachSec: z.number().nonnegative(),
  clearSec: z.number().nonnegative(),
  depotId: id.optional(),
  wiring: z
    .object({
      ends: z.array(stationEnd),
      ladder: z.number().optional(),
      line: z.array(direction).optional(),
      connects: z
        .object({
          down: z.array(z.string().min(1)).optional(),
          up: z.array(z.string().min(1)).optional(),
        })
        .optional(),
    })
    .optional(),
});

const linkSchema = z.object({
  id,
  fromStationId: id,
  toStationId: id,
  distance: meters,
  trackCount: z.union([z.literal(1), z.literal(2)]),
  minHeadwaySec: z.number().nonnegative(),
  maxSpeedKmh: z.number().positive(),
});

const perfProfileSchema = z.object({
  id,
  name: z.string(),
  accelKmhps: z.number().positive(),
  decelKmhps: z.number().positive(),
  maxSpeedKmh: z.number().positive(),
});

const linkRunTimeSchema = z.object({
  linkId: id,
  profileId: id,
  baseRunSec: z.number().nonnegative(),
  startPenaltySec: z.number().nonnegative(),
  stopPenaltySec: z.number().nonnegative(),
});

const depotSchema = z.object({
  id,
  name: z.string(),
  stationId: id,
  attachedStationId: id,
  accessRunSec: z.number().nonnegative(),
  prepSec: z.number().nonnegative(),
  capacityFormations: z.number().int().nonnegative(),
  capacityCars: z.number().int().nonnegative().optional(),
  inspectionKinds: z.array(inspectionKind),
  stubOffsetMeters: meters,
});

const trainTypeSchema = z.object({
  id,
  name: z.string(),
  shortName: z.string(),
  color: z.string(),
  lineStyle: z.enum(['solid', 'dashed', 'dotted']),
  lineWidth: z.number().positive(),
  isPassengerService: z.boolean(),
  perfProfileId: id,
  defaultStopPatternId: id.optional(),
  sortOrder: z.number(),
});

const stopKind = z.enum(['stop', 'pass']);

const stopPatternSchema = z.object({
  id,
  name: z.string(),
  trainTypeId: id,
  direction: z.union([direction, z.literal('both')]),
  originStationId: id,
  terminusStationId: id,
  entries: z.record(z.string(), stopKind),
  dwellOverrideSec: z.record(z.string(), z.number()).optional(),
});

const trainStopSchema = z.object({
  stationId: id,
  trackId: id.optional(),
  arr: sec.optional(),
  dep: sec.optional(),
  kind: stopKind,
  operational: z.boolean().optional(),
  operation: z
    .enum(['turnback', 'crewChange', 'couple', 'uncouple', 'depotIn', 'depotOut'])
    .optional(),
  overtakenBy: z.array(id).optional(),
  connectsTo: z.array(id).optional(),
  note: z.string().optional(),
});

const trainSchema = z.object({
  id,
  number: z.string(),
  typeId: id,
  direction,
  category: z.enum(['service', 'deadhead', 'test', 'shunt']),
  patternId: id.optional(),
  stops: z.array(trainStopSchema),
  dayTypeIds: z.array(id),
  minCars: z.number().int().positive().optional(),
  allowedSeriesIds: z.array(id).optional(),
  origin: z
    .object({
      generator: z.literal('seed'),
      bandId: z.string(),
      slotId: z.string(),
      cycleIndex: z.number().int(),
    })
    .optional(),
  note: z.string().optional(),
});

const dutyLegSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('train'), trainId: id }),
  z.object({
    kind: z.literal('stable'),
    stationId: id,
    trackId: id.optional(),
    from: sec,
    to: sec,
  }),
  z.object({
    kind: z.literal('inspection'),
    depotId: id,
    inspectionKind,
    from: sec,
    to: sec,
  }),
]);

const dutySchema = z.object({
  id,
  code: z.string(),
  dayTypeIds: z.array(id),
  legs: z.array(dutyLegSchema),
  requiredCars: z.number().int().positive().optional(),
  requiredSeriesIds: z.array(id).optional(),
  color: z.string().optional(),
});

const assignmentSchema = z.object({ id, date: isoDate, dutyId: id, formationId: id });

const formationSeriesSchema = z.object({
  id,
  name: z.string(),
  perfProfileId: id,
  allowedCarCounts: z.array(z.number().int().positive()),
  color: z.string().optional(),
});

const formationSchema = z.object({
  id,
  code: z.string(),
  seriesId: id,
  cars: z.number().int().positive(),
  homeDepotId: id,
  status: z.enum(['active', 'inInspection', 'stored', 'retired']),
  odometerKm: z.number().nonnegative(),
  odometerAsOf: isoDate,
  commissionedOn: isoDate,
  note: z.string().optional(),
});

const inspectionRuleSchema = z.object({
  id,
  kind: inspectionKind,
  name: z.string(),
  appliesTo: z.union([z.object({ seriesIds: z.array(id) }), z.literal('all')]),
  intervalDays: z.number().positive().optional(),
  intervalKm: z.number().positive().optional(),
  warnBeforeDays: z.number().nonnegative().optional(),
  warnBeforeKm: z.number().nonnegative().optional(),
  outOfServiceDays: z.number().nonnegative(),
  depotIds: z.array(id),
  sortOrder: z.number(),
});

const inspectionRecordSchema = z.object({
  id,
  formationId: id,
  ruleId: id,
  kind: inspectionKind,
  status: z.enum(['completed', 'planned']),
  from: isoDate,
  to: isoDate,
  odometerKmAt: z.number().nonnegative().optional(),
  depotId: id,
  note: z.string().optional(),
});

const dayTypeSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(['weekday', 'holiday', 'special']),
  color: z.string(),
});

export const projectSchema = z.object({
  schemaVersion: z.number().int(),
  meta: z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    appVersion: z.string(),
  }),
  settings: z.object({
    serviceDayStartSec: sec,
    serviceDayEndSec: sec,
    timeGrainSec: z.union([
      z.literal(1),
      z.literal(5),
      z.literal(10),
      z.literal(15),
      z.literal(30),
      z.literal(60),
    ]),
    activeDate: isoDate,
    activeDayTypeId: id,
  }),
  validationConfig: z.object({
    severityOverrides: z.record(z.string(), z.enum(['error', 'warning', 'info', 'off'])),
    defaultMinHeadwaySec: z.number().nonnegative(),
    defaultMinTurnbackSec: z.number().nonnegative(),
    preferredTurnbackSec: z.number().nonnegative(),
    connectionMinTransferSec: z.number().nonnegative(),
    connectionMaxWaitSec: z.number().nonnegative(),
    overtakeClearanceSec: z.number().nonnegative(),
    inspectionWarnRatio: z.number().min(0).max(1),
  }),
  line: lineSchema,
  stations: entities(stationSchema),
  stationTracks: entities(stationTrackSchema),
  links: entities(linkSchema),
  perfProfiles: entities(perfProfileSchema),
  linkRunTimes: z.array(linkRunTimeSchema),
  depots: entities(depotSchema),
  trainTypes: entities(trainTypeSchema),
  stopPatterns: entities(stopPatternSchema),
  trains: entities(trainSchema),
  duties: entities(dutySchema),
  formationSeries: entities(formationSeriesSchema),
  formations: entities(formationSchema),
  inspectionRules: entities(inspectionRuleSchema),
  inspectionRecords: entities(inspectionRecordSchema),
  dayTypes: entities(dayTypeSchema),
  calendar: z.array(z.object({ date: isoDate, dayTypeId: id })),
  assignments: entities(assignmentSchema),
});

export interface ParseResult {
  ok: boolean;
  doc?: ProjectDocument;
  errors: string[];
}

/** Validate an untrusted object as a ProjectDocument. */
export function parseProject(raw: unknown): ParseResult {
  const result = projectSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.slice(0, 25).map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const doc = result.data as unknown as ProjectDocument;
  if (doc.schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `このファイルはより新しいバージョン (v${doc.schemaVersion}) で保存されています。対応バージョンは v${SCHEMA_VERSION} までです。`,
      ],
    };
  }
  return { ok: true, doc, errors: [] };
}
