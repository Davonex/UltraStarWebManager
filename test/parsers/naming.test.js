// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkNaming,
  DEFAULT_NAMING,
  expectedName,
  matchesPattern,
  namingKey,
  patternError,
  titleWithoutDuetMark,
} from '../../src/parsers/naming.js';

const BASE_PATTERN = '{artist} - {title}';
/** @param {string} artist @param {string} title */
const expectedBase = (artist, title) => expectedName(BASE_PATTERN, artist, title);
/** @param {string} stem @param {string} artist @param {string} title @param {string} suffix */
const matchesExpected = (stem, artist, title, suffix) =>
  matchesPattern(stem, `${BASE_PATTERN}${suffix}`, artist, title);

const BASE = 'Phil Collins & Philip Bailey - Easy Lover';
/** @param {Partial<Parameters<typeof checkNaming>[0]>} overrides */
const song = (overrides = {}) => ({
  artist: 'Phil Collins & Philip Bailey',
  title: 'Easy Lover',
  folderName: BASE,
  txtFile: `${BASE}.txt`,
  isDuet: false,
  files: {
    audio: `${BASE}.mp3`,
    video: `${BASE}.mp4`,
    cover: `${BASE} [CO].jpg`,
    background: `${BASE} [BG].jpg`,
    vocals: `${BASE} [VOC].mp3`,
    instrumental: `${BASE} [INSTR].mp3`,
  },
  ...overrides,
});
/** @param {ReturnType<typeof checkNaming>} problems */
const kinds = (problems) => problems.map((p) => p.kind);

describe('checkNaming', () => {
  it('tout conforme : aucun problème', () => {
    assert.deepEqual(checkNaming(song()), []);
  });

  it('comparaison souple : casse, espaces, caractères interdits par Windows', () => {
    assert.deepEqual(
      checkNaming(
        song({
          title: 'Re: Stacks?',
          folderName: 'phil collins & philip bailey -  re stacks',
          txtFile: 'Phil Collins & Philip Bailey - Re Stacks.txt',
          files: { cover: 'PHIL COLLINS & PHILIP BAILEY - RE STACKS [co].JPG' },
        }),
      ),
      [],
    );
    assert.equal(expectedBase(' A ', ' B: C '), 'A - B C');
    assert.equal(expectedBase('AC/DC', 'Back'), 'AC-DC - Back');
    assert.equal(namingKey('Abc. '), 'abc');
  });

  it('signale chaque élément mal nommé avec le nom attendu (extension gardée)', () => {
    const problems = checkNaming(
      song({
        folderName: 'Easy Lover',
        txtFile: 'easy.txt',
        files: { audio: 'song.ogg', video: 'clip.avi', cover: `${BASE}.jpg`, background: 'bg.png' },
      }),
    );
    assert.deepEqual(problems, [
      { kind: 'FOLDER', actual: 'Easy Lover', expected: BASE },
      { kind: 'TXT', actual: 'easy.txt', expected: `${BASE}.txt` },
      { kind: 'AUDIO', actual: 'song.ogg', expected: `${BASE}.ogg` },
      { kind: 'VIDEO', actual: 'clip.avi', expected: `${BASE}.avi` },
      { kind: 'COVER', actual: `${BASE}.jpg`, expected: `${BASE} [CO].jpg` },
      { kind: 'BACKGROUND', actual: 'bg.png', expected: `${BASE} [BG].png` },
    ]);
  });

  it('duo : « [DUET] » attendu ; « - DUO » ou « (DUO) » signalés', () => {
    assert.deepEqual(checkNaming(song({ isDuet: true, txtFile: `${BASE} [DUET].txt` })), []);
    for (const txtFile of [`${BASE} - DUO.txt`, `${BASE} (DUO).txt`, `${BASE}.txt`]) {
      const [problem] = checkNaming(song({ isDuet: true, txtFile }));
      assert.deepEqual(problem, { kind: 'TXT', actual: txtFile, expected: `${BASE} [DUET].txt` });
    }
  });

  it('fichiers absents, chanson à la racine ou sans artiste : non vérifiés', () => {
    assert.deepEqual(kinds(checkNaming(song({ folderName: '', files: {} }))), []);
    assert.deepEqual(checkNaming(song({ artist: null, txtFile: 'x.txt' })), []);
  });

  it('vidéo qui sert aussi de musique : vérifiée une seule fois (comme audio)', () => {
    const problems = checkNaming(song({ files: { audio: 'clip.mp4', video: 'clip.mp4' } }));
    assert.deepEqual(kinds(problems), ['AUDIO']);
  });
});

