// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMusicBrainz } from '../../src/services/musicBrainzService.js';
import {
  ARTIST_ID,
  fakeMusicBrainzFetch,
  RECORDING_ID,
  RELEASE_GROUP_ID,
} from '../helpers/musicBrainzSamples.js';

const silentLogger = { warn() {} };

describe('musicBrainzService', () => {
  it('recherche : URL de l’API, JSON, User-Agent identifié', async () => {
    const fetch = fakeMusicBrainzFetch();
    const mb = createMusicBrainz({ fetch, minIntervalMs: 0, logger: silentLogger });
    const candidates = await mb.search('Zazie', 'Zen');
    assert.equal(candidates[0].id, RECORDING_ID);
    const [{ url, headers }] = fetch.calls;
    assert.equal(url.origin + url.pathname, 'https://musicbrainz.org/ws/2/recording');
    assert.equal(url.searchParams.get('query'), 'recording:"Zen" AND artist:"Zazie"');
    assert.equal(url.searchParams.get('fmt'), 'json');
    assert.match(headers['User-Agent'], /^UltraStarWebManager\/.+\(.+\)$/);
  });

  it('rien au mot près : requête de repli par mots (« et » ignoré), arrêt dès un résultat', async () => {
    const fetch = fakeMusicBrainzFetch({ emptySearches: 1 });
    const mb = createMusicBrainz({ fetch, minIntervalMs: 0, logger: silentLogger });
    const candidates = await mb.search('Stone et Charden', 'Le prix des allumettes');
    assert.equal(candidates[0].id, RECORDING_ID);
    assert.deepEqual(
      fetch.calls.map((c) => c.url.searchParams.get('query')),
      [
        'recording:"Le prix des allumettes" AND artist:"Stone et Charden"',
        'recording:"Le prix des allumettes" AND artist:(Stone AND Charden)',
      ],
    );
  });

  it('rien du tout : les trois requêtes sont essayées, liste vide', async () => {
    const fetch = fakeMusicBrainzFetch({ emptySearches: 9 });
    const mb = createMusicBrainz({ fetch, minIntervalMs: 0, logger: silentLogger });
    assert.deepEqual(await mb.search('A et B', 'T'), []);
    assert.equal(fetch.calls.length, 3);
  });

  it('au plus une requête par intervalle, et cache : pas de requête répétée', async () => {
    const fetch = fakeMusicBrainzFetch();
    const mb = createMusicBrainz({ fetch, minIntervalMs: 120, logger: silentLogger });
    const start = Date.now();
    await Promise.all([mb.search('A', 'B'), mb.search('C', 'D'), mb.search('A', 'B')]);
    assert.equal(fetch.calls.length, 2); // A/B demandé deux fois, une seule requête
    assert.ok(Date.now() - start >= 110, 'la 2e requête attend l’intervalle');
    await mb.search('C', 'D');
    assert.equal(fetch.calls.length, 2);
  });

  it('proposition : enregistrement, album et artiste interrogés', async () => {
    const fetch = fakeMusicBrainzFetch();
    const mb = createMusicBrainz({ fetch, minIntervalMs: 0, logger: silentLogger });
    const suggestion = await mb.suggest(RECORDING_ID, {
      artistId: ARTIST_ID,
      releaseGroupId: RELEASE_GROUP_ID,
    });
    assert.equal(suggestion.year, 1995);
    assert.deepEqual(
      fetch.calls.map((c) => c.url.pathname.split('/').slice(3, 4)[0]),
      ['recording', 'release-group', 'artist'],
    );
    assert.equal(fetch.calls[0].url.searchParams.get('inc'), 'releases genres artist-credits');
  });

  it('erreurs : réseau → MUSICBRAINZ_UNAVAILABLE, 503 → MUSICBRAINZ_BUSY', async () => {
    const offline = createMusicBrainz({
      fetch: fakeMusicBrainzFetch({ fail: true }),
      minIntervalMs: 0,
      logger: silentLogger,
    });
    await assert.rejects(offline.search('A', 'B'), {
      code: 'MUSICBRAINZ_UNAVAILABLE',
      status: 502,
    });
    const busy = createMusicBrainz({
      fetch: fakeMusicBrainzFetch({ status: 503 }),
      minIntervalMs: 0,
      logger: silentLogger,
    });
    await assert.rejects(busy.search('A', 'B'), { code: 'MUSICBRAINZ_BUSY', status: 503 });
    // Une erreur ne bloque pas la file : la requête suivante part normalement
    await assert.rejects(busy.search('C', 'D'), { code: 'MUSICBRAINZ_BUSY' });
  });
});
