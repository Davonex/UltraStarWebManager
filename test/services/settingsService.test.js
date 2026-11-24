// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_NAMING } from '../../src/parsers/naming.js';
import { createSettings, validateSettings } from '../../src/services/settingsService.js';

const silentLogger = { info() {}, warn() {} };

describe('settingsService', () => {
  /** @type {string} */
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'usm-settings-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('fichier absent ou invalide : valeurs par défaut', async () => {
    const absent = createSettings({ file: path.join(dir, 'absent.json'), logger: silentLogger });
    assert.deepEqual((await absent.load()).naming, DEFAULT_NAMING);
    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, '{ pas du json');
    const store = createSettings({ file: broken, logger: silentLogger });
    assert.deepEqual((await store.load()).naming, DEFAULT_NAMING);
  });

  it('enregistre, relit, et complète les éléments manquants avec les valeurs par défaut', async () => {
    const file = path.join(dir, 'settings.json');
    const store = createSettings({ file, logger: silentLogger });
    await store.save({ naming: { cover: { enabled: false, pattern: ' {title} [CO] ' } } });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.naming.cover, { enabled: false, pattern: '{title} [CO]' });
    assert.deepEqual(saved.naming.folder, DEFAULT_NAMING.folder);
    const again = createSettings({ file, logger: silentLogger });
    assert.deepEqual((await again.load()).naming.cover, {
      enabled: false,
      pattern: '{title} [CO]',
    });
  });

  it('refuse un modèle invalide, avec l’élément et la raison ; rien n’est écrit', async () => {
    const file = path.join(dir, 'refus.json');
    const store = createSettings({ file, logger: silentLogger });
    await assert.rejects(store.save({ naming: { audio: { enabled: true, pattern: 'audio' } } }), {
      code: 'INVALID_SETTINGS',
      params: { kind: 'audio', reason: 'PATTERN_NO_PLACEHOLDER' },
    });
    await assert.rejects(readFile(file));
    assert.throws(() => validateSettings({}), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateSettings({ naming: { cover: { pattern: '{title}' } } }), {
      code: 'INVALID_REQUEST',
    });
  });
});
