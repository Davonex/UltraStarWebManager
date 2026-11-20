---

## description: Revue de code des changements en cours selon les normes du projet

Fais une revue des changements non commités (`git diff` et fichiers non suivis) au regard de
CLAUDE.md et @.claude/coding-standards.md.

Classe tes remarques en trois niveaux :

- **Bloquant** : bug, faille (path traversal, XSS, écriture non atomique), règle impérative
  non respectée, test manquant.
- **À améliorer** : lisibilité, nommage, découpage, JSDoc manquante.
- **Suggestion** : facultatif.

Pour chaque remarque : fichier, ligne, problème, correction proposée. Ne modifie rien sans
mon accord.
