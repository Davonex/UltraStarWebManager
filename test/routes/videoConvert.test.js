// @ts-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { createFakeFfmpeg } from '../helpers/fakeFfmpeg.js';
import { request } from '../helpers/httpClient.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const AVI = Buffer.from('RIFF-avi');

/** @param {NodeJS.ProcessEnv} env */
async function setup(env) {
  const library = await createSongLibrary({
    'lib/clip/a.txt': '#TITLE:T\n#ARTIST:A\n#MP3:a.mp3\n#VIDEO:clip.avi\n#BPM:300\n: 0 1 0 la\nE\n',
    'lib/clip/clip.avi': AVI,
  });
  const catalog = createCatalog({ songDir: path.join(library.root, 'lib'), logger: silentLogger });
  await catalog.load();
  const server = createApp(loadConfig({ ...env, BACKUP_DIR: path.join(library.root, 'backups') }), {
    catalog,
    facetImages: createFacetImages({ dir: null, logger: silentLogger }),
    ffmpeg: createFakeFfmpeg(),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const baseUrl = `http://127.0.0.1:${port}`;
  const song = catalog.getSongs()[0];
  const url = `/api/songs/${song.id}/convert-video`;
  return {
    library,
    song,
    /** @param {string} pathname */
    get: (pathname) => request(baseUrl, pathname),
    /** @param {unknown} body */
    post: (body) =>
      request(baseUrl, url, { method: 'POST', headers: { 'x-usm-request': '1' }, body }),
    getJob: () => request(baseUrl, url),
    /** @param {unknown} body */
    extract: (body) =>
      request(baseUrl, `/api/songs/${song.id}/extract-audio`, {
        method: 'POST',
        headers: { 'x-usm-request': '1' },
        body,
      }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await library.cleanup();
    },
  };
}

describe('POST/GET /api/songs/:id/convert-video', () => {
  it('fenêtre info : format, résolution et conversion possible', async () => {
    const app = await setup({});
    try {
      const res = await app.get(`/api/songs/${app.song.id}`);
      assert.equal(res.status, 200);
      assert.equal(typeof res.json.data.details.video.modifiedAt, 'number');
      assert.deepEqual(
        { ...res.json.data.details.video, modifiedAt: null },
        {
          container: 'avi',
          codec: 'mpeg4',
          width: 720,
          height: 576,
          modifiedAt: null,
          duration: 10,
          frameRate: 25,
          recommended: false,
          oversized: false,
          isAudio: false,
          canConvert: true,
          canExtractAudio: false,
        },
      );
      assert.ok(
        res.json.data.song.warnings.some((/** @type {any} */ w) => w.code === 'VIDEO_NOT_H264'),
      );
    } finally {
      await app.close();
    }
  });

  it('simulation (200), lancement (202), puis suivi jusqu’à la fin', async () => {
    const app = await setup({});
    try {
      const expectedModifiedAt = app.song.modifiedAt;
      const dry = await app.post({ expectedModifiedAt, dryRun: true });
      assert.equal(dry.status, 200);
      assert.deepEqual(dry.json.data.plan, {
        from: 'clip.avi',
        to: 'clip.mp4',
        replaces: false,
        keepOriginal: true,
      });
      assert.equal((await app.getJob()).json.data.job, null);

      const started = await app.post({ expectedModifiedAt });
      assert.equal(started.status, 202);
      assert.equal(started.json.data.job.state, 'running');

      // Suivi comme le fait l'interface : on relit l'état jusqu'à la fin.
      let job = started.json.data.job;
      while (job.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        job = (await app.getJob()).json.data.job;
      }
      assert.equal(job.state, 'done');
      const txt = await readFile(path.join(app.library.root, 'lib/clip/a.txt'), 'utf8');
      assert.match(txt, /#VIDEO:clip\.mp4/);
    } finally {
      await app.close();
    }
  });

  it('extraction MP3 : refusée si la musique est déjà un fichier à part (409), corps invalide (400)', async () => {
    const app = await setup({});
    try {
      const res = await app.extract({ expectedModifiedAt: app.song.modifiedAt, dryRun: true });
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, 'AUDIO_NOT_SHARED');
      assert.equal((await app.extract({ dryRun: true })).status, 400);
    } finally {
      await app.close();
    }
  });

  it('400 si le corps est invalide', async () => {
    const app = await setup({});
    try {
      for (const body of [
        {},
        { expectedModifiedAt: 'x' },
        { expectedModifiedAt: 1, dryRun: 'oui' },
      ]) {
        assert.equal((await app.post(body)).status, 400);
      }
    } finally {
      await app.close();
    }
  });

  it('lecture publique : 403, rien n’est converti', async () => {
    const app = await setup({ WRITE_KEY: 'ecriture-123456', TRUST_LOCALHOST: 'false' });
    try {
      assert.equal((await app.post({ expectedModifiedAt: app.song.modifiedAt })).status, 403);
      assert.equal((await app.getJob()).status, 403);
      assert.equal((await app.extract({ expectedModifiedAt: app.song.modifiedAt })).status, 403);
      assert.deepEqual(await readFile(path.join(app.library.root, 'lib/clip/clip.avi')), AVI);
    } finally {
      await app.close();
    }
  });
});
