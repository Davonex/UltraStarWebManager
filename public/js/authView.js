// @ts-check
/**
 * Connexion par clé d'accès : badge du rôle dans la barre, bouton de déconnexion,
 * fenêtre de connexion.
 * @module authView
 */
import { ApiError, login, logout } from './api.js';
import { t } from './i18n.js';

/** @typedef {import('./api.js').Role} Role */

/** Couleur du badge de chaque rôle. */
const ROLE_BADGES = Object.freeze({
  read: 'text-bg-secondary',
  write: 'text-bg-primary',
  admin: 'text-bg-danger',
});

/**
 * @param {object} elements
 * @param {HTMLElement} elements.badge          Badge du rôle (barre de navigation).
 * @param {HTMLButtonElement} elements.loginButton   Ouvre la connexion (passer en écriture/admin).
 * @param {HTMLButtonElement} elements.logoutButton
 * @param {HTMLElement} elements.modal          Fenêtre de connexion (.modal Bootstrap).
 */
export function createAuthView({ badge, loginButton, logoutButton, modal }) {
  const form = /** @type {HTMLFormElement} */ (modal.querySelector('form'));
  const keyInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('key'));
  const errorText = /** @type {HTMLElement} */ (modal.querySelector('.login-error'));
  const submit = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
  const closeButton = /** @type {HTMLButtonElement} */ (
    modal.querySelector('[data-bs-dismiss="modal"]')
  );
  const bootstrapModal = /** @type {any} */ (globalThis).bootstrap.Modal.getOrCreateInstance(
    modal,
    {
      backdrop: 'static',
      keyboard: false,
    },
  );

  /** @type {import('./api.js').AuthState} */
  let current = { role: null, isLocal: false, signedIn: false, hasKeys: false };
  /** @type {string | null} */
  let errorCode = null;

  function render() {
    const { role, isLocal, signedIn, hasKeys } = current;
    const isPublic = role !== null && !isLocal && !signedIn; // lecture ouverte à tous
    badge.hidden = role === null;
    if (role) {
      badge.className = `badge ${ROLE_BADGES[role]}`;
      badge.textContent = isLocal
        ? t('auth.localAdmin')
        : isPublic
          ? t('auth.publicRead')
          : t(`auth.roles.${role}`);
      badge.title = isLocal
        ? t('auth.localHint')
        : isPublic
          ? t('auth.publicHint')
          : t('auth.roleHint', { role: badge.textContent });
    }
    logoutButton.hidden = !signedIn || isLocal;
    loginButton.hidden = isLocal || signedIn || !hasKeys;
    closeButton.hidden = role === null; // sans aucun accès, la connexion est obligatoire
    errorText.hidden = errorCode === null;
    errorText.textContent = errorCode ? t(`errors.${errorCode}`) : '';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await login(keyInput.value);
      location.reload(); // recharge tout avec les nouveaux droits
    } catch (error) {
      errorCode = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      keyInput.select();
      render();
    } finally {
      submit.disabled = false;
    }
  });

  logoutButton.addEventListener('click', async () => {
    await logout().catch(console.error);
    location.reload();
  });

  loginButton.addEventListener('click', () => {
    errorCode = null;
    render();
    bootstrapModal.show();
  });

  modal.addEventListener('shown.bs.modal', () => keyInput.focus());

  return {
    /**
     * @param {import('./api.js').AuthState} state
     */
    setState(state) {
      current = state;
      render();
    },

    /**
     * Affiche la fenêtre de connexion (avec éventuellement un message d'erreur).
     * @param {string | null} [code]
     */
    showLogin(code = null) {
      errorCode = code;
      render();
      bootstrapModal.show();
    },

    /** Retraduit après un changement de langue. */
    refresh: render,
  };
}
