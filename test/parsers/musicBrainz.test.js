// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRecordingQuery,
  buildSuggestion,
  genreLabel,
  languageName,
  parseRecordingSearch,
  yearOf,
} from '../../src/parsers/musicBrainz.js';
import {
  ARTIST,
  ARTIST_ID,
  RECORDING,
  RECORDING_ID,
  RELEASE_GROUP,
  RELEASE_GROUP_ID,
  SEARCH,
} from '../helpers/musicBrainzSamples.js';

describe('MusicBrainz — petites fonctions', () => {
  it('requête Lucene : titre et artiste entre guillemets, guillemets échappés', () => {
    assert.equal(buildRecordingQuery('Zazie', 'Zen'), 'recording:"Zen" AND artist:"Zazie"');
    assert.equal(buildRecordingQuery('A', 'Say "hi"'), 'recording:"Say \\"hi\\"" AND artist:"A"');
  });

  it('année d’une date complète ou partielle', () => {
    assert.equal(yearOf('1995-03-06'), 1995);
    assert.equal(yearOf('1999'), 1999);
    assert.equal(yearOf(''), null);
    assert.equal(yearOf(undefined), null);
  });

  it('code ISO 639-3 → nom anglais (format #LANGUAGE), codes sans langue ignorés', () => {
    assert.equal(languageName('fra'), 'French');
    assert.equal(languageName('ENG'), 'English');
    assert.equal(languageName('zxx'), null);
    assert.equal(languageName('mul'), null);
    assert.equal(languageName('qqq'), null);
  });

  it('genre : première lettre en majuscule', () => {
    assert.equal(genreLabel('chanson française'), 'Chanson française');
    assert.equal(genreLabel(' pop rock '), 'Pop rock');
  });
});

describe('parseRecordingSearch', () => {
  it('trie par pertinence, crédits complets, premier disque officiel, ids invalides ignorés', () => {
    const [best, live, ...rest] = parseRecordingSearch(SEARCH);
    assert.deepEqual(best, {
      id: RECORDING_ID,
      title: 'Zen',
      artist: 'Zazie feat. Invité',
      year: 1995,
      album: 'Zen',
      score: 100,
      artistId: ARTIST_ID,
      releaseGroupId: RELEASE_GROUP_ID,
    });
    assert.equal(live.year, 1999);
    assert.equal(live.album, 'Live'); // pas de disque officiel : le premier
    assert.equal(live.releaseGroupId, null);
    assert.deepEqual(rest, []);
  });

  it('réponse vide ou inattendue : aucune proposition', () => {
    assert.deepEqual(parseRecordingSearch({}), []);
    assert.deepEqual(parseRecordingSearch(null), []);
  });
});

describe('buildSuggestion', () => {
  it('année, langue la plus fréquente d’abord, genres enregistrement → album → artiste sans doublon', () => {
    assert.deepEqual(buildSuggestion(RECORDING, { releaseGroup: RELEASE_GROUP, artist: ARTIST }), {
      year: 1995,
      languages: [
        { code: 'fra', name: 'French' },
        { code: 'eng', name: 'English' },
      ],
      genres: ['Chanson française', 'Pop', 'French pop'],
    });
  });

  it('sans album ni artiste, et réponse incomplète : rien ne plante', () => {
    assert.deepEqual(buildSuggestion({}), { year: null, languages: [], genres: [] });
  });
});
