// @ts-check
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseUltrastarTxt } from '../../src/parsers/ultrastarTxt.js';
import { createCatalog, previewOf } from '../../src/services/catalogService.js';
import { createSongLibrary, SAMPLE_LIBRARY } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };

describe('catalogService', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let library;
  /** @type {import('../../src/services/catalogService.js').Catalog} */
  let catalog;

  before(async () => {
    library = await createSongLibrary(SAMPLE_LIBRARY);
    catalog = createCatalog({ songDir: library.root, logger: silentLogger });
    await catalog.load();
  });

  after(() => library.cleanup());

  /** @param {string} title */
  const byTitle = (title) => catalog.getSongs().find((song) => song.title === title);

  it('charge les chansons et ignore les fichiers non UltraStar et cachés', () => {
    const status = catalog.getStatus();
    assert.equal(status.state, 'ready');
    assert.equal(status.count, 4);
    assert.deepEqual(
      status.skipped.map((s) => s.path),
      ['Duo - Test/readme.txt'],
    );
    assert.equal(byTitle('Cachée'), undefined);
  });

  it('trie par artiste puis titre, sans tenir compte des accents', () => {
    assert.deepEqual(
      catalog.getSongs().map((s) => `${s.artist} / ${s.title}`),
      ['Duo / Test', 'Duo / Test (instru)', "Édith Piaf / L'hymne à l'amour", 'Zazie / Zen'],
    );
  });

  it('expose les métadonnées normalisées', () => {
    const zen = byTitle('Zen');
    assert.ok(zen);
    assert.equal(zen.folder, 'Zazie - Zen');
    assert.equal(zen.txtFile, 'Zazie - Zen.txt');
    assert.equal(zen.year, 1995);
    assert.equal(zen.decade, 1990);
    assert.deepEqual(zen.genres, ['Pop', 'Variété']);
    assert.deepEqual(zen.languages, ['French']);
    assert.deepEqual(zen.files, {
      audio: 'Zazie - Zen.mp3',
      cover: 'Zazie - Zen.jpg',
      background: null,
      video: null,
    });
    assert.deepEqual(zen.warnings, []);
  });

  it('retrouve les fichiers malgré la casse et devine la pochette [CO]', () => {
    const piaf = byTitle("L'hymne à l'amour");
    assert.ok(piaf);
    assert.equal(piaf.encoding, 'windows-1252');
    assert.equal(piaf.folder, 'Francais/Édith Piaf - Hymne');
    assert.equal(piaf.files.audio, 'piaf.mp3');
    assert.equal(piaf.files.cover, 'piaf [CO].jpg');
    assert.equal(piaf.coverGuessed, true);
  });

  it('détecte le duo et signale un fichier référencé absent', () => {
    const duo = byTitle('Test');
    assert.ok(duo);
    assert.equal(duo.isDuet, true);
    assert.equal(duo.files.video, null);
    assert.deepEqual(duo.warnings, [
      {
        code: 'MISSING_FILE',
        message: 'Referenced video file not found: duo.mp4',
        params: { kind: 'video', file: 'duo.mp4' },
      },
    ]);
  });

  it('donne des identifiants uniques et stables d’un scan à l’autre', async () => {
    const before = catalog.getSongs().map((s) => s.id);
    assert.equal(new Set(before).size, before.length);
    await catalog.load();
    assert.deepEqual(
      catalog.getSongs().map((s) => s.id),
      before,
    );
    assert.equal(catalog.getSong(before[0])?.id, before[0]);
  });

  it('partage un même scan entre appels simultanés', () => {
    assert.equal(catalog.load(), catalog.load());
  });
});

describe('catalogService — cas d’erreur', () => {
  it('non configuré sans SONG_DIR', async () => {
    const catalog = createCatalog({ songDir: null, logger: silentLogger });
    await catalog.load();
    assert.equal(catalog.getStatus().state, 'not-configured');
  });

  it('état « error » si le dossier n’existe pas', async () => {
    const catalog = createCatalog({
      songDir: path.join(process.cwd(), 'dossier-qui-n-existe-pas'),
      logger: silentLogger,
    });
    await catalog.load();
    assert.equal(catalog.getStatus().state, 'error');
    assert.equal(catalog.getSongs().length, 0);
  });
});

describe('previewOf — début de la preview', () => {
  /** @param {string} headers */
  const meta = (headers) => parseUltrastarTxt(`${headers}\n: 0 1 0 la\nE\n`).meta;

  it('utilise #PREVIEWSTART en priorité', () => {
    assert.deepEqual(previewOf(meta('#BPM:300\n#PREVIEWSTART:45,5\n#MEDLEYSTARTBEAT:200')), {
      previewStart: 45.5,
      previewSource: 'tag',
    });
  });

  it('sinon calcule le début du medley', () => {
    assert.deepEqual(previewOf(meta('#BPM:300\n#GAP:2000\n#MEDLEYSTARTBEAT:200')), {
      previewStart: 12,
      previewSource: 'medley',
    });
  });

  it('sinon null (le lecteur choisit)', () => {
    assert.deepEqual(previewOf(meta('#BPM:300')), { previewStart: null, previewSource: null });
  });
});
