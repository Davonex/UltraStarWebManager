# UltraStarWebManager

Gestionnaire web de bibliothèque de chansons **UltraStar** (Node.js + Express + Bootstrap).

- **Phase 1** : catalogue avec pochettes, filtres (année, artiste, décennie, playlist), preview audio, gestion des playlists `.upl`.
- **Phase 2** : outils de correction et de modification en masse (avec simulation et sauvegarde).

## Prérequis

- Node.js **22.9 ou plus** (LTS conseillée)
- VS Code + extension **Biome** (`biomejs.biome`) recommandée

## Installation

```bash
npm install
copy .env.example .env   # puis adapter SONG_DIR et PLAYLIST_DIR
npm run dev              # redémarre automatiquement à chaque modification
```

Ouvrir <http://127.0.0.1:3000>.

## Scripts

| Commande           | Rôle                                           |
| ------------------ | ---------------------------------------------- |
| `npm start`        | Démarre le serveur                             |
| `npm run dev`      | Démarre avec rechargement automatique          |
| `npm test`         | Lance les tests (`node:test`, sans dépendance) |
| `npm run lint`     | Vérifie le code (lint + format) avec Biome     |
| `npm run lint:fix` | Corrige automatiquement ce qui peut l'être     |

## Arborescence

```
src/
  server.js        Démarrage du serveur uniquement
  app.js           Configuration Express (testable sans démarrer)
  config/          Lecture et validation du .env
  routes/          URL → contrôleur, rien d'autre
  controllers/     Lit la requête, appelle un service, répond
  services/        Logique métier (catalogue, playlists…)
  parsers/         Lecture des formats UltraStar — fonctions pures
  utils/           Petits utilitaires partagés
public/            Frontend : index.html, css/, js/ (modules ES, sans build)
test/              Tests, miroir de src/ ; fixtures/ = fichiers d'exemple
```

## API

| Méthode | URL                               | Réponse                                                                     |
| ------- | --------------------------------- | --------------------------------------------------------------------------- |
| GET     | `/api/health`                     | `{ status, version }`                                                       |
| GET     | `/api/songs`                      | `{ data: Song[], meta: { count, scannedAt, durationMs, skipped, errors } }` |
| GET     | `/api/songs/:id/cover`            | Image de pochette (cache navigateur 7 jours)                                |
| GET     | `/api/songs/:id/audio`            | Fichier audio, requêtes partielles (`Range`) acceptées                      |
| GET     | `/api/facet-images`               | Valeurs de facettes illustrées : `{ data: { language, decade, edition } }`  |
| GET     | `/api/facet-images/:facet/:value` | Image d'une catégorie (ex. `/language/French`)                              |

En cas d'erreur : `{ error: { code, message } }` (ex. `503 SONG_DIR_NOT_CONFIGURED`,
`503 CATALOG_UNAVAILABLE`). Le format d'une `Song` est décrit par le `@typedef Song` de
`src/services/catalogService.js`.

Le catalogue est construit au démarrage en parcourant `SONG_DIR` (lecture seule).
Chaque chanson porte une liste `warnings` : `{ code, message, params }` (message en anglais,
traduit dans l'interface via la clé `warnings.<CODE>`).

## Interface

Grille des chansons avec pochettes, filtrée et triée **dans le navigateur**. Barre de filtres
compacte (adaptée au mobile) : une recherche (artiste/titre, sans tenir compte des accents), puis
des pastilles **Langue, Décennie, Genre, Édition, Tags** qui ouvrent chacune une fenêtre de
choix multiples (tuiles avec le nombre de chansons), plus **Duos** et **Réinitialiser**.
Plusieurs valeurs d'une même facette se combinent en OU, des facettes différentes en ET.
Les filtres sont gardés dans l'URL (`?language=French&decade=1990&decade=1980`).

**Images des catégories** : si `CATEGORY_COVERS_DIR` pointe vers le dossier `covers` d'UltraStar
Deluxe, les tuiles Langue, Décennie et Édition affichent ses images (`Language/French.jpg`,
`Decade/1990.jpg`, `ABBA.jpg`…), sinon des initiales. Ce dossier est seulement lu, jamais copié
ni modifié.

**Preview audio** : bouton ▶ sur la pochette. Extrait de 30 s avec fondu de fin, qui démarre à
`#PREVIEWSTART`, sinon au début du medley (`#MEDLEYSTARTBEAT`), sinon à 30 % de la chanson.
Barre de lecture en bas (pause, arrêt, volume mémorisé) ; `Échap` arrête la lecture.

## Multilingue

L'interface est en **anglais** par défaut, puis dans la langue du navigateur si elle est
disponible (`en`, `fr`). Le sélecteur en haut à droite permet d'en changer ; le choix est
mémorisé dans le navigateur.

Traductions : `public/locales/<langue>.json` (`en.json` = référence). Le test
`test/public/locales.test.js` vérifie que toutes les langues ont les mêmes clés.

## Règles de code

1. **ESM** partout (`import`/`export`), `const` par défaut, `async/await`.
2. `// @ts-check` en tête de fichier + **JSDoc** sur les fonctions exportées : VS Code vérifie les types sans TypeScript.
3. Les **parsers** ne touchent jamais au disque : ils reçoivent un Buffer et renvoient un objet.
4. Toute écriture de fichier chanson/playlist : **sauvegarde + écriture atomique** (fichier temporaire puis renommage).
5. Tout nouveau parser ou service arrive **avec ses tests**.
6. `npm run lint && npm test` doivent passer avant chaque commit.
7. Messages de commit au format _Conventional Commits_ : `feat:`, `fix:`, `refactor:`, `test:`, `docs:`.
