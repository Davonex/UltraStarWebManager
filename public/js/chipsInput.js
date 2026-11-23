// @ts-check
/**
 * Champ à pastilles : une liste de valeurs (éditions, tags…) affichées en pastilles,
 * avec une saisie qui propose les valeurs existantes (liste déroulante du navigateur)
 * ou accepte une nouvelle valeur.
 *
 * - Entrée ou virgule : ajoute la saisie ; × sur une pastille : la retire ;
 * - Retour arrière dans un champ vide : retire la dernière pastille.
 *
 * @module chipsInput
 */
import { t } from './i18n.js';

let datalistCount = 0;

/**
 * @param {HTMLElement} root  Conteneur (vidé puis rempli).
 * @param {object} options
 * @param {string[]} options.values       Valeurs initiales.
 * @param {string[]} options.suggestions  Valeurs existantes proposées.
 * @param {string} options.label          Nom accessible du champ.
 * @param {() => void} [options.onEnterEmpty]  Entrée dans une saisie vide (ex. enregistrer).
 * @param {() => void} [options.onEscape]      Échap (ex. annuler, sans fermer la fenêtre).
 */
export function createChipsInput(root, { values, suggestions, label, onEnterEmpty, onEscape }) {
  /** @type {string[]} */
  let current = [];
  const list = document.createElement('div');
  list.className = 'chips-input-list';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chips-input-field';
  input.autocomplete = 'off';
  input.placeholder = t('edit.placeholder');
  input.setAttribute('aria-label', label);
  const datalist = document.createElement('datalist');
  datalist.id = `chips-suggestions-${++datalistCount}`;
  input.setAttribute('list', datalist.id);
  root.classList.add('chips-input');
  root.replaceChildren(list, input, datalist);

  /** @param {string} value */
  const keyOf = (value) => value.trim().toLocaleLowerCase();

  function render() {
    list.replaceChildren(
      ...current.map((value) => {
        const chip = document.createElement('span');
        chip.className = 'chips-input-chip';
        chip.append(value);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chips-input-remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', t('edit.remove', { value }));
        // Garde le focus dans la saisie : sinon sa perte de focus redessine les pastilles
        // avant le clic, et le clic est perdu.
        remove.addEventListener('mousedown', (event) => event.preventDefault());
        remove.addEventListener('click', () => {
          current = current.filter((v) => v !== value);
          render();
          input.focus();
        });
        chip.append(remove);
        return chip;
      }),
    );
    const taken = new Set(current.map(keyOf));
    datalist.replaceChildren(
      ...suggestions
        .filter((s) => !taken.has(keyOf(s)))
        .map((s) => {
          const option = document.createElement('option');
          option.value = s;
          return option;
        }),
    );
  }

  /** Ajoute la saisie en cours (plusieurs valeurs possibles, séparées par des virgules). */
  function commit() {
    if (input.value.trim() === '') {
      input.value = '';
      return;
    }
    for (const part of input.value.split(',')) {
      const value = part.trim().replace(/\s+/g, ' ');
      if (!value || current.some((v) => keyOf(v) === keyOf(value))) continue;
      // Reprend l'écriture existante (« love song » → « Love Song » si elle existe déjà).
      current.push(suggestions.find((s) => keyOf(s) === keyOf(value)) ?? value);
    }
    input.value = '';
    render();
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.value.trim() === '' && onEnterEmpty) {
      event.preventDefault();
      onEnterEmpty();
    } else if (event.key === 'Escape' && onEscape) {
      event.preventDefault();
      event.stopPropagation(); // Échap annule la saisie sans fermer la fenêtre
      onEscape();
    } else if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && input.value === '' && current.length > 0) {
      current.pop();
      render();
    }
  });
  // Choix dans la liste déroulante : ajouté directement.
  input.addEventListener('input', (event) => {
    const isPick = /** @type {InputEvent} */ (event).inputType === 'insertReplacementText';
    if (isPick || suggestions.includes(input.value)) commit();
  });
  input.addEventListener('blur', commit);

  current = [...values];
  render();

  return {
    /** @returns {string[]} Valeurs (y compris une saisie non validée). */
    getValues() {
      commit();
      return [...current];
    },
    focus() {
      input.focus();
    },
  };
}
