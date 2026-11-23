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
2. Toute écriture de fichier chanson ou playlist passe par `src/services/fileWriter.js` :
   **sauvegarde datée** dans `BACKUP_DIR` (défaut `backups/`, historique conservé, jamais
   de `.bak` dans la bibliothèque) puis **écriture atomique** (fichier temporaire + `rename`).
   L'**encodage d'origine** (UTF-8, UTF-8 BOM, Windows-1252) et les **fins de ligne** sont
   conservés ; seules les lignes modifiées changent (`src/parsers/ultrastarEdit.js`). Une
   modification est refusée (409) si le fichier a changé depuis son affichage.
   Vidéos (`src/services/videoConvertService.js`) : ffmpeg écrit dans un fichier temporaire,
   le résultat est vérifié, l'original est copié dans `BACKUP_DIR`, puis `rename`. ffmpeg est
   lancé sans shell (liste d'arguments) ; les tests utilisent `test/helpers/fakeFfmpeg.js`.
3. Toute opération de modification en masse propose d'abord un **mode simulation (dry-run)**
   renvoyant la liste des changements (diff) avant application.
4. Tout chemin reçu du navigateur est résolu puis **vérifié comme étant à l'intérieur** de
   `SONG_DIR` / `PLAYLIST_DIR` (protection path traversal) avant tout accès disque.
5. **Pas de nouvelle dépendance npm sans le demander** à l'utilisateur, en justifiant le besoin.
   Préférer les modules intégrés de Node (`node:fs/promises`, `node:path`, `node:test`…).
6. Pas de framework frontend (React, Vue, Angular…) ni d'étape de build.
7. Ne lis pas et n'affiche pas le contenu de `.env`.
8. **Sécurité des routes** : toute route de l'API déclare son niveau d'accès avec
   `requireRole('read' | 'write' | 'admin')` dans `src/routes/api.js` (lecture = consulter,
   écriture = modifier, admin = supprimer). Seules `/api/health` et `/api/auth/*` sont publiques.
   Les appels du navigateur passent **toujours** par `public/js/api.js` (qui ajoute
   l'en-tête `X-USM-Request` exigé sur les écritures). Chaque nouvelle route a un test de refus
   (401 sans connexion, 403 si le niveau est insuffisant).
9. **CSP stricte** : aucun script ni style en ligne dans le HTML (pas de `<script>…</script>`,
   pas d'attribut `style=` ni `onclick=`), aucun fichier chargé depuis un autre domaine (CDN).
   Les styles dynamiques passent par `element.style` ou des classes.

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
