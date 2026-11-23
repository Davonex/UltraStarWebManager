// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { probeVideoFile } from '../../src/services/videoProbe.js';
import { H264_720P, mp4File, track } from '../helpers/mp4.js';

describe('probeVideoFile', () => {
  /** @type {string} */
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'usm-probe-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  /** @param {string} name @param {Uint8Array} data */
  async function probe(name, data) {
    const file = path.join(dir, name);
    await writeFile(file, data);
    const { modifiedAt, ...info } = await probeVideoFile(file);
    assert.equal(typeof modifiedAt, 'number'); // date de la vidéo (cache du navigateur)
    return info;
  }

  it('MP4 H.264 avec moov à la fin (après de grosses données)', async () => {
    assert.deepEqual(await probe('a.mp4', H264_720P()), {
      container: 'mp4',
      codec: 'h264',
      width: 1280,
      height: 720,
    });
  });

  it('MP4 « faststart » (moov avant les données) en HEVC', async () => {
    const data = mp4File({
      moovFirst: true,
      tracks: [track({ handler: 'vide', codec: 'hev1', width: 1920, height: 1080 })],
    });
    assert.deepEqual(await probe('b.M4V', data), {
      container: 'mp4',
      codec: 'hevc',
      width: 1920,
      height: 1080,
    });
  });

  it('autres formats : seulement le format, sans lire le fichier', async () => {
    assert.deepEqual(await probe('c.avi', Buffer.from('RIFF')), {
      container: 'avi',
      codec: null,
      width: null,
      height: null,
    });
  });

  it('« .mp4 » qui n’en est pas un, ou fichier absent : inconnu, sans exception', async () => {
    assert.equal((await probe('d.mp4', Buffer.from('pas une vidéo du tout'))).container, 'unknown');
    const absent = await probeVideoFile(path.join(dir, 'absent.mp4'));
    assert.equal(absent.codec, null);
    assert.equal(absent.modifiedAt, null);
  });
});
