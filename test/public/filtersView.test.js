// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// filtersView.js importe i18n.js (navigateur) : on ne teste ici que la fonction pure,
// importée dynamiquement après avoir fourni un minimum d'objets du navigateur.
globalThis.document ??= /** @type {any} */ ({ documentElement: {}, addEventListener() {} });
const { placeholderText } = await import('../../public/js/filtersView.js');

describe('placeholderText — initiales des vignettes sans image', () => {
  it('mot court en entier, mot long : 2 lettres', () => {
    assert.equal(placeholderText('Other'), 'OTHER');
    assert.equal(placeholderText('Breton'), 'BR');
  });

  it('plusieurs mots : initiales des deux premiers', () => {
    assert.equal(placeholderText('Alain Souchon'), 'AS');
    assert.equal(placeholderText('Bernard Lavilliers & Nicoletta'), 'BL');
  });

  it('décennie et valeur vide', () => {
    assert.equal(placeholderText('1990'), '1990');
    assert.equal(placeholderText('  '), '?');
  });
});
