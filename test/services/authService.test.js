// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTEMPT_WINDOW_MS,
  createAuth,
  hasRole,
  MAX_FAILED_ATTEMPTS,
} from '../../src/services/authService.js';

const KEYS = { read: 'lecture-123456', write: 'ecriture-123456', admin: 'admin-1234567' };

/** Horloge contrôlable. */
function fakeClock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (/** @type {number} */ ms) => (time += ms) };
}

describe('hasRole', () => {
  it('chaque niveau inclut les précédents', () => {
    assert.equal(hasRole('admin', 'read'), true);
    assert.equal(hasRole('write', 'write'), true);
    assert.equal(hasRole('read', 'write'), false);
    assert.equal(hasRole('write', 'admin'), false);
    assert.equal(hasRole(null, 'read'), false);
  });
});

describe('authService — clés', () => {
  const auth = createAuth({ accessKeys: KEYS, sessionDays: 30 });

  it('trouve le rôle de chaque clé, null sinon', () => {
    assert.equal(auth.roleForKey('lecture-123456'), 'read');
    assert.equal(auth.roleForKey('ecriture-123456'), 'write');
    assert.equal(auth.roleForKey('admin-1234567'), 'admin');
    assert.equal(auth.roleForKey('lecture-12345'), null);
    assert.equal(auth.roleForKey(''), null);
  });

  it('hasKeys', () => {
    assert.equal(auth.hasKeys(), true);
    assert.equal(
      createAuth({
        accessKeys: { read: null, write: null, admin: null },
        sessionDays: 1,
      }).hasKeys(),
      false,
    );
  });
});

describe('authService — sessions', () => {
  it('un jeton valide redonne son rôle', () => {
    const auth = createAuth({ accessKeys: KEYS, sessionDays: 30 });
    const { token, maxAgeMs } = auth.createSession('write');
    assert.equal(auth.verifySession(token), 'write');
    assert.equal(maxAgeMs, 30 * 24 * 60 * 60 * 1000);
  });

  it('refuse un jeton modifié (élévation de rôle) ou mal formé', () => {
    const auth = createAuth({ accessKeys: KEYS, sessionDays: 30 });
    const { token } = auth.createSession('read');
    assert.equal(auth.verifySession(token.replace(/^read/, 'admin')), null);
    assert.equal(auth.verifySession(`${token}x`), null);
    assert.equal(auth.verifySession('admin.9999999999999.abc'), null);
    assert.equal(auth.verifySession(undefined), null);
  });

  it('refuse un jeton expiré', () => {
    const clock = fakeClock();
    const auth = createAuth({ accessKeys: KEYS, sessionDays: 1, now: clock.now });
    const { token } = auth.createSession('read');
    clock.advance(24 * 60 * 60 * 1000 + 1);
    assert.equal(auth.verifySession(token), null);
  });

  it('changer une clé invalide les sessions existantes', () => {
    const { token } = createAuth({ accessKeys: KEYS, sessionDays: 30 }).createSession('admin');
    const changed = createAuth({
      accessKeys: { ...KEYS, admin: 'nouvelle-cle-admin' },
      sessionDays: 30,
    });
    assert.equal(changed.verifySession(token), null);
  });

  it('un redémarrage (nouvelle instance, mêmes clés) garde les sessions', () => {
    const { token } = createAuth({ accessKeys: KEYS, sessionDays: 30 }).createSession('read');
    assert.equal(createAuth({ accessKeys: KEYS, sessionDays: 30 }).verifySession(token), 'read');
  });
});

describe('authService — anti force brute', () => {
  it(`bloque après ${MAX_FAILED_ATTEMPTS} échecs, débloque après la fenêtre`, () => {
    const clock = fakeClock();
    const auth = createAuth({ accessKeys: KEYS, sessionDays: 1, now: clock.now });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      assert.equal(auth.isBlocked('10.0.0.5'), false);
      auth.recordFailure('10.0.0.5');
    }
    assert.equal(auth.isBlocked('10.0.0.5'), true);
    assert.equal(auth.isBlocked('10.0.0.6'), false, 'les autres adresses ne sont pas touchées');
    clock.advance(ATTEMPT_WINDOW_MS + 1);
    assert.equal(auth.isBlocked('10.0.0.5'), false);
  });

  it('une connexion réussie remet le compteur à zéro', () => {
    const auth = createAuth({ accessKeys: KEYS, sessionDays: 1 });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) auth.recordFailure('10.0.0.7');
    auth.clearFailures('10.0.0.7');
    auth.recordFailure('10.0.0.7');
    assert.equal(auth.isBlocked('10.0.0.7'), false);
  });
});
