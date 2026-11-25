// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANY_WARNING,
  criteriaFromParams,
  criteriaToParams,
  defaultCriteria,
  facetOptions,
  filterSongs,
  hasActiveFilter,
  normalizeText,
  sortSongs,
  toggleFacetValue,
  warningType,
} from '../../public/js/songFilters.js';

/**
 * @param {Partial<import('../../public/js/api.js').Song>} overrides
 * @returns {import('../../public/js/api.js').Song}
 */
const song = (overrides) => ({
  id: overrides.title ?? 'x',
  folder: '',
  txtFile: '',
  video: null,
  title: null,
  artist: null,
  year: null,
  decade: null,
  genres: [],
  languages: [],
  editions: [],
  creators: [],
  tags: [],
  isDuet: false,
  previewStart: null,
  previewSource: null,
  videoGap: 0,
  files: { audio: null, cover: null, background: null, video: null },
  warnings: [],
  modifiedAt: 0,
  ...overrides,
});

const SONGS = [
  song({
    title: 'Rétine',
    artist: 'Amir',
    year: 2021,
    decade: 2020,
    genres: ['Variété'],
    languages: ['French'],
    editions: ['Amir'],
    tags: ['Love Songs'],
    modifiedAt: 3,
  }),
  song({
    title: 'Zen',
    artist: 'Zazie',
    year: 1995,
    decade: 1990,
    genres: ['Pop', 'variete'],
    languages: ['French'],
    editions: ['Années 90'],
    tags: ['Love Songs', '90s'],
    modifiedAt: 1,
  }),
  song({
    title: 'Idées noires',
    artist: 'Bernard Lavilliers & Nicoletta',
    year: 1983,
    decade: 1980,
    isDuet: true,
    genres: ['Other'],
    languages: ['French'],
    modifiedAt: 2,
  }),
  song({
    title: 'Wonderwall',
    artist: 'Oasis',
    year: 1995,
    decade: 1990,
    genres: ['Rock'],
    languages: ['English'],
    editions: ['Années 90'],
    tags: ['90s'],
  }),
  song({ title: 'Sans année', artist: 'amir' }),
];
/** @param {Partial<import('../../public/js/songFilters.js').FilterCriteria>} c */
const criteria = (c) => ({ ...defaultCriteria(), ...c });
/** @param {import('../../public/js/api.js').Song[]} list */
const titles = (list) => list.map((s) => s.title);

describe('normalizeText', () => {
  it('supprime accents, casse et espaces superflus', () => {
    assert.equal(normalizeText('  Idées   NOIRES '), 'idees noires');
    assert.equal(normalizeText(null), '');
  });
});

describe('filterSongs', () => {
  it('recherche sur artiste et titre, sans accents, tous les mots', () => {
    assert.deepEqual(titles(filterSongs(SONGS, criteria({ q: 'retine' }))), ['Rétine']);
    assert.deepEqual(titles(filterSongs(SONGS, criteria({ q: 'nicoletta idees' }))), [
      'Idées noires',
    ]);
    assert.deepEqual(titles(filterSongs(SONGS, criteria({ q: 'zen amir' }))), []);
  });

  it('plusieurs valeurs d’une facette : OU', () => {
    assert.deepEqual(titles(filterSongs(SONGS, criteria({ decade: ['1990', '1980'] }))), [
      'Zen',
      'Idées noires',
      'Wonderwall',
    ]);
    assert.deepEqual(
      titles(filterSongs(SONGS, criteria({ language: ['english', 'French'] }))).length,
      4,
    );
  });

  it('facettes différentes : ET', () => {
    assert.deepEqual(
      titles(filterSongs(SONGS, criteria({ decade: ['1990'], language: ['French'] }))),
      ['Zen'],
    );
  });

  it('édition, tags, genre et duo, sans tenir compte de la casse ni des accents', () => {
    assert.deepEqual(titles(filterSongs(SONGS, criteria({ edition: ['annees 90'] }))), [
      'Zen',
      'Wonderwall',
    ]);
    assert.deepEqual(titles(filterSongs(SONGS, criteria({ tag: ['love songs'] }))), [
      'Rétine',
      'Zen',
    ]);
    assert.deepEqual(titles(filterSongs(SONGS, criteria({ tag: ['90s'], edition: ['Amir'] }))), []);
    assert.deepEqual(titles(filterSongs(SONGS, criteria({ genre: ['Variété'] }))), [
      'Rétine',
      'Zen',
    ]);
    assert.deepEqual(titles(filterSongs(SONGS, criteria({ duet: true }))), ['Idées noires']);
  });
});

