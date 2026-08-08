/**
 * A loud, contextual failure for the seed generator.
 *
 * The generator deliberately throws rather than degrading: a silently broken
 * timetable (a 各停 that leaves before the 急行 it is supposed to wait for, a
 * train with no free 番線) is far more expensive to discover later than a
 * failed `npm run seed`.
 */
export class SeedError extends Error {
  readonly context: Readonly<Record<string, string | number>>;

  constructor(message: string, context: Record<string, string | number | undefined> = {}) {
    const kept: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(context)) {
      if (v !== undefined) kept[k] = v;
    }
    const detail = Object.entries(kept)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    super(detail === '' ? message : `${message} [${detail}]`);
    this.name = 'SeedError';
    this.context = kept;
  }
}
