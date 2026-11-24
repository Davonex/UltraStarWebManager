// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasPlaceholder, previewName } from '../../public/js/namingPreview.js';
import { expectedName } from '../../src/parsers/naming.js';

describe('previewName', () => {
  it('remplit le modèle comme le serveur', () => {
    for (const pattern of ['{artist} - {title} [CO]', '{title} ({artist})', '{artist}/{title}?']) {
      assert.equal(
        previewName(pattern, 'AC/DC', 'Back In Black'),
        expectedName(pattern, 'AC/DC', 'Back In Black'),
        pattern,
      );
    }
    assert.equal(
      previewName('{artist} - {title} [CO]', 'AC/DC', 'Back In Black'),
      'AC-DC - Back In Black [CO]',
    );
  });

  it('détecte l’absence de variable', () => {
    assert.equal(hasPlaceholder('{title} [CO]'), true);
    assert.equal(hasPlaceholder('pochette'), false);
  });
});
