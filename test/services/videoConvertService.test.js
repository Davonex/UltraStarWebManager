// @ts-check
import assert from 'node:assert/strict';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createCatalog } from '../../src/services/catalogService.js';
import { createSongEditor } from '../../src/services/songEditService.js';
import { createVideoConverter } from '../../src/services/videoConvertService.js';
import { createFakeFfmpeg, waitFor } from '../helpers/fakeFfmpeg.js';
import { H264_720P, mp4File, track } from '../helpers/mp4.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const AVI = Buffer.from('RIFF-fausse-video-avi');
const HEVC = mp4File({
  tracks: [track({ handler: 'vide', codec: 'hvc1', width: 1920, height: 1080 })],
});
/** @param {string} video */
const txt = (video) =>
  Buffer.from(
    `#TITLE:T\r\n#ARTIST:Été\r\n#MP3:a.mp3\r\n#VIDEO:${video}\r\n#BPM:300\r\n: 0 1 0 là\r\nE\r\n`,
    'latin1',
  );

/**
 * @param {Record<string, string | Buffer>} files
 * @param {Parameters<typeof createFakeFfmpeg>[0]} [fakeOptions]
 * @param {boolean} [backupOriginal]  Préférence « sauvegarder la vidéo d'origine ».
 */
async function setup(files, fakeOptions, backupOriginal = true) {
  const library = await createSongLibrary(files);
  const songDir = path.join(library.root, 'lib');
  const backupDir = path.join(library.root, 'backups');
  const catalog = createCatalog({ songDir, logger: silentLogger });
  await catalog.load();
  const editor = createSongEditor({ catalog, backupDir, logger: silentLogger });
  const ffmpeg = createFakeFfmpeg(fakeOptions);
  const videos = createVideoConverter({
    catalog,
    editor,
    ffmpeg,
    backupDir,
    backupOriginal: () => backupOriginal,
    logger: silentLogger,
  });
  const song = catalog.getSongs()[0];
  /** @param {string} name */
  const songFile = (name) => path.join(songDir, 'clip', name);
  /** Attend la fin de la conversion lancée. */
  const finished = async () => {
    await waitFor(() => videos.getJob(song.id)?.state !== 'running');
    return videos.getJob(song.id);
  };
  return { library, catalog, videos, ffmpeg, song, songFile, backupDir, finished };
}

