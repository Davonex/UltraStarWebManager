// @ts-check
/**
 * Exécution parallèle limitée.
 * @module utils/concurrency
 */

/**
 * Applique `fn` à chaque élément avec au plus `limit` traitements simultanés.
 * L'ordre des résultats suit l'ordre des éléments.
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, fn) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
