// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildId3WithReplayGain,
  formatGain,
  id3TagSize,
  locateApeTag,
  parseApeReplayGain,
  parseGainValue,
  parseId3ReplayGain,
  UnsupportedTagError,
} from '../../src/parsers/replayGain.js';

/** @param {number} n */
const synchsafe = (n) =>
  Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
/** @param {number} n */
const uint32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/**
 * Tag ID3v2 avec des cadres TXXX.
 * @param {3 | 4} version
 * @param {[string, string][]} pairs
 * @param {{ encoding?: 0 | 1 | 3, padding?: number }} [options]
 */
function id3(version, pairs, { encoding = 0, padding = 20 } = {}) {
  const text = (/** @type {string} */ s) =>
    encoding === 1
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])
      : Buffer.from(s, encoding === 3 ? 'utf8' : 'latin1');
  const zero = encoding === 1 ? Buffer.alloc(2) : Buffer.alloc(1);
  const frames = pairs.map(([key, value]) => {
    const body = Buffer.concat([Buffer.from([encoding]), text(key), zero, text(value)]);
    const size = version === 4 ? synchsafe(body.length) : uint32(body.length);
    return Buffer.concat([Buffer.from('TXXX'), size, Buffer.alloc(2), body]);
  });
  const content = Buffer.concat([
    Buffer.concat([
      Buffer.from('TIT2'),
      version === 4 ? synchsafe(3) : uint32(3),
      Buffer.alloc(2),
      Buffer.from('\0Zen'),
    ]).subarray(0, 13),
    ...frames,
    Buffer.alloc(padding),
  ]);
  return Buffer.concat([
    Buffer.from('ID3'),
    Buffer.from([version, 0, 0]),
    synchsafe(content.length),
    content,
  ]);
}

/**
 * Fin de fichier avec un tag APEv2 (et éventuellement un tag ID3v1).
 * @param {[string, string][]} pairs
 * @param {boolean} withId3v1
 */
function apeTail(pairs, withId3v1) {
  const items = Buffer.concat(
    pairs.map(([key, value]) => {
      const head = Buffer.alloc(8);
      head.writeUInt32LE(Buffer.byteLength(value), 0);
      return Buffer.concat([head, Buffer.from(key), Buffer.from([0]), Buffer.from(value)]);
    }),
  );
  const footer = Buffer.alloc(32);
  footer.write('APETAGEX', 0, 'latin1');
  footer.writeUInt32LE(2000, 8);
  footer.writeUInt32LE(items.length + 32, 12);
  footer.writeUInt32LE(pairs.length, 16);
  const audio = Buffer.alloc(500, 0xaa);
  const id3v1 = withId3v1
    ? Buffer.concat([Buffer.from('TAG'), Buffer.alloc(125)])
    : Buffer.alloc(0);
  return Buffer.concat([audio, items, footer, id3v1]);
}

describe('parseGainValue', () => {
  it('lit « -10.27 dB », « +3,5 dB » et les crêtes', () => {
    assert.equal(parseGainValue('-10.27 dB'), -10.27);
    assert.equal(parseGainValue(' +3,5 dB'), 3.5);
    assert.equal(parseGainValue('0.988'), 0.988);
    assert.equal(parseGainValue('n/a'), null);
  });
});

describe('ID3v2', () => {
  const pairs = /** @type {[string, string][]} */ ([
    ['REPLAYGAIN_TRACK_GAIN', '-10.27 dB'],
    ['replaygain_track_peak', '1.208010'],
    ['REPLAYGAIN_ALBUM_GAIN', '-8.50 dB'],
    ['REPLAYGAIN_ALBUM_PEAK', '1.000000'],
  ]);
  const expected = {
    trackGain: -10.27,
    trackPeak: 1.20801,
    albumGain: -8.5,
    albumPeak: 1,
    source: 'id3',
  };

  it('v2.4, v2.3, latin1, UTF-8 et UTF-16 ; casse des clés ignorée', () => {
    assert.deepEqual(parseId3ReplayGain(id3(4, pairs)), expected);
    assert.deepEqual(parseId3ReplayGain(id3(3, pairs)), expected);
    assert.deepEqual(parseId3ReplayGain(id3(4, pairs, { encoding: 3 })), expected);
    assert.deepEqual(parseId3ReplayGain(id3(3, pairs, { encoding: 1 })), expected);
  });

  it('taille du tag annoncée par l’en-tête', () => {
    const tag = id3(4, pairs);
    assert.equal(id3TagSize(tag), tag.length);
    assert.equal(id3TagSize(Buffer.from('xxxxxxxxxx')), 0);
  });

  it('sans ReplayGain, ou tag tronqué : null, sans exception', () => {
    assert.equal(parseId3ReplayGain(id3(4, [['COMMENT', 'x']])), null);
    const tag = id3(4, pairs);
    assert.doesNotThrow(() => parseId3ReplayGain(tag.subarray(0, 40)));
  });
});

