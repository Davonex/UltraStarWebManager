# Normes de code — UltraStarWebManager

## Généralités

- **ESM uniquement** (`import` / `export`), extension `.js` explicite dans les imports relatifs.
- Modules Node importés avec le préfixe `node:` (`import fs from 'node:fs/promises'`).
- `const` par défaut, `let` si réassignation, jamais `var`.
- `async/await` partout ; pas de callbacks, pas de `.then()` chaînés, pas d'API synchrones
  (`readFileSync`…) hors script de démarrage.
- Égalité stricte (`===`), pas de `==`.
- Pas de valeurs magiques : constantes nommées en `UPPER_SNAKE_CASE` en haut du module.
- Fonctions courtes (≈ 30 lignes max), une seule responsabilité ; extraire sinon.
- Retour anticipé (`if (!x) return …`) plutôt que des `if` imbriqués.
- Pas de code mort ni de `console.log` de débogage laissé dans le code.
- Formatage : géré par **Biome** (2 espaces, guillemets simples, point-virgule, virgules
  finales, 100 colonnes). Ne pas formater à la main contre Biome.

## Nommage

| Élément               | Convention          | Exemple                                    |
| --------------------- | ------------------- | ------------------------------------------ |
| Fichiers JS           | camelCase           | `songService.js`                           |
| Fonctions / variables | camelCase           | `parseUltrastarTxt`                        |
| Classes               | PascalCase          | `CatalogIndex`                             |
| Constantes            | UPPER_SNAKE_CASE    | `MAX_YEAR`                                 |
| Booléens              | préfixe is/has/can  | `isDuet`, `hasEnd`                         |
| Routes API            | kebab-case, pluriel | `/api/songs`, `/api/playlists/:name/songs` |
| Fichiers de test      | `<module>.test.js`  | `ultrastarTxt.test.js`                     |

- Noms (variables, fonctions, fichiers) **en anglais**.
- **Commentaires et JSDoc en français.**
- **Textes d'interface : jamais en dur** → clés de traduction (voir « Internationalisation »).
- Journaux serveur (`console.*`) et messages d'erreur techniques de l'API : en anglais.

## Typage (sans TypeScript)

- Chaque fichier commence par `// @ts-check`.
- Toute fonction exportée a un bloc **JSDoc** : description, `@param`, `@returns`.
- Les structures de données partagées sont décrites par un `@typedef` dans le module qui les
  produit, puis réutilisées via `import('…').NomDuType`.
- Pas de `any` sauf justification en commentaire.

## Backend (Express)

- Les contrôleurs sont `async` ; les erreurs remontent au gestionnaire d'erreurs central
  (Express 5 transmet automatiquement les rejets de promesse).
- Réponses API toujours en **JSON** : `{ data: … }` en succès,
  `{ error: { code: "SONG_NOT_FOUND", message: "Song not found" } }` en échec, avec le bon code
  HTTP (400 entrée invalide, 404 introuvable, 409 conflit, 500 interne).
- `code` : identifiant stable en `UPPER_SNAKE_CASE`, traduit par l'interface via la clé
  `errors.<CODE>` ; `message` : texte anglais pour les journaux et le débogage.
- Tout nouveau code d'erreur est ajouté dans **toutes** les `public/locales/*.json`.
- Valider toutes les entrées (params, query, body) dans le contrôleur avant d'appeler le service.
- Avertissements sur les fichiers chanson : objets `{ code, message, params }` (code
  `UPPER_SNAKE_CASE`, message anglais), construits avec `songWarning()` ; chaque code a sa
  traduction `warnings.<CODE>` dans toutes les `public/locales/*.json`.
- Envoi de fichiers de la bibliothèque : `res.sendFile(nom, { root: dossierDeLaChanson })`, le
  dossier étant obtenu via `catalog.resolveSongFolder()` (protection path traversal).
- Jamais de détails techniques (stack, chemins absolus) dans les réponses au navigateur ;
  les journaliser côté serveur.
- `process.env` n'est lu que dans `src/config/`. Le reste reçoit la config en paramètre.
- Écoute par défaut sur `127.0.0.1`.

## Fichiers et disque

- Toujours `path.join` / `path.resolve`, jamais de concaténation de chemins.
- Gérer les noms de fichiers avec accents, espaces et majuscules (Windows est insensible à la
  casse : comparer les chemins en conséquence).
- Lecture des `.txt` en **Buffer**, décodage via `decodeSongBuffer` du parser.
- Écriture : sauvegarde `.bak` + fichier temporaire + `rename`, encodage d'origine conservé.
- Un fichier illisible ou mal formé est **journalisé et ignoré**, il ne fait jamais planter le
  scan de la bibliothèque.

## Frontend

- HTML + **Bootstrap 5** (classes utilitaires d'abord, CSS maison minimal dans `app.css`).
- JS natif en **modules ES** (`<script type="module">`), sans build ni bundler.
- Découpage : `api.js` (tous les `fetch`), logique pure testable sans DOM (`songFilters.js`,
  `i18nCore.js`), un module par zone d'interface (`songGrid.js`, `filtersView.js`,
  `player.js`…), `main.js` pour l'assemblage.
