// @ts-check
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveInside } from '../../src/utils/safePath.js';

describe('resolveInside — protection path traversal', () => {
  const root = path.resolve('/bibliotheque');

  it('accepte un chemin à l’intérieur', () => {
    assert.equal(
      resolveInside(root, 'Artiste/chanson.txt'),
      path.join(root, 'Artiste', 'chanson.txt'),
    );
    assert.equal(resolveInside(root, ''), root);
  });

  it('accepte un nom commençant par deux points', () => {
    assert.equal(resolveInside(root, '..chanson.txt'), path.join(root, '..chanson.txt'));
  });

  it('refuse de sortir de la racine', () => {
    assert.equal(resolveInside(root, '../secret.txt'), null);
    assert.equal(resolveInside(root, 'Artiste/../../secret.txt'), null);
    assert.equal(resolveInside(root, path.resolve('/ailleurs/fichier.txt')), null);
  });
});
