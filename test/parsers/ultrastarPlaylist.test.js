// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addPlaylistEntry,
  formatPlaylistEntry,
  parseUltrastarPlaylist,
  removePlaylistEntry,
  renamePlaylistEntry,
} from '../../src/parsers/ultrastarPlaylist.js';

const SAMPLE = [
  '######################################',
  '#Ultrastar Deluxe Playlist Format v1.0',
  '#Playlist "Top FR" with 3 Songs.',
  '######################################',
  '#Name: Top FR',
  '#Songs:',
  'Desireless : Voyage Voyage',
  "Céline Dion : Pour que tu m'aimes encore",
  'AC/DC : T.N.T.',
  '',
].join('\r\n');

describe('parseUltrastarPlaylist', () => {
  it('lit le nom et les chansons dans l’ordre (fins de ligne CRLF)', () => {
    const result = parseUltrastarPlaylist(SAMPLE);
    assert.equal(result.name, 'Top FR');
    assert.deepEqual(result.entries, [
      { artist: 'Desireless', title: 'Voyage Voyage' },
      { artist: 'Céline Dion', title: "Pour que tu m'aimes encore" },
      { artist: 'AC/DC', title: 'T.N.T.' },
    ]);
  });

  it('garde un titre contenant lui-même « : »', () => {
    const { entries } = parseUltrastarPlaylist('Queen : Live : Wembley\n');
    assert.deepEqual(entries, [{ artist: 'Queen', title: 'Live : Wembley' }]);
  });

  it('ignore le BOM, les lignes vides, les commentaires et les lignes mal formées', () => {
    const text =
      '\uFEFF#Name:  Ma liste \n\n# commentaire : pas une chanson\nsans séparateur\n : Titre\nA : B\n';
    assert.deepEqual(parseUltrastarPlaylist(text), {
      name: 'Ma liste',
      entries: [{ artist: 'A', title: 'B' }],
    });
  });

  it('nom absent ou vide : null', () => {
    assert.equal(parseUltrastarPlaylist('#Name:\nA : B\n').name, null);
    assert.equal(parseUltrastarPlaylist('A : B').name, null);
  });

  it('accepte « #name : » sans tenir compte de la casse', () => {
    assert.equal(parseUltrastarPlaylist('#name : Slows\n').name, 'Slows');
  });
});

describe('ajout / retrait d’une chanson', () => {
  /** @param {{ artist: string, title: string }} a @param {{ artist: string, title: string }} b */
  const same = (a, b) =>
    a.artist.toLowerCase() === b.artist.toLowerCase() &&
    a.title.toLowerCase() === b.title.toLowerCase();
  const UPL = '#Name: Top\r\n#Songs:\r\nZazie : Zen\r\nDesireless : Voyage Voyage\r\n';

  it('renomme les lignes d’une chanson, fins de ligne et autres lignes conservées', () => {
    const text = `${UPL}ZAZIE : zen`;
    assert.deepEqual(
      renamePlaylistEntry(
        text,
        { artist: 'Zazie', title: 'Zen' },
        { artist: 'Zazie', title: 'Zen (Live)' },
        same,
      ),
      {
        text: '#Name: Top\r\n#Songs:\r\nZazie : Zen (Live)\r\nDesireless : Voyage Voyage\r\nZazie : Zen (Live)',
        replaced: 2,
      },
    );
    assert.equal(
      renamePlaylistEntry(UPL, { artist: 'X', title: 'Y' }, { artist: 'A', title: 'B' }, same)
        .replaced,
      0,
    );
  });

  it('ajoute à la fin en gardant les fins de ligne', () => {
    assert.deepEqual(addPlaylistEntry(UPL, { artist: 'Amir', title: 'Rétine' }, same), {
      text: `${UPL}Amir : Rétine\r\n`,
      changed: true,
    });
    assert.equal(
      addPlaylistEntry('#Name: X\nA : B', { artist: 'C', title: 'D' }, same).text,
      '#Name: X\nA : B\nC : D\n',
    );
  });

  it('n’ajoute pas une chanson déjà présente', () => {
    assert.deepEqual(addPlaylistEntry(UPL, { artist: 'ZAZIE', title: 'zen' }, same), {
      text: UPL,
      changed: false,
    });
  });

  it('retire toutes les lignes de la chanson, le reste intact', () => {
    const doubled = `${UPL}zazie : ZEN\r\n`;
    assert.deepEqual(removePlaylistEntry(doubled, { artist: 'Zazie', title: 'Zen' }, same), {
      text: '#Name: Top\r\n#Songs:\r\nDesireless : Voyage Voyage\r\n',
      removed: 2,
    });
    assert.equal(removePlaylistEntry(UPL, { artist: 'X', title: 'Y' }, same).removed, 0);
  });

  it('formate une ligne', () => {
    assert.equal(formatPlaylistEntry({ artist: ' Adé ', title: 'Insomnies ' }), 'Adé : Insomnies');
  });
});
