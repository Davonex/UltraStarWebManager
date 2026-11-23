// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config/index.js';
import { readCookie } from '../../src/middlewares/auth.js';
import { allowedHostnames, hostnameOf } from '../../src/middlewares/requestGuard.js';

const fakeSystem = {
  hostname: () => 'RAGNAROK',
  networkInterfaces: () =>
    /** @type {any} */ ({
      eth0: [{ address: '192.168.1.20' }, { address: 'fe80::1' }],
      lo: [{ address: '127.0.0.1' }],
    }),
};

describe('hostnameOf', () => {
  it('retire le port et les crochets IPv6', () => {
    assert.equal(hostnameOf('PC.local:3000'), 'pc.local');
    assert.equal(hostnameOf('[::1]:3000'), '::1');
    assert.equal(hostnameOf('127.0.0.1'), '127.0.0.1');
    assert.equal(hostnameOf(undefined), '');
  });
});

describe('allowedHostnames', () => {
  it('sur ce PC uniquement : localhost + ALLOWED_HOSTS', () => {
    const names = allowedHostnames(loadConfig({ ALLOWED_HOSTS: 'karaoke.lan' }), fakeSystem);
    assert.deepEqual([...names].sort(), ['127.0.0.1', '::1', 'karaoke.lan', 'localhost']);
  });

  it('ouvert au réseau : ajoute le nom et les adresses de la machine', () => {
    const names = allowedHostnames(
      loadConfig({ HOST: '0.0.0.0', READ_KEY: 'lecture-123456' }),
      fakeSystem,
    );
    for (const name of ['ragnarok', 'ragnarok.local', '192.168.1.20', 'fe80::1', 'localhost']) {
      assert.ok(names.has(name), name);
    }
  });
});

describe('readCookie', () => {
  it('lit un cookie parmi d’autres', () => {
    assert.equal(readCookie('a=1; usm_session=abc.def; b=2', 'usm_session'), 'abc.def');
    assert.equal(readCookie('a=1', 'usm_session'), undefined);
    assert.equal(readCookie(undefined, 'usm_session'), undefined);
    assert.equal(readCookie('usm_session=%E0%A4%A', 'usm_session'), undefined);
  });
});
