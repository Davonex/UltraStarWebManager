// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  containerOf,
  isOversizedVideo,
  isRecommendedVideo,
  needsConversion,
  parseMoov,
  readBoxHeader,
} from '../../src/parsers/mp4Video.js';
import { box, H264_720P, track } from '../helpers/mp4.js';

/** @param {Buffer} file */
function moovOf(file) {
  let offset = 0;
  while (offset < file.length) {
    const header = readBoxHeader(file, offset);
    assert.ok(header);
    if (header.type === 'moov') return file.subarray(offset, offset + header.size);
    offset += header.size;
  }
  throw new Error('pas de moov');
}

describe('readBoxHeader', () => {
  it('lit taille et type, y compris une taille sur 64 bits', () => {
    assert.deepEqual(readBoxHeader(box('free', Buffer.alloc(4)), 0), {
      type: 'free',
      start: 0,
      headerSize: 8,
      size: 12,
    });
    const large = Buffer.alloc(16);
    large.writeUInt32BE(1, 0);
    large.write('mdat', 4, 'latin1');
    large.writeBigUInt64BE(5_000_000_000n, 8);
    assert.equal(readBoxHeader(large, 0)?.size, 5_000_000_000);
  });

  it('null si les octets manquent ou si la taille est incohérente', () => {
    assert.equal(readBoxHeader(Buffer.alloc(4), 0), null);
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(3, 0);
    assert.equal(readBoxHeader(bad, 0), null);
  });
});

describe('parseMoov', () => {
  it('trouve la piste vidéo (même après une piste audio) : codec et résolution', () => {
    assert.deepEqual(parseMoov(moovOf(H264_720P())), { codec: 'h264', width: 1280, height: 720 });
  });

  it('reconnaît HEVC, MPEG-4 Part 2 et garde un codec inconnu tel quel', () => {
    for (const [codec, name] of [
      ['hvc1', 'hevc'],
      ['mp4v', 'mpeg4'],
      ['xyz1', 'xyz1'],
    ]) {
      const moov = box('moov', track({ handler: 'vide', codec, width: 640, height: 480 }));
      assert.deepEqual(parseMoov(moov), { codec: name, width: 640, height: 480 });
    }
  });

  it('null sans piste vidéo ou si ce n’est pas une boîte moov', () => {
    assert.equal(parseMoov(box('moov', track({ handler: 'soun', codec: 'mp4a' }))), null);
    assert.equal(parseMoov(box('free', Buffer.alloc(10))), null);
  });

  it('ne plante pas sur un fichier tronqué', () => {
    const moov = moovOf(H264_720P());
    assert.doesNotThrow(() => parseMoov(moov.subarray(0, moov.length - 60)));
  });
});

describe('containerOf / isRecommendedVideo', () => {
  it('format d’après l’extension', () => {
    assert.equal(containerOf('clip.MP4'), 'mp4');
    assert.equal(containerOf('clip.m4v'), 'mp4');
    assert.equal(containerOf('clip.avi'), 'avi');
    assert.equal(containerOf('clip'), 'unknown');
  });

  it('seul MP4 + H.264 est recommandé', () => {
    assert.equal(
      isRecommendedVideo({ container: 'mp4', codec: 'h264', width: 1, height: 1 }),
      true,
    );
    assert.equal(
      isRecommendedVideo({ container: 'mp4', codec: 'hevc', width: 1, height: 1 }),
      false,
    );
    assert.equal(
      isRecommendedVideo({ container: 'avi', codec: null, width: null, height: null }),
      false,
    );
    assert.equal(isRecommendedVideo(null), false);
  });
});

describe('isOversizedVideo / needsConversion', () => {
  /** @param {string | null} codec @param {number | null} width @param {number | null} height */
  const mp4 = (codec, width, height) => ({ container: 'mp4', codec, width, height });

  it('plus grande que 1920 × 1080 : trop grande ; résolution inconnue : non', () => {
    assert.equal(isOversizedVideo(mp4('h264', 3840, 2160)), true);
    assert.equal(isOversizedVideo(mp4('h264', 1440, 1440)), true);
    assert.equal(isOversizedVideo(mp4('h264', 1920, 1080)), false);
    assert.equal(isOversizedVideo(mp4('h264', null, null)), false);
    assert.equal(isOversizedVideo(null), false);
  });

  it('à convertir : autre format, ou H.264 trop grand', () => {
    assert.equal(needsConversion(mp4('h264', 1280, 720)), false);
    assert.equal(needsConversion(mp4('h264', 3840, 2160)), true);
    assert.equal(needsConversion(mp4('hevc', 1280, 720)), true);
    assert.equal(
      needsConversion({ container: 'avi', codec: null, width: null, height: null }),
      true,
    );
    assert.equal(needsConversion(null), false);
  });
});
