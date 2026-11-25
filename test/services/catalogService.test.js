// @ts-check
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
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

  it('date d’ajout : création du dossier (ou date de modification à défaut)', async () => {
    for (const song of catalog.getSongs()) {
      const folder = await stat(path.join(library.root, song.folder));
      assert.equal(song.addedAt, folder.birthtimeMs || song.modifiedAt);
    }
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
    // Fichiers audio d'exemple vides (pas de ReplayGain) ; pochette sans « [CO] »
    assert.deepEqual(
      zen.warnings.map((w) => w.code),
      ['NAMING_COVER', 'REPLAYGAIN_MISSING'],
    );
    assert.deepEqual(zen.warnings[0].params, {
      file: 'Zazie - Zen.jpg',
      expected: 'Zazie - Zen [CO].jpg',
    });
    assert.equal(zen.replayGain, null);
    assert.equal(zen.videoGap, 0, 'sans #VIDEOGAP : 0');
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
    assert.deepEqual(
      duo.warnings.filter(
        (w) =>
          !['MISSING_HEADER', 'REPLAYGAIN_MISSING'].includes(w.code) &&
          !w.code.startsWith('NAMING_'),
      ),
      [
        {
          code: 'MISSING_FILE',
          message: 'Referenced video file not found: duo.mp4',
          params: { kind: 'video', file: 'duo.mp4' },
        },
      ],
    );
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

  it('pendant une relecture, la liste actuelle reste disponible', async () => {
    const pending = catalog.load();
    assert.equal(catalog.getStatus().state, 'ready');
    assert.equal(catalog.getSongs().length, 4);
    await pending;
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

describe('catalogService — vidéos', () => {
  it('décrit la vidéo et signale celles qui ne sont pas en MP4 H.264', async () => {
    const { H264_720P, mp4File, track } = await import('../helpers/mp4.js');
    const { songTxt } = await import('../helpers/songLibrary.js');
    const song = (/** @type {string} */ title, /** @type {string} */ video) =>
      songTxt({ TITLE: title, ARTIST: 'A', MP3: 'a.mp3', BPM: '300', VIDEO: video });
    const library = await createSongLibrary({
      'h264/a.txt': song('H264', 'v.mp4'),
      'h264/v.mp4': H264_720P(),
      'hevc/a.txt': song('HEVC', 'v.mp4'),
      'hevc/v.mp4': mp4File({
        tracks: [track({ handler: 'vide', codec: 'hvc1', width: 1920, height: 1080 })],
      }),
      '4k/a.txt': song('4K', 'v.mp4'),
      '4k/v.mp4': mp4File({
        tracks: [track({ handler: 'vide', codec: 'avc1', width: 3840, height: 2160 })],
      }),
      'avi/a.txt': song('AVI', 'v.avi'),
      'avi/v.avi': 'RIFF',
    });
    try {
      const catalog = createCatalog({ songDir: library.root, logger: silentLogger });
      await catalog.load();
      /** @param {string} title */
      const get = (title) => catalog.getSongs().find((s) => s.title === title);
      const codes = (/** @type {string} */ title) => get(title)?.warnings.map((w) => w.code);

      assert.deepEqual(
        { ...get('H264')?.video, modifiedAt: null },
        {
          container: 'mp4',
          codec: 'h264',
          width: 1280,
          height: 720,
          modifiedAt: null,
        },
      );
      assert.ok(!codes('H264')?.includes('VIDEO_NOT_H264'));

      assert.deepEqual(get('HEVC')?.warnings.find((w) => w.code === 'VIDEO_NOT_H264')?.params, {
        format: 'MP4 HEVC',
      });
      assert.equal(get('AVI')?.video?.container, 'avi');
      // 4K en H.264 : bon format, mais trop grande
      assert.ok(!codes('4K')?.includes('VIDEO_NOT_H264'));
      assert.deepEqual(get('4K')?.warnings.find((w) => w.code === 'VIDEO_TOO_LARGE')?.params, {
        width: 3840,
        height: 2160,
      });
      assert.ok(!codes('H264')?.includes('VIDEO_TOO_LARGE'));
      assert.ok(codes('AVI')?.includes('VIDEO_NOT_H264'));
    } finally {
      await library.cleanup();
    }
  });
});

describe('catalogService — vidéo qui sert aussi de musique', () => {
  it('avertissement VIDEO_IS_AUDIO quand #MP3 et #VIDEO désignent le même fichier (casse ignorée)', async () => {
    const { songTxt } = await import('../helpers/songLibrary.js');
    const library = await createSongLibrary({
      'meme/a.txt': songTxt({
        TITLE: 'Même',
        ARTIST: 'A',
        MP3: 'clip.mp4',
        VIDEO: 'CLIP.mp4',
        BPM: '300',
      }),
      'meme/clip.mp4': '',
      'separe/a.txt': songTxt({
        TITLE: 'Séparé',
        ARTIST: 'A',
        MP3: 'a.mp3',
        VIDEO: 'clip.mp4',
        BPM: '300',
      }),
      'separe/a.mp3': '',
      'separe/clip.mp4': '',
    });
    try {
      const catalog = createCatalog({ songDir: library.root, logger: silentLogger });
      await catalog.load();
      /** @param {string} title */
      const warning = (title) =>
        catalog
          .getSongs()
          .find((s) => s.title === title)
          ?.warnings.find((w) => w.code === 'VIDEO_IS_AUDIO');
      assert.deepEqual(warning('Même')?.params, { file: 'clip.mp4' });
      assert.equal(warning('Séparé'), undefined);
    } finally {
      await library.cleanup();
    }
  });
});

describe('catalogService — ReplayGain', () => {
  it('MP3 sans tag : avertissement ; MP3 tagué : valeurs ; autre format : rien', async () => {
    const { songTxt } = await import('../helpers/songLibrary.js');
    const value = '-6.50 dB';
    const head = Buffer.alloc(8);
    head.writeUInt32LE(value.length, 0);
    const items = Buffer.concat([head, Buffer.from('REPLAYGAIN_TRACK_GAIN\0'), Buffer.from(value)]);
    const footer = Buffer.alloc(32);
    footer.write('APETAGEX', 0, 'latin1');
    footer.writeUInt32LE(items.length + 32, 12);
    /** @param {string} title @param {string} audio */
    const txt = (title, audio) => songTxt({ TITLE: title, ARTIST: 'A', MP3: audio, BPM: '300' });
    const library = await createSongLibrary({
      'sans/a.txt': txt('Sans', 'a.mp3'),
      'sans/a.mp3': Buffer.alloc(500, 0xff),
      'avec/a.txt': txt('Avec', 'a.MP3'),
      'avec/a.MP3': Buffer.concat([Buffer.alloc(500, 0xff), items, footer]),
      'm4a/a.txt': txt('M4A', 'a.m4a'),
      'm4a/a.m4a': 'x',
    });
    try {
      const catalog = createCatalog({ songDir: library.root, logger: silentLogger });
      await catalog.load();
      /** @param {string} title */
      const get = (title) => catalog.getSongs().find((s) => s.title === title);
      /** @param {string} title */
      const flagged = (title) => get(title)?.warnings.some((w) => w.code === 'REPLAYGAIN_MISSING');
      assert.equal(flagged('Sans'), true);
      assert.equal(flagged('Avec'), false);
      assert.equal(get('Avec')?.replayGain?.trackGain, -6.5);
      assert.equal(flagged('M4A'), false);
    } finally {
      await library.cleanup();
    }
  });
});