- Listes longues : rendu par pages au défilement (`IntersectionObserver`), jamais des
  milliers de cartes d'un coup.
- Construire le DOM avec `document.createElement` / `textContent`, ou des `<template>`.
  **Jamais `innerHTML` avec des données venant des fichiers chanson** (risque XSS).
- Délégation d'événements sur les conteneurs plutôt qu'un écouteur par carte.
- Images de pochettes en `loading="lazy"`, avec une image de remplacement si absente.
- Un seul élément `<audio>` partagé pour les previews.

## Internationalisation (i18n)

- Langue native : **anglais** (`en`). Langues disponibles : `en`, `fr`.
- Choix de la langue : choix enregistré (localStorage) → langues du navigateur → anglais.
  Changement possible à tout moment via le sélecteur de la barre de navigation.
- Traductions dans `public/locales/<langue>.json`, **arbre de clés** groupé par zone
  (`nav.*`, `filters.*`, `songs.*`, `errors.*`…), clés en camelCase.
- `en.json` est la **référence** : toute clé y est ajoutée d'abord, puis dans chaque autre
  langue, **dans le même commit**. Le test `test/public/locales.test.js` vérifie que toutes
  les langues ont les mêmes clés et les mêmes variables.
- HTML statique : texte anglais par défaut + attribut `data-i18n="cle"` (texte),
  `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label`.
- Contenu généré en JS : `t('cle', { variable })`, et re-rendu dans `onLanguageChange(...)`.
- Variables : `{nom}`. Pluriels : sous-clés `one` / `other` + `t('cle', { count })`
  (règles `Intl.PluralRules` : en français, 0 est au singulier).
- Nombres et dates : `Intl.NumberFormat` / `Intl.DateTimeFormat` avec `getLanguage()`,
  jamais de formatage manuel.
- **Ne jamais traduire les données des chansons** (titre, artiste, genre, langue de la chanson) :
  elles s'affichent telles qu'elles sont dans les fichiers.
- Les noms de langues du sélecteur sont écrits dans leur propre langue (`English`, `Français`).
- Ajouter une langue : l'ajouter à `SUPPORTED_LANGUAGES` et `LANGUAGE_NAMES`
  (`public/js/i18nCore.js`) + créer `public/locales/<code>.json`.

## Tests

- Framework : **`node:test`** + `node:assert/strict`. Aucune dépendance de test.
- Un fichier de test par module, dans `test/` en miroir de `src/`, nommé `*.test.js`
  (seuls ces fichiers sont lancés par `npm test`).
- Utilitaires de test partagés dans `test/helpers/` (ex. `createSongLibrary` pour fabriquer
  une bibliothèque UltraStar temporaire).
- Dépendances injectées (`createApp(config, { catalog })`) : les tests construisent leurs
  propres services au lieu de lire la configuration réelle.
- Noms de tests en français, décrivant le comportement attendu.
- Parsers : couvrir cas nominal, encodages (UTF-8, BOM, Windows-1252), CRLF, cas dégradés.
- Services touchant le disque : travailler dans un dossier temporaire (`fs.mkdtemp`) nettoyé
  dans `after()`.
- Corriger un bug = d'abord un test qui le reproduit.

## Sécurité

Couches en place (voir `src/middlewares/`) :

| Couche                                                          | Fichier                   | Protège contre     |
| --------------------------------------------------------------- | ------------------------- | ------------------ |
| En-têtes (CSP, X-Frame-Options…)                                | `securityHeaders.js`      | XSS, clickjacking  |
| Contrôle de l'en-tête Host                                      | `requestGuard.js`         | DNS rebinding      |
| `Sec-Fetch-Site` / `Origin` + `X-USM-Request` sur les écritures | `requestGuard.js`         | CSRF (autre site)  |
| Identification (cookie signé ou ce PC) + `requireRole`          | `auth.js`                 | Accès non autorisé |
| Limitation des tentatives de connexion                          | `services/authService.js` | Force brute        |

- Niveaux d'accès : `read` < `write` < `admin`. Toute nouvelle route déclare le sien.
- Écritures (POST/PUT/PATCH/DELETE) : corps JSON + en-tête `X-USM-Request: 1` (ajouté par
  `public/js/api.js`) ; validation stricte du corps dans le contrôleur.
- Le jeton de session n'est jamais lisible en JavaScript (cookie `HttpOnly`, `SameSite=Strict`).
- Comparaison de secrets uniquement à temps constant (`safeEqual`).
- Messages d'erreur : jamais de détail technique ni de chemin absolu vers le navigateur.
- Protection path traversal systématique (voir règle 4 de CLAUDE.md).
- Limiter la taille des corps JSON (`express.json({ limit })`).
- `app.disable('x-powered-by')`.
- Ne jamais exécuter de commande shell construite à partir de données utilisateur.