describe('matchesExpected — variantes acceptées', () => {
  it('caractère interdit retiré ou remplacé ; accents ignorés ; autre caractère refusé', () => {
    for (const stem of ['AC-DC - Back', 'ACDC - Back', 'AC DC - Back', 'AC_DC - Back']) {
      assert.equal(matchesExpected(stem, 'AC/DC', 'Back', ''), true, stem);
    }
    assert.equal(matchesExpected('ACxDC - Back', 'AC/DC', 'Back', ''), false);
    assert.equal(matchesExpected('Alain Barriere - Elle', 'Alain Barrière', 'Elle', ''), true);
    assert.equal(matchesExpected('A - B+C [CO]', 'A', 'B+C', ' [CO]'), true);
    assert.equal(matchesExpected('A - BxC', 'A', 'B+C', ''), false);
  });
});

describe('titre qui porte déjà une marque de duo', () => {
  it('« Tonight (Quintet) [DUET] » : dossier et médias sans [DUET], .txt avec', () => {
    const base = 'West Side Story - Tonight (Quintet)';
    const problems = checkNaming({
      artist: 'West Side Story',
      title: 'Tonight (Quintet) [DUET]',
      folderName: base,
      txtFile: `${base} [DUET].txt`,
      isDuet: true,
      files: { audio: `${base}.mp4` },
    });
    assert.deepEqual(problems, []);
    assert.equal(titleWithoutDuetMark('Easy Lover (Duet)'), 'Easy Lover');
    assert.equal(titleWithoutDuetMark('Easy Lover - DUO'), 'Easy Lover');
    assert.equal(titleWithoutDuetMark('Duo de choc'), 'Duo de choc');
  });
});

describe('modèles personnalisés (préférences)', () => {
  const rules = {
    ...DEFAULT_NAMING,
    cover: { enabled: true, pattern: '{title} (cover)' },
    background: { enabled: false, pattern: '{artist} - {title} [BG]' },
  };
  it('applique le modèle et désactive la vérification d’un élément', () => {
    const problems = checkNaming(
      {
        artist: 'A',
        title: 'B',
        folderName: 'A - B',
        txtFile: 'A - B.txt',
        isDuet: false,
        files: { cover: 'A - B [CO].jpg', background: 'n’importe quoi.jpg' },
      },
      rules,
    );
    assert.deepEqual(problems, [
      { kind: 'COVER', actual: 'A - B [CO].jpg', expected: 'B (cover).jpg' },
    ]);
  });

  it('valide un modèle saisi', () => {
    assert.equal(patternError('{artist} - {title} [CO]'), null);
    assert.equal(patternError('{title}'), null);
    assert.equal(patternError(''), 'PATTERN_EMPTY');
    assert.equal(patternError('pochette'), 'PATTERN_NO_PLACEHOLDER');
    assert.equal(patternError('{artist} - {year}'), 'PATTERN_UNKNOWN_PLACEHOLDER');
    assert.equal(patternError('{artist}: {title}'), 'PATTERN_FORBIDDEN_CHARACTER');
    assert.equal(patternError('{title}'.padEnd(201, 'x')), 'PATTERN_TOO_LONG');
    // Appels répétés : même réponse (pas d'état caché entre deux appels)
    for (let i = 0; i < 3; i++) assert.equal(patternError('{artist} - {title}'), null);
  });
});
