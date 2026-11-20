// @ts-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  beatToSeconds,
  decodeSongBuffer,
  getDecade,
  parseNumber,
  parseUltrastarTxt,
  parseYear,
} from '../../src/parsers/ultrastarTxt.js';

const fixture = (/** @type {string} */ name) =>
  readFile(new URL(`../fixtures/${name}`, import.meta.url));

describe('parseUltrastarTxt — fichier simple', async () => {
  const song = parseUltrastarTxt(await fixture('simple-utf8.txt'));

  it('lit les métadonnées principales', () => {
    assert.equal(song.meta.title, 'Ma Chanson Test');
    assert.equal(song.meta.artist, 'Artiste Démo');
    assert.equal(song.meta.audio, 'audio.mp3');
    assert.equal(song.meta.cover, 'cover.jpg');
    assert.equal(song.meta.genre, 'Pop');
    assert.equal(song.meta.language, 'French');
  });

  it('calcule année et décennie', () => {
    assert.equal(song.meta.year, 1987);
    assert.equal(song.meta.decade, 1980);
  });

  it('accepte la virgule comme séparateur décimal', () => {
    assert.equal(song.meta.bpm, 300.5);
    assert.equal(song.meta.previewStart, 45.25);
    assert.equal(song.meta.gap, 12500);
  });

  it('compte les notes et s’arrête à « E »', () => {
    assert.equal(song.stats.notes, 5);
    assert.equal(song.stats.lineBreaks, 1);
    assert.equal(song.stats.hasEnd, true);
    assert.equal(song.stats.isDuet, false);
  });

  it('ne signale aucun problème', () => {
    assert.deepEqual(song.warnings, []);
    assert.equal(song.encoding, 'utf-8');
  });
});

describe('parseUltrastarTxt — duo et format 1.1', async () => {
  const song = parseUltrastarTxt(await fixture('duet.txt'));

  it('détecte un duo', () => {
    assert.equal(song.stats.isDuet, true);
    assert.equal(song.stats.notes, 4);
  });

  it('privilégie #AUDIO sur #MP3', () => {
    assert.equal(song.meta.audio, 'duo.mp3');
    assert.equal(song.meta.version, '1.1.0');
  });

  it('année absente → null', () => {
    assert.equal(song.meta.year, null);
    assert.equal(song.meta.decade, null);
  });
});

describe('decodeSongBuffer — encodages', () => {
  it('retire le BOM UTF-8', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#TITLE:Été', 'utf8')]);
    const { text, encoding } = decodeSongBuffer(buf);
    assert.equal(encoding, 'utf-8-bom');
    assert.equal(text, '#TITLE:Été');
  });

  it('se replie sur Windows-1252 pour les anciens fichiers', () => {
    const buf = Buffer.from('#ARTIST:Céline Dion', 'latin1');
    const { text, encoding } = decodeSongBuffer(buf);
    assert.equal(encoding, 'windows-1252');
    assert.equal(text, '#ARTIST:Céline Dion');
  });
});

describe('parseUltrastarTxt — cas dégradés', () => {
  it('gère les fins de ligne Windows (CRLF)', () => {
    const song = parseUltrastarTxt(
      '#TITLE:A\r\n#ARTIST:B\r\n#MP3:a.mp3\r\n#BPM:100\r\n: 0 1 1 la\r\nE\r\n',
    );
    assert.equal(song.meta.title, 'A');
    assert.equal(song.stats.notes, 1);
    assert.deepEqual(song.warnings, []);
  });

  it('signale les en-têtes obligatoires manquants et la fin absente', () => {
    const song = parseUltrastarTxt(': 0 1 1 la\n');
    const codes = song.warnings.map((w) => `${w.code}:${w.params?.header ?? ''}`);
    assert.ok(codes.includes('MISSING_HEADER:TITLE'));
    assert.ok(codes.includes('MISSING_HEADER:ARTIST'));
    assert.ok(codes.includes('MISSING_END:'));
  });

  it('produit des avertissements en anglais avec un code stable', () => {
    const song = parseUltrastarTxt('#TITLE:A\n#ARTIST:B\n#MP3:a.mp3\n#BPM:x\n: 0 1 1 la\n');
    assert.deepEqual(song.warnings, [
      {
        code: 'MISSING_HEADER',
        message: 'Missing or invalid #BPM header',
        params: { header: 'BPM' },
      },
      { code: 'MISSING_END', message: 'Missing end line "E"' },
    ]);
  });

  it('conserve les en-têtes inconnus, clés en majuscules', () => {
    const song = parseUltrastarTxt('#title:A\n#MonTag:valeur\nE\n');
    assert.equal(song.headers.TITLE, 'A');
    assert.equal(song.headers.MONTAG, 'valeur');
  });

  it('signale un en-tête en double', () => {
    const song = parseUltrastarTxt('#TITLE:A\n#TITLE:B\nE\n');
    assert.equal(song.meta.title, 'B');
    assert.ok(
      song.warnings.some((w) => w.code === 'DUPLICATE_HEADER' && w.params?.header === 'TITLE'),
    );
  });
});

describe('fonctions utilitaires', () => {
  it('parseNumber', () => {
    assert.equal(parseNumber('12,5'), 12.5);
    assert.equal(parseNumber(' 7 '), 7);
    assert.equal(parseNumber('abc'), null);
    assert.equal(parseNumber(''), null);
    assert.equal(parseNumber(undefined), null);
  });

  it('parseYear', () => {
    assert.equal(parseYear('1999'), 1999);
    assert.equal(parseYear('vers 1975'), 1975);
    assert.equal(parseYear('0000'), null);
    assert.equal(parseYear(undefined), null);
  });

  it('getDecade', () => {
    assert.equal(getDecade(2003), 2000);
    assert.equal(getDecade(null), null);
  });
});

describe('beatToSeconds', () => {
  it('convertit un beat en secondes (BPM × 4, GAP en ms)', () => {
    // 300 BPM UltraStar → 1 beat = 60 / 1200 = 0,05 s
    assert.equal(beatToSeconds(200, 300, 2000), 12);
    assert.equal(beatToSeconds(0, 300, null), 0);
  });

  it('null si le BPM est invalide', () => {
    assert.equal(beatToSeconds(10, 0, 0), null);
  });
});
