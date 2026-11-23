// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fadeFactor,
  formatTime,
  needsVideoResync,
  positionFromPointer,
  previewWindow,
  seekWindow,
  songFraction,
  videoMimeType,
  videoTimeFor,
} from '../../public/js/previewCore.js';

describe('previewWindow', () => {
  it('démarre au début demandé et dure 30 s', () => {
    assert.deepEqual(previewWindow(45, 200), { start: 45, end: 75 });
  });

  it('sans début connu, démarre à 30 % de la chanson', () => {
    assert.deepEqual(previewWindow(null, 200), { start: 60, end: 90 });
  });

  it('ne dépasse pas la fin du fichier', () => {
    assert.deepEqual(previewWindow(190, 200), { start: 190, end: 200 });
    assert.deepEqual(previewWindow(500, 200), { start: 195, end: 200 });
  });

  it('chanson courte : commence au début possible', () => {
    assert.deepEqual(previewWindow(null, 4), { start: 0, end: 4 });
  });

  it('durée inconnue : utilise le début demandé', () => {
    assert.deepEqual(previewWindow(12, Number.NaN), { start: 12, end: 42 });
    assert.deepEqual(previewWindow(null, Number.POSITIVE_INFINITY), { start: 0, end: 30 });
  });
});

describe('fadeFactor', () => {
  it('volume plein puis fondu sur les 2 dernières secondes', () => {
    assert.equal(fadeFactor(10, 75), 1);
    assert.equal(fadeFactor(74, 75), 0.5);
    assert.equal(fadeFactor(80, 75), 0);
  });
});

describe('songFraction — position dans la chanson entière', () => {
  it('fraction bornée, 0 si durée inconnue', () => {
    assert.equal(songFraction(57.5, 230), 0.25);
    assert.equal(songFraction(300, 230), 1);
    assert.equal(songFraction(10, Number.NaN), 0);
  });
});

describe('formatTime', () => {
  it('m:ss, h:mm:ss, valeurs invalides', () => {
    assert.equal(formatTime(62.9), '1:02');
    assert.equal(formatTime(227.97), '3:47');
    assert.equal(formatTime(3725), '1:02:05');
    assert.equal(formatTime(Number.NaN), '0:00');
  });
});

describe('seekWindow — nouvel extrait après un déplacement', () => {
  it('30 s à partir de la position, bornées à la chanson', () => {
    assert.deepEqual(seekWindow(120, 250), { start: 120, end: 150 });
    assert.deepEqual(seekWindow(240, 250), { start: 240, end: 250 });
    assert.deepEqual(seekWindow(-5, 250), { start: 0, end: 30 });
    assert.deepEqual(seekWindow(999, 250), { start: 249.5, end: 250 });
  });
});

describe('positionFromPointer', () => {
  it('convertit un clic en secondes', () => {
    const rect = { left: 100, width: 400 };
    assert.equal(positionFromPointer(200, rect, 240), 60);
    assert.equal(positionFromPointer(50, rect, 240), 0);
    assert.equal(positionFromPointer(900, rect, 240), 240);
    assert.equal(positionFromPointer(200, rect, Number.NaN), 0);
  });
});

describe('vidéo', () => {
  it('position vidéo = musique + #VIDEOGAP (comme UltraStar Deluxe)', () => {
    assert.equal(videoTimeFor(60, 0), 60);
    assert.equal(videoTimeFor(60, 0.5), 60.5);
    assert.equal(videoTimeFor(5, -10), -5, 'gap négatif : la vidéo n’a pas encore commencé');
  });

  it('recale seulement au-delà de la tolérance', () => {
    assert.equal(needsVideoResync(60.1, 60), false);
    assert.equal(needsVideoResync(61, 60), true);
  });

  it('formats lisibles par un navigateur', () => {
    assert.equal(videoMimeType('clip.MP4'), 'video/mp4');
    assert.equal(videoMimeType('clip.webm'), 'video/webm');
    assert.equal(videoMimeType('clip.avi'), null);
    assert.equal(videoMimeType('clip.mkv'), null);
    assert.equal(videoMimeType(null), null);
  });
});
