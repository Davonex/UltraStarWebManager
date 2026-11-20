---

description: Ajoute une route API complète (route, contrôleur, service, tests)
argument-hint: <METHODE /api/chemin> <description>
---

Ajoute la route API suivante : $ARGUMENTS

Respecte l'architecture de CLAUDE.md et @.claude/coding-standards.md :

1. Propose d'abord un plan court (fichiers créés/modifiés, format JSON de la réponse) et
   attends ma validation si la route écrit sur le disque.
2. `src/routes/api.js` : uniquement l'association URL → contrôleur.
3. `src/controllers/…` : validation des entrées, appel du service, réponse `{ data }` ou
   `{ error }` avec le bon code HTTP.
4. `src/services/…` : logique métier, JSDoc + `@typedef` des données renvoyées.
5. Tests : service (dossier temporaire si accès disque) et route (via `createApp`).
6. Termine par `/verifier`.
