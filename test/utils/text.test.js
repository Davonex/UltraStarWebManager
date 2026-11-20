// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileNameKey, splitList } from '../../src/utils/text.js';

describe('splitList', () => {
  it('découpe et nettoie une valeur multiple', () => {
    assert.deepEqual(splitList(' Pop,Rock , ,Funk '), ['Pop', 'Rock', 'Funk']);
    assert.deepEqual(splitList(null), []);
    assert.deepEqual(splitList(''), []);
  });
});

describe('fileNameKey', () => {
  it('ignore la casse et la forme Unicode des accents', () => {
    const composed = 'Rétine.MP3';
    const decomposed = 'Rétine.mp3';
    assert.equal(fileNameKey(composed), fileNameKey(decomposed));
  });
});