describe('videoConvertService', () => {
  it('AVI → MP4 : nouveau fichier, #VIDEO mis à jour, original déplacé dans les sauvegardes', async () => {
    const app = await setup({ 'lib/clip/a.txt': txt('clip.avi'), 'lib/clip/clip.avi': AVI });
    try {
      const before = await readFile(app.songFile('a.txt'));
      const { plan, job } = await app.videos.start(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
      });
      assert.deepEqual(plan, {
        from: 'clip.avi',
        to: 'clip.mp4',
        replaces: false,
        keepOriginal: true,
      });
      assert.equal(job?.state, 'running');

      const done = await app.finished();
      assert.equal(done?.state, 'done', String(done?.code));
      assert.equal(done?.progress, 1);
      assert.deepEqual((await readdir(path.join(app.library.root, 'lib/clip'))).sort(), [
        'a.txt',
        'clip.mp4',
      ]);
      assert.deepEqual(await readFile(app.songFile('clip.mp4')), H264_720P());
      // .txt : seule la ligne #VIDEO change, encodage et fins de ligne conservés
      assert.deepEqual(
        await readFile(app.songFile('a.txt')),
        Buffer.from(before.toString('latin1').replace('clip.avi', 'clip.mp4'), 'latin1'),
      );
      // Sauvegardes : la vidéo d'origine (intacte) et l'ancien .txt
      assert.ok(done?.backup);
      assert.deepEqual(
        await readFile(path.join(app.backupDir, /** @type {string} */ (done.backup))),
        AVI,
      );
      assert.equal((await readdir(path.join(app.backupDir, 'clip'))).length, 2);
      // Catalogue à jour : plus d'avertissement vidéo
      const updated = app.catalog.getSong(app.song.id);
      assert.equal(updated?.files.video, 'clip.mp4');
      assert.ok(!updated?.warnings.some((w) => w.code === 'VIDEO_NOT_H264'));
    } finally {
      await app.library.cleanup();
    }
  });

  it('MP4 HEVC → remplacé sous le même nom, .txt inchangé', async () => {
    const app = await setup({ 'lib/clip/a.txt': txt('clip.mp4'), 'lib/clip/clip.mp4': HEVC });
    try {
      const before = await readFile(app.songFile('a.txt'));
      const { plan } = await app.videos.start(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
      });
      assert.equal(plan.replaces, true);
      const done = await app.finished();
      assert.equal(done?.state, 'done');
      assert.deepEqual(await readFile(app.songFile('clip.mp4')), H264_720P());
      assert.deepEqual(await readFile(app.songFile('a.txt')), before);
      assert.deepEqual(
        await readFile(path.join(app.backupDir, /** @type {string} */ (done?.backup))),
        HEVC,
      );
    } finally {
      await app.library.cleanup();
    }
  });

  it('simulation : rien n’est lancé ni écrit', async () => {
    const app = await setup({ 'lib/clip/a.txt': txt('clip.avi'), 'lib/clip/clip.avi': AVI });
    try {
      const result = await app.videos.start(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
        dryRun: true,
      });
      assert.equal(result.job, null);
      assert.deepEqual(app.ffmpeg.calls, []);
      assert.equal(app.videos.getJob(app.song.id), null);
    } finally {
      await app.library.cleanup();
    }
  });

  it('résultat non H.264 : rien n’est remplacé, fichier temporaire supprimé', async () => {
    const app = await setup(
      { 'lib/clip/a.txt': txt('clip.avi'), 'lib/clip/clip.avi': AVI },
      { output: 'broken' },
    );
    try {
      await app.videos.start(app.song.id, { expectedModifiedAt: app.song.modifiedAt });
      const done = await app.finished();
      assert.equal(done?.state, 'error');
      assert.equal(done?.code, 'VIDEO_CONVERSION_FAILED');
      assert.deepEqual((await readdir(path.join(app.library.root, 'lib/clip'))).sort(), [
        'a.txt',
        'clip.avi',
      ]);
    } finally {
      await app.library.cleanup();
    }
  });

  it('.txt modifié pendant la conversion : la nouvelle vidéo est retirée, l’original reste', async () => {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const app = await setup(
      { 'lib/clip/a.txt': txt('clip.avi'), 'lib/clip/clip.avi': AVI },
      { gate: /** @type {Promise<void>} */ (gate) },
    );
    try {
      await app.videos.start(app.song.id, { expectedModifiedAt: app.song.modifiedAt });
      // Une seule conversion à la fois
      await assert.rejects(
        app.videos.start(app.song.id, { expectedModifiedAt: app.song.modifiedAt }),
        {
          code: 'CONVERSION_BUSY',
        },
      );
      await writeFile(app.songFile('a.txt'), Buffer.concat([txt('clip.avi'), Buffer.from('\r\n')]));
      release();
      const done = await app.finished();
      assert.equal(done?.code, 'SONG_CHANGED');
      assert.deepEqual((await readdir(path.join(app.library.root, 'lib/clip'))).sort(), [
        'a.txt',
        'clip.avi',
      ]);
      assert.deepEqual(await readFile(app.songFile('clip.avi')), AVI);
    } finally {
      await app.library.cleanup();
    }
  });

  it('refus : déjà en H.264, cible existante, .txt modifié, ffmpeg absent', async () => {
    const ok = await setup({ 'lib/clip/a.txt': txt('clip.mp4'), 'lib/clip/clip.mp4': H264_720P() });
    try {
      await assert.rejects(
        ok.videos.start(ok.song.id, { expectedModifiedAt: ok.song.modifiedAt }),
        {
          code: 'VIDEO_ALREADY_H264',
        },
      );
    } finally {
      await ok.library.cleanup();
    }

    const both = await setup({
      'lib/clip/a.txt': txt('clip.avi'),
      'lib/clip/clip.avi': AVI,
      'lib/clip/clip.mp4': 'déjà là',
    });
    try {
      await assert.rejects(
        both.videos.start(both.song.id, { expectedModifiedAt: both.song.modifiedAt }),
        {
          code: 'VIDEO_TARGET_EXISTS',
        },
      );
      await assert.rejects(both.videos.start(both.song.id, { expectedModifiedAt: 1 }), {
        code: 'VIDEO_TARGET_EXISTS',
      });
    } finally {
      await both.library.cleanup();
    }

    const off = await setup(
      { 'lib/clip/a.txt': txt('clip.avi'), 'lib/clip/clip.avi': AVI },
      { available: false },
    );
    try {
      await assert.rejects(off.videos.start(off.song.id, { expectedModifiedAt: 1 }), {
        code: 'SONG_CHANGED',
      });
      await assert.rejects(
        off.videos.start(off.song.id, { expectedModifiedAt: off.song.modifiedAt }),
        {
          code: 'FFMPEG_NOT_AVAILABLE',
        },
      );
      // Simulation possible sans ffmpeg, mais la fenêtre info sait qu'on ne peut pas convertir
      const details = await off.videos.describe(off.song);
      assert.equal(details?.canConvert, false);
      assert.equal(details?.container, 'avi');
      assert.ok((await stat(off.songFile('clip.avi'))).isFile());
    } finally {
      await off.library.cleanup();
    }
  });
});

