// @ts-check
/**
 * Filtrage, facettes et tri des chansons côté navigateur : fonctions pures, sans DOM.
 *
 * Chaque facette (langue, décennie…) accepte plusieurs valeurs :
 * - plusieurs valeurs d'une même facette se combinent en OU (French OU English) ;
 * - des facettes différentes se combinent en ET (French ET années 1990).
 *
 * @module songFilters
 */

/** @typedef {import('./api.js').Song} Song */

/** @typedef {'artist' | 'title' | 'year-desc' | 'year-asc' | 'recent'} SortKey */

/** @typedef {'language' | 'decade' | 'genre' | 'edition' | 'tag' | 'playlist'} FacetKey */

/**
 * @typedef {object} FilterCriteria
 * @property {string} q            Recherche libre (artiste ou titre).
 * @property {string[]} language
 * @property {string[]} decade     « 1990 »…
 * @property {string[]} genre
 * @property {string[]} edition    #EDITION
 * @property {string[]} tag        #TAGS
 * @property {string[]} playlist   Playlists .upl (noms)
 * @property {boolean} duet        Uniquement les duos.
 * @property {boolean} warnings    Uniquement les chansons avec avertissements.
 * @property {SortKey} sort
 */

/**
 * @typedef {object} FacetOption Valeur proposée dans une facette.
 * @property {string} value
 * @property {number} count   Nombre de chansons (en tenant compte des autres filtres).
 * @property {boolean} selected
 */

/** Facettes dans l'ordre d'affichage. */
/** @type {readonly FacetKey[]} */
export const FACET_KEYS = Object.freeze([
  'language',
  'decade',
  'genre',
  'edition',
  'tag',
  'playlist',
]);

/** @type {readonly SortKey[]} */
export const SORT_KEYS = Object.freeze(['artist', 'title', 'year-desc', 'year-asc', 'recent']);

/** @returns {FilterCriteria} Critères vides (nouvel objet à chaque appel). */
export function defaultCriteria() {
  return {
    q: '',
    language: [],
    decade: [],
    genre: [],
    edition: [],
    tag: [],
    playlist: [],
    duet: false,
    warnings: false,
    sort: 'artist',
  };
}

/** Facettes numériques : triées par valeur décroissante plutôt que par nombre de chansons. */
const NUMERIC_FACETS = new Set(['decade']);
/** Facettes triées par ordre alphabétique (trop de valeurs pour un tri par popularité). */
const ALPHABETICAL_FACETS = new Set(['edition', 'playlist']);

/**
 * Texte de comparaison : minuscules, sans accents, espaces réduits.
 * @param {string | null | undefined} text
 * @returns {string}
 */
