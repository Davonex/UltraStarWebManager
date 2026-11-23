// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BULK_BATCH_SIZE, chunk, summarizeResults } from '../../public/js/bulkCore.js';

describe('chunk', () => {
  it('découpe en lots de taille fixe, le dernier pouvant être plus court', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });
  it('liste vide → aucun lot', () => {
    assert.deepEqual(chunk([], 3), []);
  });
  it('taille par défaut acceptée par le serveur', () => {
    assert.ok(BULK_BATCH_SIZE > 0 && BULK_BATCH_SIZE <= 200);
    assert.equal(
      chunk(Array.from({ length: 120 }, (_, i) => i)).length,
      Math.ceil(120 / BULK_BATCH_SIZE),
    );
  });
  it('refuse une taille nulle', () => {
    assert.throws(() => chunk([1], 0), RangeError);
  });
});

describe('summarizeResults', () => {
  it('compte convertis, inchangés et erreurs', () => {
    assert.deepEqual(
      summarizeResults([
        { status: 'converted' },
        { status: 'converted' },
        { status: 'unchanged' },
        { status: 'error' },
      ]),
      { converted: 2, unchanged: 1, errors: 1 },
    );
  });
});
