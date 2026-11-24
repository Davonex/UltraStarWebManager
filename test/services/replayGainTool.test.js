// @ts-check
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { id3TagSize } from '../../src/parsers/replayGain.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createReplayGainTool } from '../../src/services/replayGainService.js';
import { createFakeFfmpeg } from '../helpers/fakeFfmpeg.js';
import { createSongLibrary, songTxt } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
// « Audio » : trames MP3 factices + tag ID3v1 en fin de fichier (doivent rester intacts).
const AUDIO = Buffer.concat([
  Buffer.alloc(3000, 0xfb),
  Buffer.from('TAG'),
  Buffer.alloc(125, 0x41),
]);

/**
 * @param {Buffer} mp3
 * @param {Parameters<typeof createFakeFfmpeg>[0]} [fake]
 */
async function setup(mp3, fake) {
  const library = await createSongLibrary({
    'lib/s/a.txt': songTxt({ TITLE: 'T', ARTIST: 'A', MP3: 'a.mp3', BPM: '300' }),
    'lib/s/a.mp3': mp3,
  });
  const catalog = createCatalog({ songDir: path.join(library.root, 'lib'), logger: silentLogger });
  await catalog.load();
  const backupDir = path.join(library.root, 'backups');
  const tool = createReplayGainTool({
    catalog,
    ffmpeg: createFakeFfmpeg(fake),
    backupDir,
    logger: silentLogger,
  });
  const song = catalog.getSongs()[0];
  const file = path.join(library.root, 'lib/s/a.mp3');
  return { library, catalog, tool, song, file, backupDir };
}

describe('createReplayGainTool', () => {
  it('mesure, puis écrit le tag ID3 : audio identique, sauvegarde, avertissement levé', async () => {
    const app = await setup(AUDIO);
    try {
      assert.ok(app.song.warnings.some((w) => w.code === 'REPLAYGAIN_MISSING'));
      const measured = await app.tool.measure(app.song.id);
      assert.equal(measured.trackGain, -2.54);
      assert.deepEqual(await readFile(app.file), AUDIO, 'la mesure n’écrit rien');

      const { song, backup } = await app.tool.write(app.song.id, {
        trackGain: measured.trackGain,
        trackPeak: measured.trackPeak,
        expectedAudioModifiedAt: measured.audioModifiedAt,
      });
      const data = await readFile(app.file);
      const tagSize = id3TagSize(data);
      assert.ok(tagSize > 0);
      assert.deepEqual(data.subarray(tagSize), AUDIO, 'données audio recopiées octet pour octet');
      assert.deepEqual(await readFile(path.join(app.backupDir, backup)), AUDIO);
      assert.equal(song.replayGain?.trackGain, -2.54);
      assert.ok(!song.warnings.some((w) => w.code === 'REPLAYGAIN_MISSING'));
    } finally {
      await app.library.cleanup();
    }
  });

  it('refus : fichier modifié depuis la mesure, valeurs aberrantes, ffmpeg en échec', async () => {
    const app = await setup(AUDIO);
    try {
      const measured = await app.tool.measure(app.song.id);
      await assert.rejects(
        app.tool.write(app.song.id, {
          trackGain: 99,
          trackPeak: 1,
          expectedAudioModifiedAt: measured.audioModifiedAt,
        }),
        { code: 'INVALID_VALUE' },
      );
      await writeFile(app.file, Buffer.concat([AUDIO, Buffer.from('x')]));
      await assert.rejects(
        app.tool.write(app.song.id, {
          ...measured,
          expectedAudioModifiedAt: measured.audioModifiedAt - 5000,
        }),
        { code: 'SONG_CHANGED' },
      );
      assert.deepEqual(await readdir(app.library.root).then((d) => d.includes('backups')), false);
    } finally {
      await app.library.cleanup();
    }
    const broken = await setup(AUDIO, { output: 'broken' });
    try {
      await assert.rejects(broken.tool.measure(broken.song.id), { code: 'REPLAYGAIN_FAILED' });
    } finally {
      await broken.library.cleanup();
    }
  });
});
