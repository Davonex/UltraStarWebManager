// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLoopbackHost, loadConfig } from '../../src/config/index.js';

const KEY_R = 'lecture-123456';
const KEY_W = 'ecriture-123456';

describe('loadConfig', () => {
  it('valeurs par défaut : écoute sur ce PC, sans clé, localhost de confiance', () => {
    const config = loadConfig({});
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3000);
    assert.deepEqual(config.accessKeys, { read: null, write: null, admin: null });
    assert.equal(config.trustLocalhost, true);
    assert.equal(config.sessionDays, 30);
  });

  it('lit les clés, les hôtes autorisés et TRUST_LOCALHOST', () => {
    const config = loadConfig({
      READ_KEY: KEY_R,
      WRITE_KEY: KEY_W,
      ALLOWED_HOSTS: ' Karaoke.local , 192.168.1.20 ',
      TRUST_LOCALHOST: 'false',
    });
    assert.deepEqual(config.accessKeys, { read: KEY_R, write: KEY_W, admin: null });
    assert.deepEqual(config.allowedHosts, ['karaoke.local', '192.168.1.20']);
    assert.equal(config.trustLocalhost, false);
  });

  it('refuse d’ouvrir au réseau sans clé', () => {
    assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /WRITE_KEY or ADMIN_KEY/);
    assert.doesNotThrow(() => loadConfig({ HOST: '0.0.0.0', READ_KEY: KEY_R }));
    assert.doesNotThrow(() => loadConfig({ HOST: '0.0.0.0', WRITE_KEY: KEY_W }));
  });

  it('READ_KEY vide : lecture publique', () => {
    assert.equal(loadConfig({ WRITE_KEY: KEY_W }).publicRead, true);
    assert.equal(loadConfig({ READ_KEY: KEY_R }).publicRead, false);
  });

  it('refuse une clé trop courte ou deux clés identiques', () => {
    assert.throws(() => loadConfig({ READ_KEY: 'court' }), /at least 12/);
    assert.throws(() => loadConfig({ READ_KEY: KEY_R, ADMIN_KEY: KEY_R }), /different/);
  });

  it('refuse un port ou une durée de session invalides', () => {
    assert.throws(() => loadConfig({ PORT: '99999' }), /PORT/);
    assert.throws(() => loadConfig({ SESSION_DAYS: '0' }), /SESSION_DAYS/);
  });
});

describe('isLoopbackHost', () => {
  it('reconnaît les adresses de ce PC', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
      assert.equal(isLoopbackHost(host), true, host);
    }
    assert.equal(isLoopbackHost('0.0.0.0'), false);
    assert.equal(isLoopbackHost('192.168.1.20'), false);
  });
});
