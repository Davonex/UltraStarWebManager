// @ts-check
/**
 * Réponses MusicBrainz d'exemple (structure de l'API JSON /ws/2, contenu inventé et réduit).
 * @module test/helpers/musicBrainzSamples
 */

export const RECORDING_ID = '0f3c6c3e-1111-4a6b-9c0d-000000000001';
export const LIVE_ID = '0f3c6c3e-1111-4a6b-9c0d-000000000002';
export const ARTIST_ID = 'a1a1a1a1-2222-4b6b-9c0d-000000000003';
export const RELEASE_GROUP_ID = 'b2b2b2b2-3333-4c6c-9c0d-000000000004';

/** GET /ws/2/recording?query=… */
export const SEARCH = {
  created: '2026-11-22T10:00:00.000Z',
  count: 3,
  offset: 0,
  recordings: [
    {
      id: LIVE_ID,
      score: 81,
      title: 'Zen (live)',
      'artist-credit': [{ name: 'Zazie', artist: { id: ARTIST_ID, name: 'Zazie' } }],
      'first-release-date': '1999-05',
      releases: [{ id: 'r-3', title: 'Live', status: 'Bootleg' }],
    },
    {
      id: RECORDING_ID,
      score: 100,
      title: 'Zen',
      length: 254000,
      'artist-credit': [
        { name: 'Zazie', joinphrase: ' feat. ', artist: { id: ARTIST_ID, name: 'Zazie' } },
        { name: 'Invité', artist: { id: 'c3c3c3c3-4444-4d6d-9c0d-000000000005', name: 'Invité' } },
      ],
      'first-release-date': '1995-03-06',
      releases: [
        { id: 'r-1', title: 'Compil', status: 'Promotion' },
        {
          id: 'r-2',
          title: 'Zen',
          status: 'Official',
          'release-group': { id: RELEASE_GROUP_ID, 'primary-type': 'Single' },
          date: '1995',
          country: 'FR',
        },
      ],
      tags: [{ count: 1, name: 'french pop' }],
    },
    { id: 'pas-un-mbid', score: 99, title: 'Ignoré' },
  ],
};

/** GET /ws/2/recording/{id}?inc=releases+genres+artist-credits */
export const RECORDING = {
  id: RECORDING_ID,
  title: 'Zen',
  'first-release-date': '1995-03-06',
  'artist-credit': [{ name: 'Zazie', artist: { id: ARTIST_ID, name: 'Zazie' } }],
  genres: [],
  releases: [
    { title: 'Zen', 'text-representation': { language: 'fra', script: 'Latn' } },
    { title: 'Made in Love', 'text-representation': { language: 'fra', script: 'Latn' } },
    { title: 'Euro Hits', 'text-representation': { language: 'eng', script: 'Latn' } },
    { title: 'Karaoké', 'text-representation': { language: 'zxx', script: null } },
    { title: 'Sans info', 'text-representation': { language: null, script: null } },
  ],
};

/** GET /ws/2/release-group/{id}?inc=genres */
export const RELEASE_GROUP = {
  id: RELEASE_GROUP_ID,
  genres: [
    { name: 'pop', count: 1 },
    { name: 'chanson française', count: 3 },
  ],
};

/** GET /ws/2/artist/{id}?inc=genres */
export const ARTIST = {
  id: ARTIST_ID,
  genres: [
    { name: 'Pop', count: 5 },
    { name: 'french pop', count: 2 },
  ],
};

/**
 * Faux `fetch` qui répond selon l'URL et garde la trace des appels.
 * @param {{ status?: number, fail?: boolean }} [options]
 */
export function fakeMusicBrainzFetch({ status = 200, fail = false } = {}) {
  /** @type {{ url: URL, headers: Record<string, string> }[]} */
  const calls = [];
  /** @type {typeof fetch & { calls: typeof calls }} */
  const fakeFetch = Object.assign(
    async (/** @type {any} */ input, /** @type {any} */ init) => {
      const url = new URL(String(input));
      calls.push({ url, headers: init?.headers ?? {} });
      if (fail) throw new TypeError('fetch failed');
      const path = url.pathname;
      const body = path.endsWith('/recording')
        ? SEARCH
        : path.includes('/recording/')
          ? RECORDING
          : path.includes('/release-group/')
            ? RELEASE_GROUP
            : path.includes('/artist/')
              ? ARTIST
              : null;
      const code = body ? status : 404;
      return new Response(JSON.stringify(body ?? {}), {
        status: code,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    { calls },
  );
  return fakeFetch;
}
