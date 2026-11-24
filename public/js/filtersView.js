// @ts-check
/**
 * Barre de filtres compacte (adaptée au mobile) :
 * - une recherche, puis une « pastille » par facette (Langue, Décennie…) ;
 * - un clic sur une pastille ouvre une fenêtre avec les valeurs en tuiles, à choix multiples,
 *   chacune avec son nombre de chansons. Le résultat se met à jour à chaque clic.
 *
 * La fenêtre utilise le composant Modal de Bootstrap (bootstrap.bundle.min.js).
 *
 * @module filtersView
 */
import { t } from './i18n.js';
import { ANY_WARNING, defaultCriteria, normalizeText, toggleFacetValue } from './songFilters.js';
import { warningIcon } from './warningIcons.js';

const ICONS = '/img/vendor/bootstrap-icons/icons.svg';

/** Délai avant de filtrer pendant la frappe (ms). */
const SEARCH_DEBOUNCE_MS = 150;
/** Au-delà de ce nombre de valeurs, une recherche est proposée dans la fenêtre. */
const SEARCH_THRESHOLD = 12;

/** @typedef {import('./songFilters.js').FilterCriteria} FilterCriteria */
/** @typedef {import('./songFilters.js').FacetKey} FacetKey */
/** @typedef {import('./songFilters.js').FacetOption} FacetOption */

/** Clé de traduction du titre de chaque facette. */
const FACET_LABEL_KEYS = Object.freeze({
  language: 'filters.language',
  decade: 'filters.decade',
  genre: 'filters.genre',
  edition: 'filters.edition',
  tag: 'filters.tag',
  playlist: 'filters.playlist',
  warning: 'filters.withWarnings',
});

/** Facettes dont les tuiles ont une vignette (image ou initiales). */
const IMAGE_FACETS = new Set(['language', 'decade', 'edition', 'tag', 'playlist']);
/** Un mot court s'affiche en entier dans la vignette (« OTHER »), sinon ses initiales. */
const SHORT_WORD_LENGTH = 5;

/**
 * Texte de remplacement d'une vignette sans image : « Breton » → « BR », « Other » → « OTHER »,
 * « Alain Souchon » → « AS ».
 * @param {string} label
 * @returns {string}
 */
export function placeholderText(label) {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length > 1)
    return words
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  const [word] = words;
  return (word.length <= SHORT_WORD_LENGTH ? word : word.slice(0, 2)).toUpperCase();
}

/**
 * Libellé affiché pour une valeur de facette.
 * @param {FacetKey} key
 * @param {string} value
 * @returns {string}
 */
function valueLabel(key, value) {
  if (key === 'decade') return t('filters.decadeLabel', { decade: value });
  if (key === 'warning') return warningLabel(value);
  return value;
}

/**
 * Libellé d'un type d'avertissement (« MISSING_HEADER:YEAR » → « En-tête #YEAR manquant »).
 * @param {string} type
 */
function warningLabel(type) {
  if (type === ANY_WARNING) return t('filters.allWarnings');
  const [code, param] = type.split(':');
  const params = { header: param ?? '', kind: param ? t(`details.${param}`) : '' };
  const key = `warningTypes.${code}`;
  const text = t(key, params);
  return text === key ? code : text;
}

/**
 * @param {object} elements
 * @param {HTMLFormElement} elements.form
 * @param {HTMLElement} elements.modal   Élément .modal de Bootstrap.
 * @param {object} handlers
 * @param {(criteria: FilterCriteria) => void} handlers.onChange
 * @param {(key: FacetKey) => FacetOption[]} handlers.getFacetOptions
 * @param {(key: FacetKey, value: string) => string | null} handlers.getImageUrl
 *   URL de l'image d'une valeur, ou null s'il n'y en a pas.
 * @param {(key: FacetKey, value: string) => string[]} [handlers.getMosaicUrls]
 *   Pochettes d'une mosaïque (playlists) ; liste vide = pas de mosaïque.
 */
