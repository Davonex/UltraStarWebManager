# UltraStarWebManager — consignes pour Claude

Outil web local (Node.js + Express 5 + Bootstrap 5) pour gérer une bibliothèque de chansons
**UltraStar** : catalogue avec pochettes, filtres, preview audio, playlists `.upl`.
Phase 2 : corrections et modifications en masse des fichiers chanson.

- Utilisateur : Davo (Didier MATHIEU). **Réponds et commente le code en français.**
- L'interface est **multilingue, anglais par défaut** (puis langue du navigateur si disponible,
  modifiable dans l'interface). Langues : `en`, `fr`. Aucun texte d'interface en dur : toujours
  une clé dans `public/locales/*.json` (voir normes, section i18n).
- Il connaît bien JS, Bootstrap et Express. Il veut un code **lisible avant tout**, avec un
  minimum de dépendances. Explique brièvement tes choix quand ils ne sont pas évidents.
- Cible d'exécution : **PC Windows**, Node ≥ 22.9. Chemins Windows possibles dans `.env`.

## Commandes

| Commande           | Rôle                                  |
| ------------------ | ------------------------------------- |
| `npm run dev`      | Serveur avec rechargement automatique |
| `npm test`         | Tests (`node:test`)                   |
| `npm run lint`     | Biome : lint + format (vérification)  |
| `npm run lint:fix` | Biome : corrections automatiques      |

**Une tâche n'est terminée que si `npm run lint` et `npm test` passent.** Lance-les avant de
conclure et signale tout échec plutôt que de le masquer.

## Architecture (à respecter)

```
src/server.js      démarrage uniquement
src/app.js         construction Express (testable sans écoute réseau)
src/config/        lecture/validation du .env — seul endroit qui lit process.env
src/routes/        URL → contrôleur, aucune logique
src/controllers/   lit la requête, valide, appelle un service, répond (JSON)
src/services/      logique métier, accès disque
src/parsers/       formats UltraStar — FONCTIONS PURES, jamais d'accès disque
src/utils/         petits utilitaires génériques
public/            frontend : HTML + Bootstrap + modules ES natifs, SANS build
public/locales/    traductions (en.json = référence, fr.json)
test/              miroir de src/ ; test/fixtures/ = fichiers d'exemple
```

Sens des dépendances : routes → controllers → services → parsers/utils. Jamais l'inverse.

Dossiers `samplesongs/` et `sampleplaylists/` : bibliothèque d'exemple de l'utilisateur, à
utiliser en **lecture seule** pour des essais manuels (ex. `SONG_DIR=./samplesongs`). Ignorés
par git (fichiers protégés par le droit d'auteur) : ne jamais les versionner ni les copier dans
`test/fixtures/`.

## Règles impératives

1. **Ne jamais modifier, déplacer ou supprimer un fichier de la bibliothèque de l'utilisateur**
   (`SONG_DIR`, `PLAYLIST_DIR`) ni de l'installation d'UltraStar (`CATEGORY_COVERS_DIR`) pendant le développement ou les tests. Les tests utilisent
   uniquement `test/fixtures/` ou un dossier temporaire (`fs.mkdtemp`).
2. Toute écriture de fichier chanson ou playlist dans le code applicatif passe par un utilitaire
   d'**écriture atomique** (fichier temporaire + `rename`) précédée d'une **sauvegarde `.bak`**,
   et **conserve l'encodage d'origine**.
3. Toute opération de modification en masse propose d'abord un **mode simulation (dry-run)**
   renvoyant la liste des changements (diff) avant application.
4. Tout chemin reçu du navigateur est résolu puis **vérifié comme étant à l'intérieur** de
   `SONG_DIR` / `PLAYLIST_DIR` (protection path traversal) avant tout accès disque.
5. **Pas de nouvelle dépendance npm sans le demander** à l'utilisateur, en justifiant le besoin.
   Préférer les modules intégrés de Node (`node:fs/promises`, `node:path`, `node:test`…).
6. Pas de framework frontend (React, Vue, Angular…) ni d'étape de build.
7. Ne lis pas et n'affiche pas le contenu de `.env`.

## Normes de code

Détail complet : @.claude/coding-standards.md

Format UltraStar (spec officielle 1.1.0, <https://usdx.eu/format/>, résumée pour les parsers) :
@.claude/ultrastar-format.md

## Façon de travailler

- Avancer **par petites étapes** vérifiables ; proposer un plan court avant une modification
  touchant plusieurs couches.
- Tout nouveau parser, service ou utilitaire arrive **avec ses tests**.
- Ne pas réécrire du code existant qui n'est pas concerné par la demande.
- Commits au format _Conventional Commits_ (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `chore:`), message en français. Ne jamais `git push` sans accord explicite.