describe('filtre « avertissements » par type', () => {
  const abimee = song({
    title: 'Abîmée',
    warnings: [
      { code: 'MISSING_END', message: 'Missing end line "E"' },
      { code: 'MISSING_HEADER', message: '', params: { header: 'YEAR' } },
    ],
  });
  const sansFichier = song({
    title: 'Sans fichier',
    warnings: [{ code: 'MISSING_FILE', message: '', params: { kind: 'video', file: 'v.mp4' } }],
  });
  const list = [...SONGS, abimee, sansFichier];

  it('type d’un avertissement : code, précisé pour les en-têtes et fichiers', () => {
    assert.equal(warningType(abimee.warnings[0]), 'MISSING_END');
    assert.equal(warningType(abimee.warnings[1]), 'MISSING_HEADER:YEAR');
    assert.equal(warningType(sansFichier.warnings[0]), 'MISSING_FILE:video');
    // Tous les avertissements de nommage dans une seule catégorie
    for (const code of ['NAMING_FOLDER', 'NAMING_TXT', 'NAMING_COVER']) {
      assert.equal(warningType({ code, message: '', params: {} }), 'NAMING');
    }
  });

  it('« Tous » garde toute chanson avec avertissement ; un type, seulement celles-là', () => {
    assert.deepEqual(titles(filterSongs(list, criteria({ warning: [ANY_WARNING] }))), [
      'Abîmée',
      'Sans fichier',
    ]);
    assert.deepEqual(titles(filterSongs(list, criteria({ warning: ['MISSING_HEADER:YEAR'] }))), [
      'Abîmée',
    ]);
    assert.deepEqual(
      titles(filterSongs(list, criteria({ warning: ['MISSING_END', 'MISSING_FILE:video'] }))),
      ['Abîmée', 'Sans fichier'],
    );
    assert.equal(hasActiveFilter(criteria({ warning: [ANY_WARNING] })), true);
  });

  it('options : « Tous » en tête, puis chaque type avec son nombre de chansons', () => {
    const options = facetOptions(list, criteria({}), 'warning', 'fr').map(
      (o) => `${o.value}:${o.count}`,
    );
    assert.equal(options[0], '*:2');
    assert.deepEqual(options.slice(1).sort(), [
      'MISSING_END:1',
      'MISSING_FILE:video:1',
      'MISSING_HEADER:YEAR:1',
    ]);
  });

  it('gardé dans l’URL, et ancien lien « ?warnings=1 » compris', () => {
    const params = criteriaToParams(criteria({ warning: ['MISSING_HEADER:YEAR'] }));
    assert.equal(params.toString(), 'warning=MISSING_HEADER%3AYEAR');
    assert.deepEqual(criteriaFromParams(params).warning, ['MISSING_HEADER:YEAR']);
    assert.deepEqual(criteriaFromParams(new URLSearchParams('warnings=1')).warning, [ANY_WARNING]);
    assert.deepEqual(
      criteriaFromParams(new URLSearchParams('warning=NAMING_COVER&warning=NAMING_TXT')).warning,
      ['NAMING'],
    );
  });
});

describe('facetOptions — valeurs et compteurs', () => {
  it('langues triées par nombre de chansons', () => {
    assert.deepEqual(facetOptions(SONGS, defaultCriteria(), 'language', 'fr'), [
      { value: 'French', count: 3, selected: false },
      { value: 'English', count: 1, selected: false },
    ]);
  });

  it('décennies par ordre décroissant', () => {
    assert.deepEqual(
      facetOptions(SONGS, defaultCriteria(), 'decade', 'fr').map((o) => o.value),
      ['2020', '1990', '1980'],
    );
  });

  it('éditions par ordre alphabétique, tags par nombre de chansons', () => {
    assert.deepEqual(
      facetOptions(SONGS, defaultCriteria(), 'edition', 'fr').map((o) => `${o.value}:${o.count}`),
      ['Amir:1', 'Années 90:2'],
    );
    assert.deepEqual(
      facetOptions(SONGS, defaultCriteria(), 'tag', 'fr').map((o) => `${o.value}:${o.count}`),
      ['90s:2', 'Love Songs:2'],
    );
  });

  it('les compteurs tiennent compte des autres filtres, pas de la facette elle-même', () => {
    const c = criteria({ language: ['English'], decade: ['1990'] });
    assert.deepEqual(facetOptions(SONGS, c, 'language', 'fr'), [
      { value: 'English', count: 1, selected: true },
      { value: 'French', count: 1, selected: false },
    ]);
    assert.deepEqual(
      facetOptions(SONGS, c, 'decade', 'fr').map((o) => `${o.value}:${o.count}:${o.selected}`),
      ['2020:0:false', '1990:1:true', '1980:0:false'],
    );
  });

  it('une valeur choisie mais absente reste listée', () => {
    const options = facetOptions(SONGS, criteria({ genre: ['Jazz'] }), 'genre', 'fr');
    assert.ok(options.some((o) => o.value === 'Jazz' && o.selected && o.count === 0));
  });
});

