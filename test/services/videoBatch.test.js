// @ts-check
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
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

describe('vidéo partagée par plusieurs .txt du même dossier (solo + duo)', () => {
  /** @param {Record<string, string | Buffer>} files */
  async function setupShared(files) {
    const library = await createSongLibrary(files);
    const songDir = path.join(library.root, 'lib');
    const backupDir = path.join(library.root, 'backups');
    const catalog = createCatalog({ songDir, logger: silentLogger });
    await catalog.load();
    const editor = createSongEditor({ catalog, backupDir, logger: silentLogger });
    const ffmpeg = createFakeFfmpeg();
    const videos = createVideoConverter({
      catalog,
      editor,
      ffmpeg,
      backupDir,
      logger: silentLogger,
    });
    /** @param {string} name */
    const read = (name) => readFile(path.join(songDir, 'duo', name), 'utf8');
    const missing = () =>
      catalog.getSongs().filter((s) => s.warnings.some((w) => w.code === 'MISSING_FILE'));
    return { library, catalog, videos, ffmpeg, read, missing, songDir };
  }

  it('conversion du solo : le .txt duo pointe aussi vers le MP4, aucun fichier introuvable', async () => {
    const app = await setupShared({
      'lib/duo/solo.txt': txt('Solo', 'v.avi'),
      'lib/duo/duo.txt': txt('Duo', 'v.avi'),
      'lib/duo/v.avi': 'AVI',
      'lib/duo/a.mp3': 'MP3',
    });
    try {
      const solo = app.catalog.getSongs().find((s) => s.title === 'Solo');
      assert.ok(solo);
      await app.videos.start(solo.id, { expectedModifiedAt: solo.modifiedAt });
      await waitFor(() => app.videos.getJob(solo.id)?.state !== 'running');
      assert.equal(app.videos.getJob(solo.id)?.state, 'done');
      assert.match(await app.read('solo.txt'), /#VIDEO:v\.mp4\n/);
      assert.match(await app.read('duo.txt'), /#VIDEO:v\.mp4\n/);
      assert.deepEqual((await readdir(path.join(app.songDir, 'duo'))).sort(), [
        'a.mp3',
        'duo.txt',
        'solo.txt',
        'v.mp4',
      ]);
      assert.deepEqual(app.missing(), []);
    } finally {
      await app.library.cleanup();
    }
  });

  it('l’autre .txt utilise la vidéo comme musique : l’original est gardé', async () => {
    const app = await setupShared({
      'lib/duo/solo.txt': txt('Solo', 'v.avi'),
      'lib/duo/duo.txt':
        '#TITLE:Duo\n#ARTIST:A\n#MP3:v.avi\n#VIDEO:v.avi\n#BPM:300\n: 0 1 0 la\nE\n',
      'lib/duo/v.avi': 'AVI',
      'lib/duo/a.mp3': 'MP3',
    });
    try {
      const solo = app.catalog.getSongs().find((s) => s.title === 'Solo');
      assert.ok(solo);
      await app.videos.start(solo.id, { expectedModifiedAt: solo.modifiedAt });
      await waitFor(() => app.videos.getJob(solo.id)?.state !== 'running');
      assert.match(await app.read('duo.txt'), /#MP3:v\.avi\n#VIDEO:v\.mp4\n/);
      assert.ok((await readdir(path.join(app.songDir, 'duo'))).includes('v.avi'));
      assert.deepEqual(app.missing(), []);
    } finally {
      await app.library.cleanup();
    }
  });

  it('lot avec le solo et le duo : une seule conversion, les deux traités', async () => {
    const app = await setupShared({
      'lib/duo/solo.txt': txt('Solo', 'v.avi'),
      'lib/duo/duo.txt': txt('Duo', 'v.avi'),
      'lib/duo/v.avi': 'AVI',
      'lib/duo/a.mp3': 'MP3',
    });
    try {
      const { items } = await app.videos.listCandidates();
      assert.equal(items.length, 2);
      await app.videos.startBatch(
        items.map((i) => ({ id: i.id, expectedModifiedAt: i.modifiedAt })),
      );
      await waitFor(() => app.videos.getBatch()?.state !== 'running');
      assert.deepEqual(
        app.videos.getBatch()?.items.map((i) => i.status),
        ['converted', 'converted'],
      );
      assert.equal(app.ffmpeg.calls.filter((c) => c.endsWith('v.avi')).length, 1);
      assert.deepEqual(app.missing(), []);
    } finally {
      await app.library.cleanup();
    }
  });
});
