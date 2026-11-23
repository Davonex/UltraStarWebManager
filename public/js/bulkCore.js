// @ts-check
/**
 * Logique pure des corrections en masse (sans DOM, testée dans test/public/).
 * @module bulkCore
 */

/** Taille des lots envoyés au serveur (le serveur en accepte au plus 200). */
export const BULK_BATCH_SIZE = 50;

/**
 * Découpe une liste en lots.
 * @template T
 * @param {T[]} items
 * @param {number} [size]
 * @returns {T[][]}
 */
export function chunk(items, size = BULK_BATCH_SIZE) {
  if (!(size > 0)) throw new RangeError('size must be > 0');
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Compte les résultats par statut.
 * @param {{ status: string }[]} results
 * @returns {{ converted: number, unchanged: number, errors: number }}
 */
export function summarizeResults(results) {
  const summary = { converted: 0, unchanged: 0, errors: 0 };
  for (const { status } of results) {
    if (status === 'converted') summary.converted += 1;
    else if (status === 'unchanged') summary.unchanged += 1;
    else summary.errors += 1;
  }
  return summary;
}