describe('toggleFacetValue', () => {
  it('ajoute puis retire une valeur sans modifier l’original', () => {
    const start = defaultCriteria();
    const added = toggleFacetValue(start, 'genre', 'Pop');
    assert.deepEqual(added.genre, ['Pop']);
    assert.deepEqual(start.genre, []);
    assert.deepEqual(toggleFacetValue(added, 'genre', 'pop').genre, []);
  });
});

describe('sortSongs', () => {
  it('par artiste puis titre', () => {
    assert.deepEqual(titles(sortSongs(SONGS, 'artist', 'fr')), [
      'Rétine',
      'Sans année',
      'Idées noires',
      'Wonderwall',
      'Zen',
    ]);
  });

  it('par année, les années inconnues à la fin', () => {
    assert.deepEqual(titles(sortSongs(SONGS, 'year-asc', 'fr')), [
      'Idées noires',
      'Wonderwall',
      'Zen',
      'Rétine',
      'Sans année',
    ]);
    assert.equal(titles(sortSongs(SONGS, 'year-desc', 'fr')).at(-1), 'Sans année');
  });

  it('par date d’ajout (création du dossier), indépendante des modifications', () => {
    const songs = [
      song({ title: 'Ancienne modifiée', artist: 'A', addedAt: 10, modifiedAt: 99 }),
      song({ title: 'Nouvelle copiée', artist: 'B', addedAt: 50, modifiedAt: 1 }),
      song({ title: 'Moyenne', artist: 'C', addedAt: 30, modifiedAt: 2 }),
    ];
    assert.deepEqual(titles(sortSongs(songs, 'added', 'fr')), [
      'Nouvelle copiée',
      'Moyenne',
      'Ancienne modifiée',
    ]);
    assert.equal(titles(sortSongs(songs, 'recent', 'fr'))[0], 'Ancienne modifiée');
  });

  it('par date de modification, sans modifier la liste d’origine', () => {
    const copy = [...SONGS];
    assert.deepEqual(titles(sortSongs(SONGS, 'recent', 'fr')).slice(0, 3), [
      'Rétine',
      'Idées noires',
      'Zen',
    ]);
    assert.deepEqual(SONGS, copy);
  });
});

describe('critères ↔ URL', () => {
  it('aller-retour avec valeurs multiples', () => {
    const c = criteria({
      q: 'zen',
      language: ['French', 'English'],
      decade: ['1990'],
      tag: ['90s'],
      duet: true,
      sort: 'title',
    });
    const params = criteriaToParams(c);
    assert.equal(
      params.toString(),
      'q=zen&language=French&language=English&decade=1990&tag=90s&duet=1&sort=title',
    );
    assert.deepEqual(criteriaFromParams(params), c);
    assert.equal(criteriaToParams(defaultCriteria()).toString(), '');
  });

  it('ignore les valeurs invalides et les doublons', () => {
    const c = criteriaFromParams(
      new URLSearchParams('decade=abc&decade=1990&decade=1990&year=19&sort=nimporte'),
    );
    assert.deepEqual(c, criteria({ decade: ['1990'] }));
  });

  it('hasActiveFilter ignore le tri', () => {
    assert.equal(hasActiveFilter(criteria({ sort: 'title' })), false);
    assert.equal(hasActiveFilter(criteria({ genre: ['Pop'] })), true);
    assert.equal(hasActiveFilter(criteria({ q: '  ' })), false);
  });
});

describe('facette « playlist »', () => {
  const songs = [
    song({ title: 'A', playlists: ['Top', 'Soirée'] }),
    song({ title: 'B', playlists: ['Soirée'] }),
    song({ title: 'C' }), // pas encore reliée (playlists non chargées) ou dans aucune
  ];

  it('filtre sur une ou plusieurs playlists (OU entre elles)', () => {
    const titles = (/** @type {string[]} */ playlist) =>
      filterSongs(songs, { ...defaultCriteria(), playlist }).map((s) => s.title);
    assert.deepEqual(titles(['Top']), ['A']);
    assert.deepEqual(titles(['Top', 'Soirée']), ['A', 'B']);
    assert.deepEqual(titles([]), ['A', 'B', 'C']);
  });

  it('options triées par nom, avec le nombre de chansons', () => {
    assert.deepEqual(
      facetOptions(songs, defaultCriteria(), 'playlist', 'fr').map((o) => `${o.value}:${o.count}`),
      ['Soirée:2', 'Top:1'],
    );
  });

  it('gardée dans l’URL', () => {
    const criteria = { ...defaultCriteria(), playlist: ['Top FR 80-90'] };
    const params = criteriaToParams(criteria);
    assert.equal(params.toString(), 'playlist=Top+FR+80-90');
    assert.deepEqual(criteriaFromParams(params).playlist, ['Top FR 80-90']);
  });
});