describe('videoConvertService — vidéo qui sert aussi de musique', () => {
  it('#MP3 et #VIDEO sur le même fichier : listée, jamais convertie, fichier intact', async () => {
    const MPEG4 = mp4File({
      tracks: [track({ handler: 'vide', codec: 'mp4v', width: 640, height: 480 })],
    });
    const song = Buffer.from(
      '#TITLE:T\n#ARTIST:A\n#MP3:clip.mp4\n#VIDEO:clip.mp4\n#BPM:300\n: 0 1 0 la\nE\n',
    );
    const app = await setup({ 'lib/clip/a.txt': song, 'lib/clip/clip.mp4': MPEG4 });
    try {
      // Fenêtre info : pas de conversion possible, avec la raison
      const details = await app.videos.describe(app.song);
      assert.equal(details?.isAudio, true);
      assert.equal(details?.canConvert, false);
      // Conversion à la demande : refusée, même en simulation
      for (const dryRun of [true, false]) {
        await assert.rejects(
          app.videos.start(app.song.id, { expectedModifiedAt: app.song.modifiedAt, dryRun }),
          { code: 'VIDEO_IS_AUDIO' },
        );
      }
      // En masse : listée avec l'indication, et refusée si on l'envoie quand même
      const { items } = await app.videos.listCandidates();
      assert.deepEqual(
        items.map((i) => i.isAudio),
        [true],
      );
      await app.videos.startBatch([{ id: app.song.id, expectedModifiedAt: app.song.modifiedAt }]);
      await waitFor(() => app.videos.getBatch()?.state !== 'running');
      assert.equal(app.videos.getBatch()?.items[0].code, 'VIDEO_IS_AUDIO');
      assert.deepEqual(app.ffmpeg.calls, []);
      assert.deepEqual(await readFile(app.songFile('clip.mp4')), MPEG4);
    } finally {
      await app.library.cleanup();
    }
  });
});

describe('videoConvertService — vidéo plus grande que 1080p', () => {
  it('MP4 H.264 en 4K : proposée à la conversion (même nom), réduite par ffmpeg', async () => {
    const UHD = mp4File({
      tracks: [track({ handler: 'vide', codec: 'avc1', width: 3840, height: 2160 })],
    });
    const app = await setup({ 'lib/clip/a.txt': txt('clip.mp4'), 'lib/clip/clip.mp4': UHD });
    try {
      const details = await app.videos.describe(app.song);
      assert.equal(details?.recommended, true); // le format est bon…
      assert.equal(details?.oversized, true); // … mais la taille non
      assert.equal(details?.canConvert, true);
      const { items } = await app.videos.listCandidates();
      assert.deepEqual(
        items.map((i) => i.oversized),
        [true],
      );
      const { plan } = await app.videos.start(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
      });
      assert.equal(plan.replaces, true);
      assert.equal((await app.finished())?.state, 'done');
      assert.deepEqual(await readFile(app.songFile('clip.mp4')), H264_720P());
    } finally {
      await app.library.cleanup();
    }
  });
});

describe('videoConvertService — sauvegarde de l’original désactivée (préférences)', () => {
  it('AVI → MP4 : l’original est supprimé sans copie dans les sauvegardes', async () => {
    const app = await setup(
      { 'lib/clip/a.txt': txt('clip.avi'), 'lib/clip/clip.avi': AVI },
      undefined,
      false,
    );
    try {
      const { plan } = await app.videos.start(app.song.id, {
        expectedModifiedAt: app.song.modifiedAt,
      });
      assert.equal(plan.keepOriginal, false);
      const done = await app.finished();
      assert.equal(done?.state, 'done');
      assert.equal(done?.backup, null);
      assert.deepEqual((await readdir(path.join(app.library.root, 'lib/clip'))).sort(), [
        'a.txt',
        'clip.mp4',
      ]);
      // Seule la sauvegarde du .txt existe (toujours faite)
      assert.deepEqual(
        (await readdir(path.join(app.backupDir, 'clip'))).map((f) => path.extname(f)),
        ['.txt'],
      );
    } finally {
      await app.library.cleanup();
    }
  });
});
