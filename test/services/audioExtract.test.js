// @ts-check
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createCatalog } from '../../src/services/catalogService.js';
import { createSongEditor } from '../../src/services/songEditService.js';
import { createVideoConverter } from '../../src/services/videoConvertService.js';
import { createFakeFfmpeg, FAKE_MP3 } from '../helpers/fakeFfmpeg.js';
import { H264_720P } from '../helpers/mp4.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * @param {string} headers  En-têtes audio/vidéo du .txt.
 * @param {Parameters<typeof createFakeFfmpeg>[0]} [fakeOptions]
 * @param {Record<string, string | Buffer>} [extra]
 */
async function setup(headers, fakeOptions, extra = {}) {
  const txt = Buffer.from(
    `#TITLE:Tonight\r\n#ARTIST:Été\r\n${headers}#BPM:300\r\n: 0 1 0 là\r\nE\r\n`,
    'latin1',
  );
  const library = await createSongLibrary({
    'lib/ws/a.txt': txt,
    'lib/ws/clip.mp4': H264_720P(),
    ...extra,
  });
  const songDir = path.join(library.root, 'lib');
  const backupDir = path.join(library.root, 'backups');
  const catalog = createCatalog({ songDir, logger: silentLogger });
  await catalog.load();
  const editor = createSongEditor({ catalog, backupDir, logger: silentLogger });
  const ffmpeg = createFakeFfmpeg(fakeOptions);
  const videos = createVideoConverter({ catalog, editor, ffmpeg, backupDir, logger: silentLogger });
  const song = catalog.getSongs()[0];
  /** @param {string} name */
  const file = (name) => path.join(songDir, 'ws', name);
  return { library, catalog, videos, ffmpeg, song, file, txt };
}

describe('extraction du MP3 (vidéo qui sert aussi de musique)', () => {
  it('crée clip.mp3 et met à jour #MP3 ; vidéo intacte, avertissement levé', async () => {
    const app = await setup('#MP3:clip.mp4\r\n#VIDEO:clip.mp4\r\n');
    try {
      const details = await app.videos.describe(app.song);
      assert.equal(details?.canExtractAudio, true);

      const dry = await app.videos.extractAudio(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
        dryRun: true,
      });
      assert.deepEqual(dry.plan, { from: 'clip.mp4', to: 'clip.mp3', reuse: false });
      assert.deepEqual(app.ffmpeg.calls, []);

      const result = await app.videos.extractAudio(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
      });
      assert.deepEqual(result.headers, ['MP3']);
      assert.ok(result.backup);
      assert.deepEqual(await readFile(app.file('clip.mp3')), FAKE_MP3);
      assert.deepEqual(await readFile(app.file('clip.mp4')), H264_720P());
      // .txt : seule la ligne #MP3 change (encodage Windows-1252 et CRLF conservés)
      assert.deepEqual(
        await readFile(app.file('a.txt')),
        Buffer.from(app.txt.toString('latin1').replace('#MP3:clip.mp4', '#MP3:clip.mp3'), 'latin1'),
      );
      const updated = app.catalog.getSong(app.song.id);
      assert.equal(updated?.files.audio, 'clip.mp3');
      assert.ok(!updated?.warnings.some((w) => w.code === 'VIDEO_IS_AUDIO'));
    } finally {
      await app.library.cleanup();
    }
  });

  it('format 1.1.0 avec #AUDIO et #MP3 : les deux sont mis à jour', async () => {
    const app = await setup('#AUDIO:clip.mp4\r\n#MP3:clip.mp4\r\n#VIDEO:clip.mp4\r\n');
    try {
      const result = await app.videos.extractAudio(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
      });
      assert.deepEqual(result.headers, ['AUDIO', 'MP3']);
      const text = (await readFile(app.file('a.txt'))).toString('latin1');
      assert.match(text, /#AUDIO:clip\.mp3\r\n#MP3:clip\.mp3\r\n#VIDEO:clip\.mp4/);
    } finally {
      await app.library.cleanup();
    }
  });

  it('refus : fichiers séparés, .txt modifié ; échec : rien ne change', async () => {
    const separate = await setup('#MP3:a.mp3\r\n#VIDEO:clip.mp4\r\n', undefined, {
      'lib/ws/a.mp3': 'x',
    });
    try {
      await assert.rejects(
        separate.videos.extractAudio(separate.song.id, {
          expectedModifiedAt: separate.song.modifiedAt,
        }),
        { code: 'AUDIO_NOT_SHARED' },
      );
    } finally {
      await separate.library.cleanup();
    }

    const broken = await setup('#MP3:clip.mp4\r\n#VIDEO:clip.mp4\r\n', { output: 'broken' });
    try {
      await assert.rejects(broken.videos.extractAudio(broken.song.id, { expectedModifiedAt: 1 }), {
        code: 'SONG_CHANGED',
      });
      await assert.rejects(
        broken.videos.extractAudio(broken.song.id, { expectedModifiedAt: broken.song.modifiedAt }),
        { code: 'AUDIO_EXTRACTION_FAILED' },
      );
      assert.deepEqual((await readdir(path.join(broken.library.root, 'lib/ws'))).sort(), [
        'a.txt',
        'clip.mp4',
      ]);
      assert.deepEqual(await readFile(broken.file('a.txt')), broken.txt);
    } finally {
      await broken.library.cleanup();
    }
  });

  it('MP3 déjà présent (créé pour l’autre version du dossier) : réutilisé, sans ffmpeg', async () => {
    const app = await setup('#MP3:clip.mp4\r\n#VIDEO:clip.mp4\r\n', undefined, {
      'lib/ws/clip.mp3': 'déjà là',
    });
    try {
      const dry = await app.videos.extractAudio(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
        dryRun: true,
      });
      assert.equal(dry.plan.reuse, true);
      const result = await app.videos.extractAudio(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
      });
      assert.deepEqual(result.headers, ['MP3']);
      assert.deepEqual(app.ffmpeg.calls, []);
      assert.equal(await readFile(app.file('clip.mp3'), 'utf8'), 'déjà là');
      assert.equal(app.catalog.getSong(app.song.id)?.files.audio, 'clip.mp3');
    } finally {
      await app.library.cleanup();
    }
  });

  it('.txt modifié pendant l’extraction : le MP3 créé est retiré', async () => {
    /** @type {() => void} */
    let release = () => {};
    const gate = /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        release = () => resolve();
      })
    );
    const app = await setup('#MP3:clip.mp4\r\n#VIDEO:clip.mp4\r\n', { gate });
    try {
      const running = app.videos.extractAudio(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await writeFile(app.file('a.txt'), Buffer.concat([app.txt, Buffer.from('\r\n')]));
      release();
      await assert.rejects(running, { code: 'SONG_CHANGED' });
      assert.deepEqual((await readdir(path.join(app.library.root, 'lib/ws'))).sort(), [
        'a.txt',
        'clip.mp4',
      ]);
    } finally {
      await app.library.cleanup();
    }
  });
});
