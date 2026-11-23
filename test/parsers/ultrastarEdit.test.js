// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeSongText, updateHeaders } from '../../src/parsers/ultrastarEdit.js';
import { decodeSongBuffer } from '../../src/parsers/ultrastarTxt.js';

const SONG = [
  '#TITLE:Zen',
  '#ARTIST:Zazie',
  '#Edition:Années 90',
  '#BPM:300',
  ': 0 4 0 la',
  '- 8',
  ': 8 4 0 li',
  'E',
  '',
].join('\n');

describe('updateHeaders', () => {
  it('remplace une valeur en gardant la casse du nom et le reste intact', () => {
    const { text, changes } = updateHeaders(SONG, { EDITION: 'Zazie' });
    assert.equal(text, SONG.replace('#Edition:Années 90', '#Edition:Zazie'));
    assert.deepEqual(changes, [{ header: 'EDITION', before: 'Années 90', after: 'Zazie' }]);
  });

  it('ajoute un en-tête absent à la fin du bloc d’en-têtes', () => {
    const { text } = updateHeaders(SONG, { TAGS: 'Love Song, 90s' });
    assert.equal(text.split('\n')[4], '#TAGS:Love Song, 90s');
    assert.equal(text.split('\n')[5], ': 0 4 0 la');
  });

  it('supprime un en-tête (valeur null)', () => {
    const { text, changes } = updateHeaders(SONG, { EDITION: null });
    assert.ok(!text.includes('Edition'));
    assert.deepEqual(changes, [{ header: 'EDITION', before: 'Années 90', after: null }]);
  });

  it('valeur identique ou en-tête absent supprimé : aucun changement, texte identique', () => {
    const same = updateHeaders(SONG, { EDITION: 'Années 90', CREATOR: null });
    assert.equal(same.text, SONG);
    assert.deepEqual(same.changes, []);
  });

  it('conserve les fins de ligne Windows (CRLF)', () => {
    const crlf = SONG.replaceAll('\n', '\r\n');
    const { text } = updateHeaders(crlf, { CREATOR: 'Davo', EDITION: 'X' });
    assert.equal(
      text,
      crlf
        .replace('#Edition:Années 90', '#Edition:X')
        .replace('#BPM:300\r\n', '#BPM:300\r\n#CREATOR:Davo\r\n'),
    );
  });

  it('supprime les doublons d’un en-tête modifié', () => {
    const doubled = '#TITLE:A\n#TAGS:a\n#TAGS:b\n: 0 1 0 x\nE\n';
    assert.equal(updateHeaders(doubled, { TAGS: 'c' }).text, '#TITLE:A\n#TAGS:c\n: 0 1 0 x\nE\n');
  });

  it('fichier réduit aux en-têtes, sans saut de ligne final', () => {
    assert.equal(updateHeaders('#TITLE:A', { TAGS: 'x' }).text, '#TITLE:A\n#TAGS:x');
  });

  it('ne modifie jamais une ligne du corps qui ressemblerait à un en-tête', () => {
    const tricky = '#TITLE:A\n: 0 1 0 la\n#TAGS:pas un en-tête\nE\n';
    const { text } = updateHeaders(tricky, { TAGS: 'x' });
    assert.equal(text, '#TITLE:A\n#TAGS:x\n: 0 1 0 la\n#TAGS:pas un en-tête\nE\n');
  });
});

describe('encodeSongText — encodage d’origine conservé', () => {
  it('UTF-8, UTF-8 avec BOM, Windows-1252 : aller-retour exact', () => {
    for (const [encoding, bytes] of /** @type {const} */ ([
      ['utf-8', Buffer.from('#TITLE:Été\n', 'utf8')],
      [
        'utf-8-bom',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#TITLE:Été\n', 'utf8')]),
      ],
      ['windows-1252', Buffer.from('#TITLE:Été\n', 'latin1')],
    ])) {
      const decoded = decodeSongBuffer(bytes);
      assert.equal(decoded.encoding, encoding);
      assert.deepEqual(encodeSongText(decoded.text, decoded.encoding), bytes, encoding);
    }
  });
});
