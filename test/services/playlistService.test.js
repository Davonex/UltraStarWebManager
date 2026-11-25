// @ts-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createCatalog } from '../../src/services/catalogService.js';
import {
  createPlaylists,
  indexSongs,
  matchEntries,
  songMatchKey,
} from '../../src/services/playlistService.js';
import { createSongLibrary, SAMPLE_LIBRARY } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/** @param {string} name @param {string[]} lines */
const upl = (name, lines) =>
  ['#Ultrastar Deluxe Playlist Format v1.0', `#Name: ${name}`, '#Songs:', ...lines, ''].join(
    '\r\n',
  );

describe('songMatchKey / matchEntries', () => {
  it('rapproche sans tenir compte de la casse, des accents ni des espaces', () => {
    assert.equal(songMatchKey('Édith  Piaf', "L'Hymne"), songMatchKey('edith piaf', "l'hymne"));
    assert.notEqual(songMatchKey('A', 'B'), songMatchKey('B', 'A'));
  });

  it('garde l’ordre, toutes les versions d’une chanson et les lignes introuvables', () => {
    const index = indexSongs(
      /** @type {any[]} */ ([
        { id: '1', artist: 'Zazie', title: 'Zen' },
        { id: '2', artist: 'Duo', title: 'Test' },
        { id: '3', artist: 'DUO', title: 'test' },
      ]),
    );
    const result = matchEntries(
      [
        { artist: 'duo', title: 'Test' },
        { artist: 'Inconnu', title: 'X' },
        { artist: 'Zazie', title: 'Zen' },
        { artist: 'Zazie', title: 'Zen' },
      ],
      index,
    );
    assert.deepEqual(result.songIds, ['2', '3', '1']);
    assert.deepEqual(result.missing, [{ artist: 'Inconnu', title: 'X' }]);
  });
});

describe('createPlaylists', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let dir;
  /** @type {import('../../src/services/catalogService.js').Catalog} */
  let catalog;

  before(async () => {
    const songs = Object.fromEntries(
      Object.entries(SAMPLE_LIBRARY).map(([file, content]) => [`songs/${file}`, content]),
    );
    dir = await createSongLibrary({
      ...songs,
      'playlists/top.upl': upl('Top', ['Zazie : Zen', 'Edith Piaf : L’inconnue']),
      // Windows-1252, sans #Name : le nom du fichier sert de nom
      'playlists/Piaf.UPL': Buffer.from("Édith Piaf : L'hymne à l'amour\r\n", 'latin1'),
      'playlists/doublon.upl': upl('top', ['Duo : Test']),
      'playlists/notes.txt': 'Zazie : Zen\n',
    });
    catalog = createCatalog({ songDir: path.join(dir.root, 'songs'), logger: silentLogger });
    await catalog.load();
  });
  after(() => dir.cleanup());

  /** @param {string} title */
  const idOf = (title) => catalog.getSongs().find((s) => s.title === title)?.id;

  it('lit les .upl du dossier, relie les chansons et trie par nom', async () => {
    const playlists = createPlaylists({
      playlistDir: path.join(dir.root, 'playlists'),
      catalog,
      logger: silentLogger,
    });
    const list = await playlists.list();
    assert.deepEqual(
      list.map((p) => [p.name, p.file]),
      [
        ['Piaf', 'Piaf.UPL'],
        ['top', 'doublon.upl'],
        ['Top (top.upl)', 'top.upl'],
      ],
    );
    const [piaf, doublon, top] = list;
    assert.deepEqual(piaf.songIds, [idOf("L'hymne à l'amour")]);
    assert.deepEqual(doublon.songIds, [idOf('Test')]);
    assert.deepEqual(top.songIds, [idOf('Zen')]);
    assert.deepEqual(top.missing, [{ artist: 'Edith Piaf', title: 'L’inconnue' }]);
    assert.equal(playlists.isConfigured(), true);
  });

  it('dossier non configuré ou introuvable : liste vide', async () => {
    const none = createPlaylists({ playlistDir: null, catalog, logger: silentLogger });
    assert.deepEqual(await none.list(), []);
    assert.equal(none.isConfigured(), false);
    const absent = createPlaylists({
      playlistDir: path.join(dir.root, 'absent'),
      catalog,
      logger: silentLogger,
    });
    assert.deepEqual(await absent.list(), []);
  });
});

describe('createPlaylists — renommage d’une chanson dans les playlists', () => {
  it('lignes renommées (encodage et fins de ligne gardés, sauvegarde), autres fichiers intacts', async () => {
    const dir = await createSongLibrary({
      'songs/a/a.txt': '#TITLE:Zen\n#ARTIST:Zazie\n#MP3:a.mp3\n#BPM:300\n: 0 1 0 la\nE\n',
      'playlists/top.upl': Buffer.from(
        '#Name: Top\r\nZazie : zen\r\nÉdith Piaf : Hymne\r\n',
        'latin1',
      ),
      'playlists/autre.upl': 'Desireless : Voyage Voyage\n',
    });
    try {
      const catalog = createCatalog({
        songDir: path.join(dir.root, 'songs'),
        logger: silentLogger,
      });
      await catalog.load();
      const playlists = createPlaylists({
        playlistDir: path.join(dir.root, 'playlists'),
        catalog,
        backupDir: path.join(dir.root, 'backups'),
        logger: silentLogger,
      });
      const result = await playlists.renameSongEntries([
        { from: { artist: 'Zazie', title: 'Zen' }, to: { artist: 'Zazie', title: 'Zen (Live)' } },
      ]);
      assert.deepEqual(
        result.updated.map((u) => u.file),
        ['top.upl'],
      );
      assert.deepEqual(result.failed, []);
      assert.deepEqual(
        await readFile(path.join(dir.root, 'playlists/top.upl')),
        Buffer.from('#Name: Top\r\nZazie : Zen (Live)\r\nÉdith Piaf : Hymne\r\n', 'latin1'),
      );
      assert.equal(
        await readFile(path.join(dir.root, 'playlists/autre.upl'), 'utf8'),
        'Desireless : Voyage Voyage\n',
      );
      assert.ok(result.updated[0].backup);
    } finally {
      await dir.cleanup();
    }
  });
});
