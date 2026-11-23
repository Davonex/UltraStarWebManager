// @ts-check
/**
 * Contrôles des requêtes entrantes :
 * - en-tête Host autorisé (empêche le « DNS rebinding » : un site malveillant qui se fait
 *   passer pour localhost) ;
 * - API appelée uniquement par l'interface elle-même (empêche le CSRF : un autre site ouvert
 *   dans le navigateur ne peut pas utiliser l'API).
 *
 * @module middlewares/requestGuard
 */
import os from 'node:os';
import { isLoopbackHost } from '../config/index.js';

/** En-tête obligatoire sur les requêtes d'écriture (un formulaire ou un autre site ne peut pas l'envoyer). */
export const CLIENT_HEADER = 'x-usm-request';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Valeurs de Sec-Fetch-Site acceptées sur l'API : notre page, ou une URL tapée à la main. */
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function reject(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

/**
 * Nom d'hôte d'un en-tête Host (« [::1]:3000 » → « ::1 », « PC.local:3000 » → « pc.local »).
 * @param {string | undefined} hostHeader
 * @returns {string}
 */
export function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
  return value.split(':')[0];
}

/**
 * Noms d'hôte acceptés : ce PC, ceux de ALLOWED_HOSTS et, si le serveur est ouvert au réseau,
 * le nom et les adresses IP de la machine.
 *
 * @param {Readonly<import('../config/index.js').AppConfig>} config
 * @param {{ hostname: () => string, networkInterfaces: typeof os.networkInterfaces }} [system]
 * @returns {Set<string>}
 */
export function allowedHostnames(config, system = os) {
  const names = new Set(['127.0.0.1', 'localhost', '::1', ...config.allowedHosts]);
  if (!isLoopbackHost(config.host)) {
    const name = system.hostname().toLowerCase();
    names.add(name);
    names.add(`${name}.local`);
    for (const addresses of Object.values(system.networkInterfaces())) {
      for (const { address } of addresses ?? []) names.add(address.toLowerCase());
    }
    if (config.host !== '0.0.0.0' && config.host !== '::') names.add(config.host.toLowerCase());
  }
  return names;
}

/**
 * Refuse les requêtes dont l'en-tête Host n'est pas reconnu.
 * @param {Set<string>} allowed
 * @returns {import('express').RequestHandler}
 */
export function createHostGuard(allowed) {
  return (req, res, next) => {
    if (allowed.has(hostnameOf(req.headers.host))) {
      next();
      return;
    }
    reject(res, 403, 'HOST_NOT_ALLOWED', 'Host not allowed (add it to ALLOWED_HOSTS)');
  };
}

/**
 * Réserve l'API à l'interface de l'application :
 * - refuse les requêtes envoyées depuis un autre site (Sec-Fetch-Site, Origin) ;
 * - pour les écritures, exige JSON + l'en-tête X-USM-Request.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function apiGuard(req, res, next) {
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    reject(res, 403, 'CROSS_ORIGIN_REQUEST', 'Requests from other sites are not allowed');
    return;
  }
  const origin = req.get('origin');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      // Origin invalide : traité comme étranger
    }
    if (originHost !== (req.headers.host ?? '').toLowerCase()) {
      reject(res, 403, 'CROSS_ORIGIN_REQUEST', 'Requests from other sites are not allowed');
      return;
    }
  }
  if (!SAFE_METHODS.has(req.method)) {
    if (req.get(CLIENT_HEADER) !== '1') {
      reject(res, 403, 'CLIENT_HEADER_REQUIRED', `Missing ${CLIENT_HEADER} header`);
      return;
    }
    if (!req.is('application/json')) {
      reject(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON body required');
      return;
    }
  }
  next();
}
