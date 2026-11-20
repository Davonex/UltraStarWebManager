// @ts-check
/**
 * Vérifie la cohérence des fichiers de traduction : toutes les langues
 * doivent avoir exactement les mêmes clés et les mêmes variables {…}.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  DEFAULT_LANGUAGE,
  flattenKeys,
  lookup,
  SUPPORTED_LANGUAGES,
} from '../../public/js/i18nCore.js';

/** @param {string} language */
const loadLocale = async (language) =>
  JSON.parse(
    await readFile(new URL(`../../public/locales/${language}.json`, import.meta.url), 'utf8'),
  );

/** @param {string} text */
const variablesOf = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('fichiers de langue', async () => {
  const reference = await loadLocale(DEFAULT_LANGUAGE);
  const referenceKeys = flattenKeys(reference).sort();

  for (const language of SUPPORTED_LANGUAGES) {
    const messages = await loadLocale(language);

    it(`${language}.json a les mêmes clés que ${DEFAULT_LANGUAGE}.json`, () => {
      assert.deepEqual(flattenKeys(messages).sort(), referenceKeys);
    });

    it(`${language}.json : aucun texte vide et mêmes variables`, () => {
      for (const key of referenceKeys) {
        const value = /** @type {string} */ (lookup(messages, key));
        assert.ok(value.trim() !== '', `Texte vide : ${key}`);
        assert.deepEqual(
          variablesOf(value),
          variablesOf(/** @type {string} */ (lookup(reference, key))),
          `Variables différentes : ${key}`,
        );
      }
    });
  }
});