export function createFiltersView(
  { form, modal },
  { onChange, getFacetOptions, getImageUrl, getMosaicUrls = () => [] },
) {
  /** @param {ParentNode} root @param {string} selector */
  const $ = (root, selector) => /** @type {HTMLElement} */ (root.querySelector(selector));

  const search = /** @type {HTMLInputElement} */ (form.elements.namedItem('q'));
  const sortButton = $(form, '[data-action="sort"]');
  const sortLabel = $(sortButton, '.sort-label');
  const sortItems = /** @type {HTMLElement[]} */ ([...form.querySelectorAll('[data-sort]')]);
  const duetChip = $(form, '[data-action="duet"]');
  const resetChip = $(form, '[data-action="reset"]');
  const facetChips = /** @type {HTMLElement[]} */ ([...form.querySelectorAll('[data-facet]')]);

  const modalTitle = $(modal, '.modal-title');
  const modalSearch = /** @type {HTMLInputElement} */ ($(modal, 'input[type="search"]'));
  const optionsGrid = $(modal, '.facet-options');
  const showResults = $(modal, '[data-action="show-results"]');
  const clearFacet = /** @type {HTMLButtonElement} */ ($(modal, '[data-action="clear-facet"]'));
  const bootstrapModal = /** @type {any} */ (globalThis).bootstrap.Modal.getOrCreateInstance(modal);

  let criteria = defaultCriteria();
  let resultCount = 0;
  /** @type {FacetKey | null} */
  let openFacet = null;

  /** @param {FilterCriteria} next */
  const emit = (next) => onChange(next);

  // --- Barre de filtres ---------------------------------------------------------------

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounceTimer;
  form.addEventListener('submit', (event) => event.preventDefault());
  search.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => emit({ ...criteria, q: search.value }), SEARCH_DEBOUNCE_MS);
  });
  for (const item of sortItems) {
    item.addEventListener('click', () => {
      emit({ ...criteria, sort: /** @type {FilterCriteria['sort']} */ (item.dataset.sort) });
    });
  }
  duetChip.addEventListener('click', () => emit({ ...criteria, duet: !criteria.duet }));
  resetChip.addEventListener('click', () => emit({ ...defaultCriteria(), sort: criteria.sort }));
  for (const chip of facetChips) {
    chip.addEventListener('click', () => {
      openFacet = /** @type {FacetKey} */ (chip.dataset.facet);
      modalSearch.value = '';
      renderModal();
      bootstrapModal.show();
    });
  }

  function renderChips() {
    search.value = criteria.q;
    for (const item of sortItems) {
      const current = item.dataset.sort === criteria.sort;
      item.classList.toggle('active', current);
      if (current) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
      if (current) sortLabel.textContent = item.textContent?.trim() ?? '';
    }
    for (const chip of facetChips) {
      const key = /** @type {FacetKey} */ (chip.dataset.facet);
      const count = criteria[key].length;
      const badge = $(chip, '.facet-chip-count');
      badge.textContent = String(count);
      badge.hidden = count === 0;
      chip.classList.toggle('active', count > 0);
      chip.setAttribute('aria-pressed', String(count > 0));
    }
    duetChip.classList.toggle('active', criteria.duet);
    duetChip.setAttribute('aria-pressed', String(criteria.duet));
    const active =
      criteria.q.trim() !== '' ||
      criteria.duet ||
      facetChips.some((c) => c.classList.contains('active'));
    resetChip.hidden = !active;
  }

  // --- Fenêtre de choix ---------------------------------------------------------------

  /**
   * @param {FacetKey} key
   * @param {FacetOption} option
   * @returns {HTMLElement}
   */
  function createOption(key, option) {
    const col = document.createElement('div');
    col.className = 'col';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'facet-option';
    button.dataset.value = option.value;
    button.setAttribute('aria-pressed', String(option.selected));
    if (option.count === 0 && !option.selected) button.classList.add('is-empty');

    const label = document.createElement('span');
    label.className = 'facet-option-label';
    label.textContent = valueLabel(key, option.value);
    // Avertissements : icône du type devant le libellé (monochrome, couleur du texte).
    if (key === 'warning') label.prepend(warningIconElement(option.value));
    if (IMAGE_FACETS.has(key)) button.append(createThumbnail(key, option.value, label.textContent));
    const count = document.createElement('span');
    count.className = 'facet-option-count';
    count.textContent = option.count.toLocaleString();
    button.append(label, count);
    col.append(button);
    return col;
  }

  /**
   * @param {string} type  Type d'avertissement (« MISSING_END », « NAMING »…).
   * @returns {SVGSVGElement}
   */
  function warningIconElement(type) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'bi me-2 flex-shrink-0');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `${ICONS}#${warningIcon(type)}`);
    svg.append(use);
    return svg;
  }

  /**
   * Vignette d'une tuile : image d'UltraStar, ou initiales si elle n'existe pas.
   * @param {FacetKey} key
   * @param {string} value
   * @param {string} label
   * @returns {HTMLElement}
   */
  function createThumbnail(key, value, label) {
    const placeholder = document.createElement('span');
    placeholder.className = 'facet-option-thumb facet-option-placeholder';
    placeholder.textContent = placeholderText(key === 'decade' ? value : label);
    placeholder.setAttribute('aria-hidden', 'true');

    // Playlist : mosaïque 2 × 2 des pochettes de ses premières chansons.
    const covers = getMosaicUrls(key, value);
    if (covers.length > 0) {
      const mosaic = document.createElement('span');
      mosaic.className = `facet-option-thumb facet-option-mosaic is-${covers.length}`;
      mosaic.setAttribute('aria-hidden', 'true');
      for (const src of covers) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = src;
        mosaic.append(img);
      }
      return mosaic;
    }

    const url = getImageUrl(key, value);
    if (!url) return placeholder;
    const img = document.createElement('img');
    img.className = 'facet-option-thumb';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => img.replaceWith(placeholder), { once: true });
    img.src = url;
    return img;
  }

  function renderModal() {
    if (!openFacet) return;
    const key = openFacet;
    const options = getFacetOptions(key);
    modalTitle.textContent = t(FACET_LABEL_KEYS[key]);
    modalSearch.hidden = options.length <= SEARCH_THRESHOLD;
    modalSearch.placeholder = t('filters.searchIn', { facet: modalTitle.textContent });

    const query = normalizeText(modalSearch.value);
    const visible = query
      ? options.filter((o) => o.selected || normalizeText(valueLabel(key, o.value)).includes(query))
      : options;

    const focusedValue = /** @type {HTMLElement | null} */ (
      document.activeElement?.closest('.facet-option') ?? null
    )?.dataset.value;

    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'col-12 text-body-secondary';
      empty.textContent = t('filters.noOptions');
      optionsGrid.replaceChildren(empty);
    } else {
      optionsGrid.replaceChildren(...visible.map((option) => createOption(key, option)));
    }

    // Garde le focus clavier sur la tuile cliquée après le nouveau rendu.
    if (focusedValue !== undefined) {
      const again = [...optionsGrid.querySelectorAll('.facet-option')].find(
        (el) => /** @type {HTMLElement} */ (el).dataset.value === focusedValue,
      );
      /** @type {HTMLElement | undefined} */ (again)?.focus();
    }

    const selectedCount = criteria[key].length;
    clearFacet.disabled = selectedCount === 0;
    showResults.textContent = t('filters.showResults', { count: resultCount });
  }

  optionsGrid.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('.facet-option');
    if (!(button instanceof HTMLElement) || !openFacet || button.dataset.value === undefined)
      return;
    emit(toggleFacetValue(criteria, openFacet, button.dataset.value));
  });
  modalSearch.addEventListener('input', renderModal);
  clearFacet.addEventListener('click', () => {
    if (!openFacet) return;
    emit({ ...criteria, [openFacet]: [] });
    // Le bouton se désactive : on garde le focus dans la fenêtre (sinon Échap ne la ferme plus).
    (modalSearch.hidden ? modal : modalSearch).focus();
  });
  modal.addEventListener('shown.bs.modal', () => {
    if (!modalSearch.hidden) modalSearch.focus();
  });
  modal.addEventListener('hidden.bs.modal', () => {
    openFacet = null;
  });

  return {
    /**
     * Met à jour l'affichage (pastilles, fenêtre ouverte) après un changement de critères.
     * @param {FilterCriteria} nextCriteria
     * @param {number} count  Nombre de chansons affichées.
     */
    update(nextCriteria, count) {
      criteria = nextCriteria;
      resultCount = count;
      renderChips();
      renderModal();
    },

    /** Indique si la fenêtre de choix est ouverte. */
    isOpen() {
      return openFacet !== null;
    },
  };
}
