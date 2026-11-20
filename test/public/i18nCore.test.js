// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  flattenKeys,
  interpolate,
  lookup,
  matchLanguage,
  resolveLanguage,
  translate,
} from '../../public/js/i18nCore.js';

describe('resolveLanguage — choix de la langue', () => {
  it('anglais par défaut sans indication', () => {
    assert.equal(resolveLanguage(), 'en');
  });

  it('prend la première langue du navigateur disponible', () => {
    assert.equal(resolveLanguage({ browser: ['de-DE', 'fr-FR', 'en-US'] }), 'fr');
  });

  it('se replie sur l’anglais si aucune langue du navigateur n’est disponible', () => {
    assert.equal(resolveLanguage({ browser: ['de-DE', 'es'] }), 'en');
  });

  it('le choix enregistré prime sur le navigateur', () => {
    assert.equal(resolveLanguage({ stored: 'en', browser: ['fr-FR'] }), 'en');
  });

  it('ignore un choix enregistré invalide', () => {
    assert.equal(resolveLanguage({ stored: 'xx', browser: ['fr'] }), 'fr');
  });
});

describe('matchLanguage', () => {
  it('normalise casse et séparateurs', () => {
    assert.equal(matchLanguage('FR_ca'), 'fr');
    assert.equal(matchLanguage(' en-GB '), 'en');
    assert.equal(matchLanguage(''), null);
    assert.equal(matchLanguage(null), null);
  });
});

describe('translate', () => {
  const en = {
    status: { ok: 'Server OK', v: 'v{version}' },
    songs: { count: { one: '{count} song', other: '{count} songs' } },
    onlyEn: 'English only',
  };
  const fr = {
    status: { ok: 'Serveur OK', v: 'v{version}' },
    songs: { count: { one: '{count} chanson', other: '{count} chansons' } },
  };
  const ctx = { language: 'fr', messages: fr, fallbackMessages: en };

  it('traduit une clé pointée', () => {
    assert.equal(translate(ctx, 'status.ok'), 'Serveur OK');
  });

  it('remplace les variables', () => {
    assert.equal(translate(ctx, 'status.v', { version: '0.1.0' }), 'v0.1.0');
  });

  it('gère le pluriel selon la langue (0 est singulier en français)', () => {
    assert.equal(translate(ctx, 'songs.count', { count: 0 }), '0 chanson');
    assert.equal(translate(ctx, 'songs.count', { count: 2 }), '2 chansons');
    assert.equal(
      translate({ ...ctx, language: 'en', messages: en }, 'songs.count', { count: 0 }),
      '0 songs',
    );
  });

  it('se replie sur l’anglais puis sur la clé', () => {
    assert.equal(translate(ctx, 'onlyEn'), 'English only');
    assert.equal(translate(ctx, 'cle.inconnue'), 'cle.inconnue');
  });
});

describe('utilitaires', () => {
  it('lookup', () => {
    assert.equal(lookup({ a: { b: 'x' } }, 'a.b'), 'x');
    assert.equal(lookup({ a: 'x' }, 'a.b'), undefined);
  });

  it('interpolate laisse les variables inconnues intactes', () => {
    assert.equal(interpolate('{a} {b}', { a: 1 }), '1 {b}');
  });

  it('flattenKeys', () => {
    assert.deepEqual(flattenKeys({ a: 'x', b: { c: 'y', d: { e: 'z' } } }), ['a', 'b.c', 'b.d.e']);
  });
});