describe('APEv2', () => {
  const pairs = /** @type {[string, string][]} */ ([
    ['MP3GAIN_MINMAX', '128,201'],
    ['REPLAYGAIN_TRACK_GAIN', '-3.700000 dB'],
    ['REPLAYGAIN_TRACK_PEAK', '0.817856'],
  ]);

  for (const withId3v1 of [false, true]) {
    it(`tag en fin de fichier${withId3v1 ? ', suivi d’un ID3v1' : ''}`, () => {
      const file = apeTail(pairs, withId3v1);
      const tail = file.subarray(file.length - 160);
      const ape = locateApeTag(tail, file.length);
      assert.ok(ape);
      assert.deepEqual(parseApeReplayGain(file.subarray(ape.start, ape.start + ape.size)), {
        trackGain: -3.7,
        trackPeak: 0.817856,
        albumGain: null,
        albumPeak: null,
        source: 'ape',
      });
    });
  }

  it('pas de tag APE : null', () => {
    assert.equal(locateApeTag(Buffer.alloc(160), 10_000), null);
  });
});

describe('buildId3WithReplayGain (écriture)', () => {
  const values = { REPLAYGAIN_TRACK_GAIN: '-2.54 dB', REPLAYGAIN_TRACK_PEAK: '0.853360' };

  for (const version of /** @type {const} */ ([3, 4])) {
    it(`ID3v2.${version} : autres cadres recopiés, anciennes valeurs remplacées, relisible`, () => {
      const old = id3(version, [
        ['REPLAYGAIN_TRACK_GAIN', '+9.99 dB'],
        ['MUSICBRAINZ_TRACKID', 'abc'],
      ]);
      const tag = buildId3WithReplayGain(old, values);
      assert.equal(tag[3], version, 'version conservée');
      assert.equal(id3TagSize(tag), tag.length);
      assert.deepEqual(parseId3ReplayGain(tag), {
        trackGain: -2.54,
        trackPeak: 0.85336,
        albumGain: null,
        albumPeak: null,
        source: 'id3',
      });
      const text = Buffer.from(tag).toString('latin1');
      assert.ok(
        text.includes('TIT2') && text.includes('MUSICBRAINZ_TRACKID'),
        'autres cadres gardés',
      );
      assert.ok(!text.includes('+9.99 dB'), 'ancienne valeur retirée');
    });
  }

  it('sans tag : crée un ID3v2.3', () => {
    const tag = buildId3WithReplayGain(null, values);
    assert.equal(tag[3], 3);
    assert.equal(parseId3ReplayGain(tag)?.trackGain, -2.54);
  });

  it('refuse ID3v2.2 et la désynchronisation', () => {
    const v22 = Buffer.from([0x49, 0x44, 0x33, 2, 0, 0, 0, 0, 0, 0]);
    assert.throws(() => buildId3WithReplayGain(v22, values), UnsupportedTagError);
    const unsync = id3(3, []);
    unsync[5] = 0x80;
    assert.throws(() => buildId3WithReplayGain(unsync, values), UnsupportedTagError);
  });

  it('format du gain', () => {
    assert.equal(formatGain(-2.5444), '-2.54 dB');
    assert.equal(formatGain(1.2), '+1.20 dB');
    assert.equal(formatGain(0), '0.00 dB');
  });
});