export function normalizeText(text) {
  return (text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Valeurs d'une chanson pour une facette.
 * @param {Song} song
 * @param {FacetKey} key
 * @returns {string[]}
 */
export function facetValues(song, key) {
  switch (key) {
    case 'language':
      return song.languages;
    case 'genre':
      return song.genres;
    case 'edition':
      return song.editions;
    case 'tag':
      return song.tags;
    case 'playlist':
      return song.playlists ?? []; // ajouté par main.js à partir de GET /api/playlists
    case 'decade':
      return song.decade === null ? [] : [String(song.decade)];
    default:
      return [];
  }
}

/**
 * @param {Song} song
 * @param {FacetKey} key
 * @param {string[]} selected
 * @returns {boolean}
 */
function matchesFacet(song, key, selected) {
  if (selected.length === 0) return true;
  const wanted = new Set(selected.map(normalizeText));
  return facetValues(song, key).some((value) => wanted.has(normalizeText(value)));
}

/**
 * Indique si une chanson correspond aux critères.
 * @param {Song} song
 * @param {FilterCriteria} criteria
 * @param {FacetKey | null} [ignoredFacet]  Facette à ne pas appliquer (calcul des compteurs).
 * @returns {boolean}
 */
export function matchesCriteria(song, criteria, ignoredFacet = null) {
  const words = normalizeText(criteria.q).split(' ').filter(Boolean);
  if (words.length > 0) {
    const haystack = normalizeText(`${song.artist ?? ''} ${song.title ?? ''}`);
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  if (criteria.duet && !song.isDuet) return false;
  if (criteria.warnings && song.warnings.length === 0) return false;
  return FACET_KEYS.every((key) => key === ignoredFacet || matchesFacet(song, key, criteria[key]));
}

/**
 * @param {readonly Song[]} songs
 * @param {FilterCriteria} criteria
 * @returns {Song[]}
 */
export function filterSongs(songs, criteria) {
  return songs.filter((song) => matchesCriteria(song, criteria));
}

/**
 * Valeurs d'une facette avec leur nombre de chansons. Le compte tient compte de tous les
 * autres filtres (mais pas de la facette elle-même, pour pouvoir ajouter des choix).
 * Les valeurs déjà choisies sont toujours présentes, même à 0.
 *
 * @param {readonly Song[]} songs
 * @param {FilterCriteria} criteria
 * @param {FacetKey} key
 * @param {string} locale
 * @returns {FacetOption[]}
 */
export function facetOptions(songs, criteria, key, locale) {
  /** @type {Map<string, { value: string, count: number }>} */
  const byKey = new Map();
  /** Toutes les valeurs existantes (même à 0) pour garder une liste stable. */
  for (const song of songs) {
    const counted = matchesCriteria(song, criteria, key);
    for (const value of facetValues(song, key)) {
      const normalized = normalizeText(value);
      if (!normalized) continue;
      const entry = byKey.get(normalized) ?? { value: value.trim(), count: 0 };
      if (counted) entry.count++;
      byKey.set(normalized, entry);
    }
  }
  const selected = new Set(criteria[key].map(normalizeText));
  for (const value of criteria[key]) {
    if (!byKey.has(normalizeText(value))) byKey.set(normalizeText(value), { value, count: 0 });
  }

  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  /** @type {(a: { value: string, count: number }, b: { value: string, count: number }) => number} */
  const compare = NUMERIC_FACETS.has(key)
    ? (a, b) => Number(b.value) - Number(a.value)
    : ALPHABETICAL_FACETS.has(key)
      ? (a, b) => collator.compare(a.value, b.value)
      : (a, b) => b.count - a.count || collator.compare(a.value, b.value);

  return [...byKey.entries()]
    .map(([normalized, entry]) => ({ ...entry, selected: selected.has(normalized) }))
    .sort(compare);
}

/**
 * Ajoute ou retire une valeur d'une facette (renvoie de nouveaux critères).
 * @param {FilterCriteria} criteria
 * @param {FacetKey} key
 * @param {string} value
 * @returns {FilterCriteria}
 */
export function toggleFacetValue(criteria, key, value) {
  const normalized = normalizeText(value);
  const current = criteria[key];
  const next = current.some((v) => normalizeText(v) === normalized)
    ? current.filter((v) => normalizeText(v) !== normalized)
    : [...current, value];
  return { ...criteria, [key]: next };
}

/**
 * Trie une copie de la liste.
 * @param {readonly Song[]} songs
 * @param {SortKey} sort
 * @param {string} locale
 * @returns {Song[]}
 */
export function sortSongs(songs, sort, locale) {
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  /** @param {Song} a @param {Song} b */
  const byArtist = (a, b) => collator.compare(a.artist ?? '', b.artist ?? '');
  /** @param {Song} a @param {Song} b */
  const byTitle = (a, b) => collator.compare(a.title ?? '', b.title ?? '');
  /** Années inconnues toujours en fin de liste. */
  const NO_YEAR = Number.POSITIVE_INFINITY;

  /** @type {Record<SortKey, (a: Song, b: Song) => number>} */
  const comparators = {
    artist: (a, b) => byArtist(a, b) || byTitle(a, b),
    title: (a, b) => byTitle(a, b) || byArtist(a, b),
    'year-desc': (a, b) =>
      (b.year ?? -NO_YEAR) - (a.year ?? -NO_YEAR) || byArtist(a, b) || byTitle(a, b),
    'year-asc': (a, b) =>
      (a.year ?? NO_YEAR) - (b.year ?? NO_YEAR) || byArtist(a, b) || byTitle(a, b),
    recent: (a, b) => b.modifiedAt - a.modifiedAt || byArtist(a, b),
  };
  return [...songs].sort(comparators[sort] ?? comparators.artist);
}

/**
 * Lit les critères depuis l'URL. Les valeurs multiples sont des paramètres répétés :
 * `?language=French&language=English&decade=1990`. Les valeurs invalides sont ignorées.
 *
 * @param {URLSearchParams} params
 * @returns {FilterCriteria}
 */
export function criteriaFromParams(params) {
  const criteria = defaultCriteria();
  const sort = /** @type {SortKey} */ (params.get('sort') ?? '');
  /** @param {string} name */
  const list = (name) => [
    ...new Set(
      params
        .getAll(name)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];

  criteria.q = params.get('q') ?? '';
  criteria.language = list('language');
  criteria.decade = list('decade').filter((v) => /^\d{4}$/.test(v));
  criteria.genre = list('genre');
  criteria.edition = list('edition');
  criteria.tag = list('tag');
  criteria.playlist = list('playlist');
  criteria.duet = params.get('duet') === '1';
  criteria.warnings = params.get('warnings') === '1';
  if (SORT_KEYS.includes(sort)) criteria.sort = sort;
  return criteria;
}

/**
 * Écrit les critères dans des paramètres d'URL (seulement ceux qui diffèrent du défaut).
 * @param {FilterCriteria} criteria
 * @returns {URLSearchParams}
 */
export function criteriaToParams(criteria) {
  const params = new URLSearchParams();
  if (criteria.q.trim()) params.set('q', criteria.q.trim());
  for (const key of FACET_KEYS) {
    for (const value of criteria[key]) params.append(key, value);
  }
  if (criteria.duet) params.set('duet', '1');
  if (criteria.warnings) params.set('warnings', '1');
  if (criteria.sort !== 'artist') params.set('sort', criteria.sort);
  return params;
}

/**
 * Indique si au moins un filtre est actif (le tri n'est pas un filtre).
 * @param {FilterCriteria} criteria
 * @returns {boolean}
 */
export function hasActiveFilter(criteria) {
  return (
    criteria.q.trim() !== '' ||
    criteria.duet ||
    criteria.warnings ||
    FACET_KEYS.some((key) => criteria[key].length > 0)
  );
}
