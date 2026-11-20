// @ts-check
/**
 * Protection contre la sortie d'un dossier racine (path traversal).
 * @module utils/safePath
 */
import path from 'node:path';

/**
 * Résout `relativePath` à l'intérieur de `root`.
 * Renvoie le chemin absolu, ou `null` si le résultat sortirait de `root`
 * (`..`, chemin absolu, autre lecteur Windows…).
 *
 * @param {string} root
 * @param {string} relativePath
 * @returns {string | null}
 */
export function resolveInside(root, relativePath) {
  const base = path.resolve(root);
  const target = path.resolve(base, relativePath);
  const relative = path.relative(base, target);
  if (relative === '') return target;
  const escapes = path.isAbsolute(relative) || relative.split(path.sep)[0] === '..';
  return escapes ? null : target;
}
