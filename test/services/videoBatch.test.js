// @ts-check
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createCatalog } from '../../src/services/catalogService.js';
import { createSongEditor } from '../../src/services/songEditService.js';
import { createVideoConverter } from '../../src/services/videoConvertService.js';
import { createFakeFfmpeg, waitFor } from '../helpers/fakeFfmpeg.js';
import { H264_720P } from '../helpers/mp4.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
/** @param {string} title @param {string} video */
const txt = (title, video) =>
  `#TITLE:${title}\n#ARTIST:A\n#MP3:a.mp3\n#VIDEO:${video}\n#BPM:300\n: 0 1 0 la\nE\n`;

/** @param {Parameters<typeof createFakeFfmpeg>[0]} [fakeOptions] */
async function setup(fakeOptions) {
  const library = await createSongLibrary({
    'lib/un/a.txt': txt('Un', 'v.avi'),
    'lib/un/v.avi': 'AVI-1',
    'lib/deux/a.txt': txt('Deux', 'v.avi'),
    'lib/deux/v.avi': 'AVI-22',
    'lib/trois/a.txt': txt('Trois', 'v.avi'),
    'lib/trois/v.avi': 'AVI-333',
    'lib/ok/a.txt': txt('Ok', 'v.mp4'),
    'lib/ok/v.mp4': H264_720P(),
  });
  const songDir = path.join(library.root, 'lib');
  const backupDir = path.join(library.root, 'backups');
  const catalog = createCatalog({ songDir, logger: silentLogger });
  await catalog.load();
  const editor = createSongEditor({ catalog, backupDir, logger: silentLogger });
  const videos = createVideoConverter({
    catalog,
    editor,
    ffmpeg: createFakeFfmpeg(fakeOptions),
    backupDir,
    logger: silentLogger,
  });
  const { items } = await videos.listCandidates();
  const request = items.map((i) => ({ id: i.id, expectedModifiedAt: i.modifiedAt }));
  const finished = () => waitFor(() => videos.getBatch()?.state !== 'running');
  /** @param {string} folder */
  const filesOf = (folder) => readdir(path.join(songDir, folder)).then((f) => f.sort());
  return { library, songDir, catalog, videos, items, request, finished, filesOf };
}

describe('videoConvertService — lots', () => {
  it('simulation : seulement les vidéos non H.264, avec leur taille', async () => {
    const app = await setup();
    try {
      const { available, items } = await app.videos.listCandidates();
      assert.equal(available, true);
      assert.deepEqual(items.map((i) => `${i.title}:${i.container}:${i.size}`).sort(), [
        'Deux:avi:6',
        'Trois:avi:7',
        'Un:avi:5',
      ]);
    } finally {
      await app.library.cleanup();
    }
  });

  it('convertit le lot vidéo après vidéo, une erreur n’arrête pas la suite', async () => {
    const app = await setup();
    try {
      // « Deux » modifié après la simulation : refusé, les autres continuent.
      const deux = app.items.find((i) => i.title === 'Deux');
      await writeFile(path.join(app.songDir, 'deux/a.txt'), `${txt('Deux', 'v.avi')}\n`);
      const started = await app.videos.startBatch(app.request);
      assert.equal(started.state, 'running');
      assert.ok(!('expectedModifiedAt' in started.items[0]), 'donnée interne non exposée');
      await app.finished();

      const batch = app.videos.getBatch();
      assert.equal(batch?.state, 'done');
      const byTitle = Object.fromEntries((batch?.items ?? []).map((i) => [i.title, i]));
      assert.equal(byTitle.Un.status, 'converted');
      assert.equal(byTitle.Trois.status, 'converted');
      assert.equal(byTitle.Deux.status, 'error');
      assert.equal(byTitle.Deux.code, 'SONG_CHANGED');
      assert.deepEqual(await app.filesOf('un'), ['a.txt', 'v.mp4']);
      assert.deepEqual(await app.filesOf('deux'), ['a.txt', 'v.avi']);
      assert.ok(deux);
    } finally {
      await app.library.cleanup();
    }
  });

  it('arrêt demandé : la vidéo en cours se termine, les suivantes sont ignorées', async () => {
    /** @type {() => void} */
    let release = () => {};
    const gate = /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        release = () => resolve();
      })
    );
    const app = await setup({ gate });
    try {
      await app.videos.startBatch(app.request);
      await waitFor(() => app.videos.getBatch()?.items[0].status === 'running');
      // Pendant un lot, aucune autre conversion ne peut démarrer
      await assert.rejects(app.videos.startBatch(app.request), { code: 'CONVERSION_BUSY' });
      const first = app.items[0];
      await assert.rejects(app.videos.start(first.id, { expectedModifiedAt: first.modifiedAt }), {
        code: 'CONVERSION_BUSY',
      });
      // Progression de la vidéo en cours (5 s sur 10 annoncées par le faux ffmpeg)
      assert.equal(app.videos.getBatch()?.items[0].progress, 0.5);

      assert.equal(app.videos.stopBatch()?.stopRequested, true);
      release();
      await app.finished();
      const batch = app.videos.getBatch();
      assert.equal(batch?.state, 'stopped');
      assert.deepEqual(
        batch?.items.map((i) => i.status),
        ['converted', 'skipped', 'skipped'],
      );
    } finally {
      await app.library.cleanup();
    }
  });

  it('ffmpeg absent : refus, rien ne démarre', async () => {
    const app = await setup({ available: false });
    try {
      assert.equal((await app.videos.listCandidates()).available, false);
      await assert.rejects(app.videos.startBatch(app.request), { code: 'FFMPEG_NOT_AVAILABLE' });
      assert.equal(app.videos.getBatch(), null);
    } finally {
      await app.library.cleanup();
    }
  });
});
