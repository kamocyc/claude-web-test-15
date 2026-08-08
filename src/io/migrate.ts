/**
 * Schema migrations.
 *
 * `MIGRATIONS[n]` upgrades a document written at version `n` to version `n+1`.
 * v1 is the current version so the table is empty, but the loop stays: adding
 * v2 later must be a one-line change, not a redesign of the import path.
 */

import { SCHEMA_VERSION } from '@/domain/model';

export type RawDocument = Record<string, unknown>;
export type Migration = (raw: RawDocument) => RawDocument;

export const MIGRATIONS: Record<number, Migration> = {
  // 1: (raw) => ({ ...raw, schemaVersion: 2, /* ... */ }),
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
