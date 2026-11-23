// @ts-check
/**
 * Petit client HTTP de test : contrairement à fetch, il permet d'envoyer n'importe quel
 * en-tête (Host, Origin, Sec-Fetch-Site…) pour simuler un navigateur ou un attaquant.
 */
import http from 'node:http';

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string>, body?: unknown }} [options]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, json: any, text: string }>}
 */
export function request(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(path, baseUrl);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // réponse non JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Valeur « nom=valeur » du cookie de session posé par une réponse.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string}
 */
export function sessionCookie(headers) {
  const cookie = (headers['set-cookie'] ?? []).find((c) => c.startsWith('usm_session='));
  return cookie ? cookie.split(';')[0] : '';
}
