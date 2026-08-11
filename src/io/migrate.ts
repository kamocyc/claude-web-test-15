/**
 * Schema migrations.
 *
 * `MIGRATIONS[n]` upgrades a document written at version `n` to version `n+1`.
 */

import { DEFAULT_VALIDATION_CONFIG } from '@/domain/project';
import { SCHEMA_VERSION } from '@/domain/model';

export type RawDocument = Record<string, unknown>;
export type Migration = (raw: RawDocument) => RawDocument;

const CREW_CONFIG_KEYS = [
  'crewMaxContinuousWorkSec',
  'crewMinBreakSec',
  'crewMinTotalBreakSec',
  'crewMaxSpreadSec',
  'crewMaxWorkSec',
  'crewMinHandoverSec',
  'crewSignOnSec',
  'crewSignOffSec',
] as const;

export const MIGRATIONS: Record<number, Migration> = {
  /**
   * v2 added 乗務員. A v1 document has no crew of any kind, which is a
   * perfectly good v2 document — three empty collections and the default
   * working rules. Existing values are kept, so a file written by a build
   * that already had some of these keys is not overwritten.
   */
  1: (raw) => {
    const cfg = (typeof raw['validationConfig'] === 'object' && raw['validationConfig'] !== null
      ? (raw['validationConfig'] as Record<string, unknown>)
      : {}) satisfies Record<string, unknown>;
    const filled: Record<string, unknown> = { ...cfg };
    for (const key of CREW_CONFIG_KEYS) {
      if (typeof filled[key] !== 'number') filled[key] = DEFAULT_VALIDATION_CONFIG[key];
    }
    return {
      ...raw,
      validationConfig: filled,
      crew: raw['crew'] ?? { byId: {}, allIds: [] },
      crewDuties: raw['crewDuties'] ?? { byId: {}, allIds: [] },
      crewAssignments: raw['crewAssignments'] ?? { byId: {}, allIds: [] },
    };
  },
};

export interface MigrateResult {
  raw: RawDocument;
  /** Versions actually applied, in order. */
  applied: number[];
  errors: string[];
}

export function migrate(input: unknown): MigrateResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { raw: {}, applied: [], errors: ['ファイルの内容がプロジェクトの形式ではありません。'] };
  }

  let raw = input as RawDocument;
  const applied: number[] = [];
  const rawVersion = raw['schemaVersion'];
  let version = typeof rawVersion === 'number' ? rawVersion : 1;

  if (version > SCHEMA_VERSION) {
    return {
      raw,
      applied,
      errors: [
        `このファイルはより新しいバージョン (v${version}) で保存されています。対応バージョンは v${SCHEMA_VERSION} までです。`,
      ],
    };
  }

  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (step === undefined) {
      return {
        raw,
        applied,
        errors: [`v${version} から v${version + 1} への変換手順が見つかりません。`],
      };
    }
    raw = step(raw);
    applied.push(version);
    version += 1;
    raw['schemaVersion'] = version;
  }

  return { raw, applied, errors: [] };
}
