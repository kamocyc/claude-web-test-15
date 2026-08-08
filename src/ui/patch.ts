/**
 * The one escape hatch every form in this app eventually needs.
 *
 * `exactOptionalPropertyTypes` is on, so `Partial<T>` cannot express "set this
 * key to undefined" — but the reducer's `applyPatch` treats an explicitly
 * undefined value as a delete, and that is the only way a form can clear an
 * optional field (turn a km-based inspection rule back into a days-only one,
 * drop a train's 両数 constraint, remove a stop note).
 *
 * The returned object really does carry the key, with the value undefined;
 * only the *type* pretends otherwise.
 */
export function clearing<T>(key: keyof T & string): Partial<T> {
  return { [key]: undefined } as unknown as Partial<T>;
}

/** Parse a form number, returning undefined for blank or nonsense input. */
export function numberOrUndefined(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}
