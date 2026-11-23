// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeWindows1252, UnencodableCharacterError } from '../../src/utils/windows1252.js';

const decode = (/** @type {Uint8Array} */ bytes) => new TextDecoder('windows-1252').decode(bytes);

describe('encodeWindows1252', () => {
  it('ASCII et accents Latin-1', () => {
    assert.deepEqual([...encodeWindows1252('Été ça')], [0xc9, 0x74, 0xe9, 0x20, 0xe7, 0x61]);
  });

  it('caractères typographiques de la plage 0x80–0x9F', () => {
    assert.deepEqual([...encodeWindows1252('€’“”œ…')], [0x80, 0x92, 0x93, 0x94, 0x9c, 0x85]);
  });

  it('aller-retour sans perte sur les 256 octets', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    assert.deepEqual([...encodeWindows1252(decode(all))], [...all]);
  });

  it('refuse un caractère absent de Windows-1252', () => {
    assert.throws(
      () => encodeWindows1252('Karaoké 🎤'),
      (error) => {
        assert.ok(error instanceof UnencodableCharacterError);
        assert.equal(error.character, '🎤');
        return true;
      },
    );
    assert.throws(() => encodeWindows1252('日本'), UnencodableCharacterError);
  });
});
