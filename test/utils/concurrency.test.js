// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { mapWithConcurrency } from '../../src/utils/concurrency.js';

describe('mapWithConcurrency', () => {
  it('conserve l’ordre et respecte la limite', async () => {
    let running = 0;
    let maxRunning = 0;
    const result = await mapWithConcurrency([30, 10, 20, 5, 15], 2, async (ms) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await sleep(ms);
      running--;
      return ms * 2;
    });
    assert.deepEqual(result, [60, 20, 40, 10, 30]);
    assert.equal(maxRunning, 2);
  });

  it('gère une liste vide', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async (x) => x), []);
  });
});
