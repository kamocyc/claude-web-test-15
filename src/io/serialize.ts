/**
 * The import/export boundary.
 *
 * Nothing that has not been through `fromJson` is allowed to reach the store —
 * a hand-edited or truncated file must fail with a readable Japanese message
 * rather than producing a document that crashes three screens later.
 */

import type { ProjectDocument } from '@/domain/model';
import { parseProject } from '@/domain/schema';

import { migrate } from './migrate';

export interface FromJsonResult {
  ok: boolean;
  doc?: ProjectDocument;
  /** Human-readable, already in Japanese. */
  errors: string[];
  /** Migration steps applied on the way in. */
  migrated: number[];
}

/** Pretty-printed so exported files diff sensibly in version control. */
export function toJson(doc: ProjectDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function fromJson(text: string): FromJsonResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`JSON として読み取れませんでした: ${detail}`], migrated: [] };
  }

  const migrated = migrate(raw);
  if (migrated.errors.length > 0) {
    return { ok: false, errors: migrated.errors, migrated: migrated.applied };
  }

  const parsed = parseProject(migrated.raw);
  if (!parsed.ok || parsed.doc === undefined) {
    return {
      ok: false,
      errors: parsed.errors.length > 0 ? parsed.errors.map(describeZodError) : ['不明な検証エラーです。'],
      migrated: migrated.applied,
    };
  }

  return { ok: true, doc: parsed.doc, errors: [], migrated: migrated.applied };
}

/** `stations.byId.stn-1.kmFromOrigin: Expected number` -> a Japanese sentence. */
function describeZodError(line: string): string {
  const at = line.indexOf(': ');
  if (at < 0) return line;
  const path = line.slice(0, at);
  const message = line.slice(at + 2);
  const where = path === '' ? 'ファイル全体' : path;
  return `${where}: ${translate(message)}`;
}

const TRANSLATIONS: Array<[RegExp, string]> = [
  [/^Invalid input: expected (\w+), received (\w+)$/i, '$1 が必要ですが $2 が入っています'],
  [/^Expected (\w+), received (\w+)$/i, '$1 が必要ですが $2 が入っています'],
  [/^Invalid input: expected (\w+)$/i, '$1 が必要です'],
  [/^Required$/i, '必須項目が欠けています'],
  [/^Invalid option.*$/i, '許可されていない値です'],
  [/^Too small.*$/i, '値が小さすぎます'],
  [/^Too big.*$/i, '値が大きすぎます'],
  [/^Unrecognized key.*$/i, '未知のキーが含まれています'],
];

function translate(message: string): string {
  for (const [pattern, replacement] of TRANSLATIONS) {
    if (pattern.test(message)) return message.replace(pattern, replacement);
  }
  return message;
}

/**
 * A download filename.
 *
 * Deliberately ASCII: Chromium silently discards a whole `download` attribute
 * it cannot represent, and the user then gets a file called `download` with no
 * extension. A transliterated stem is worse than a Japanese title in the tab
 * but better than an unopenable file.
 */
export function suggestFileName(doc: ProjectDocument): string {
  const stem = doc.meta.name
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[^ -~]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .trim();
  return `${stem === '' ? 'project' : stem}.rosim.json`;
}
