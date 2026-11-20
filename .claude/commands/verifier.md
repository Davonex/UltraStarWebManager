---

## description: Lance lint + tests et corrige les problèmes trouvés

1. Lance `npm run lint`. S'il y a des erreurs, lance `npm run lint:fix`, puis corrige à la main
   ce qui reste en respectant @.claude/coding-standards.md.
2. Lance `npm test`. Pour chaque échec, explique la cause en une phrase et corrige le code
   (pas le test, sauf si le test est faux — dans ce cas, dis-le explicitement).
3. Relance les deux commandes jusqu'à ce qu'elles passent.
4. Termine par un résumé court : ce qui a été corrigé, fichiers touchés.
