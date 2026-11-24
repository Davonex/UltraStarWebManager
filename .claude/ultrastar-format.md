# Format des fichiers UltraStar — spécification de référence

Source officielle : <https://usdx.eu/format/> — **format 1.1.0** (versionnage sémantique,
page mise à jour le 21/11/2023). En cas de doute, la page officielle fait foi : la relire avant
de modifier un parser.

Ce mémo distingue :

- **SPEC** : ce que dit la spécification ;
- **RÉALITÉ** : ce qu'on trouve dans les vieux fichiers de la bibliothèque, que le parser doit
  quand même accepter en lecture.

Principe du projet : **lecture tolérante, écriture conforme à la spec 1.1.0** (sauf choix
contraire explicite de l'utilisateur).

## 1. Fichier, encodage, lignes

- Conteneur : fichier texte `.txt`.
- SPEC : encodage **UTF-8 sans BOM**, obligatoire.
- RÉALITÉ : UTF-8 avec BOM, **Windows-1252** (CP1252) et parfois CP1250 dans les anciens
  fichiers ; fins de ligne CRLF fréquentes.
- Lignes vides (ou ne contenant que des espaces) : ignorées.
- Ordre attendu : en-têtes `#CLE:valeur`, puis corps (notes), puis `E`.

## 2. En-têtes

Syntaxe : `#CLE:valeur`. Le parser traite les clés **sans tenir compte de la casse** et
**conserve les en-têtes inconnus** tels quels (lecture et réécriture).

### 2.1 Obligatoires

| Tag        | Type / unité   | Exemple               | Remarques                                                                     |
| ---------- | -------------- | --------------------- | ----------------------------------------------------------------------------- |
| `#VERSION` | semver         | `1.1.0`               | Nouveau en 1.1.0. Absent = fichier « ancien format »                          |
| `#TITLE`   | texte          |                       | Titre affiché                                                                 |
| `#ARTIST`  | texte          |                       | Interprète ou groupe                                                          |
| `#AUDIO`   | nom de fichier | `Artiste - Titre.mp3` | Piste complète (voix + instru). Remplace `#MP3`. mp3 CBR, wav, ogg au minimum |
| `#MP3`     | nom de fichier |                       | **Déprécié** (remplacé par `#AUDIO`), encore très répandu                     |
| `#BPM`     | nombre         | `400`                 | BPM UltraStar ≈ 4 × BPM réel                                                  |

Règle parser : audio = `#AUDIO` sinon `#MP3`.

### 2.2 Optionnels

| Tag                | Type / unité         | Exemple                  | Remarques                                                             |
| ------------------ | -------------------- | ------------------------ | --------------------------------------------------------------------- |
| `#GAP`             | millisecondes        | `12345`                  | Délai avant le premier beat                                           |
| `#COVER`           | nom de fichier       | `… [CO].jpg`             | Carré 1:1, max 1920×1920, JPG au minimum                              |
| `#BACKGROUND`      | nom de fichier       | `… [BG].jpg`             | Affiché si pas de vidéo                                               |
| `#VIDEO`           | nom de fichier       | `… .mp4`                 | MP4 ou AVI                                                            |
| `#VIDEOGAP`        | secondes (⚠️ ambigu) | `12345`                  | Peut être négatif. La page dit secondes, l'exemple ressemble à des ms |
| `#VOCALS`          | nom de fichier       | `… [VOC].mp3`            | Nouveau. Voix seule ; va avec `#INSTRUMENTAL`                         |
| `#INSTRUMENTAL`    | nom de fichier       | `… [INSTR].mp3`          | Nouveau. Instrumental seul                                            |
| `#GENRE`           | liste (virgule)      | `Pop, Rock`              | Valeurs multiples                                                     |
| `#TAGS`            | liste (virgule)      | `Love Songs, Movie, 80s` | Nouveau. Mots-clés                                                    |
| `#EDITION`         | liste (virgule)      | `SingStar Rocks! [DE]`   | Valeurs issues de listes connues (SingStar, Rock Band…)               |
| `#CREATOR`         | liste (virgule)      | `dagegg, bohning`        | Auteur(s) du fichier                                                  |
| `#LANGUAGE`        | liste (virgule)      | `English, French`        | **Nom anglais** de la langue, jamais traduit                          |
| `#YEAR`            | entier 4 chiffres    | `2022`                   |                                                                       |
| `#START`           | secondes (décimal)   | `1.5`                    | Début de lecture                                                      |
| `#END`             | millisecondes        | `678000`                 | Fin de lecture                                                        |
| `#PREVIEWSTART`    | secondes (décimal)   | `12,34`                  | Début de la preview                                                   |
| `#MEDLEYSTARTBEAT` | beat                 | `10`                     | Va avec `#MEDLEYENDBEAT`                                              |
| `#MEDLEYENDBEAT`   | beat                 | `20`                     | Va avec `#MEDLEYSTARTBEAT`                                            |
| `#CALCMEDLEY`      | `on` / `off`         | `on`                     | Calcul auto du medley                                                 |
| `#P1` / `#P2`      | texte                | `John`                   | Noms des chanteurs d'un duo                                           |
| `#PROVIDEDBY`      | URL                  | `https://usdb.animux.de` | Nouveau. Source du fichier                                            |
| `#COMMENT`         | texte libre          |                          | Non affiché par les jeux                                              |

### 2.3 Dépréciés — à lire, à proposer de migrer (phase 2)

| Tag déprécié                                         | Remplacement     | Action de correction suggérée                                                 |
| ---------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `#MP3`                                               | `#AUDIO`         | Ajouter `#AUDIO` (garder `#MP3` si l'utilisateur joue sur une appli ancienne) |
| `#DUETSINGERP1` / `#DUETSINGERP2`                    | `#P1` / `#P2`    | Renommer                                                                      |
| `#AUTHOR`                                            | `#CREATOR`       | Renommer                                                                      |
| `#PREVIEW`                                           | `#PREVIEWSTART`  | Renommer                                                                      |
| `#ENCODING`                                          | — (UTF-8 imposé) | Convertir le fichier en UTF-8, supprimer le tag                               |
| `#RELATIVE`                                          | — (mode absolu)  | Convertir les temps en absolu, supprimer le tag                               |
| `#RESOLUTION`, `#NOTESGAP`                           | —                | Supprimer                                                                     |
| `#ALBUM`, `#SOURCE`, `#YOUTUBE`, `#LENGTH`, `#FIXER` | —                | Supprimer (inutiles selon la spec)                                            |

Règle parser : en lecture, utiliser le tag déprécié comme **valeur de repli** si le tag moderne
est absent (`#CREATOR` ← `#AUTHOR`, `#P1` ← `#DUETSINGERP1`, `#PREVIEWSTART` ← `#PREVIEW`), et
produire un avertissement « tag déprécié ».

### 2.4 Règles de valeurs

- **Séparateur décimal** : la spec n'en impose pas clairement (exemples avec point **et**
  virgule). Le parser accepte **les deux**. En écriture, conserver le séparateur d'origine du
  fichier.
- **Valeurs multiples** (`GENRE`, `TAGS`, `EDITION`, `CREATOR`, `LANGUAGE`) : séparées par des
  virgules ; découper puis `trim` chaque valeur, ignorer les vides.
- **Noms de fichiers** (`AUDIO`, `COVER`, `VIDEO`…) : relatifs au dossier du `.txt`. Ne jamais
  accepter de chemin absolu ni de `..` en sortie du dossier de la chanson.
- **Valeurs non précisées par la spec** (bornes du pitch, unité réelle de `VIDEOGAP`, ordre des
  en-têtes) : ne pas « corriger » automatiquement, seulement signaler.

## 3. Corps (notes)

Format d'une ligne de note : `TYPE StartBeat Length Pitch Texte`

| Type | Signification | Notation            |
| ---- | ------------- | ------------------- |
| `:`  | Normale       | Standard            |
| `*`  | Dorée         | Vaut le double      |
| `F`  | Libre         | Non notée           |
| `R`  | Rap           | Rythme seulement    |
| `G`  | Rap doré      | Rap, vaut le double |

- `StartBeat`, `Length` : entiers, en beats.
- `Pitch` : entier ; **0 = Do4 (C4, MIDI 60)**. Valeurs négatives possibles.
- `Texte` : la syllabe. **Les espaces y sont significatifs** (un espace en tête marque souvent
  un nouveau mot) : ne jamais `trim` la syllabe lors d'une réécriture. `~` = prolongation de la
  syllabe précédente.

Autres lignes :

| Ligne         | Signification                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `- StartBeat` | Fin de phrase ; le nombre = beat de début de la phrase suivante. Un 2ᵉ nombre peut exister en mode relatif |
| `P1` / `P2`   | Délimiteurs de duo : les notes suivantes sont pour le chanteur 1 / 2                                       |
| `E`           | Fin du fichier ; tout ce qui suit est ignoré                                                               |

## 4. Mode relatif (déprécié)

- `#RELATIVE:yes` : chaque temps est relatif au début de la phrase en cours.
- `#RELATIVE:no` ou absent : temps absolus (cas normal).
- Le parser doit **détecter** le mode relatif et le signaler ; tout calcul de durée ou de
  position (medley, preview, corrections) suppose des temps absolus → convertir avant.

## 5. Compatibilité des applications (résumé de la spec)

| Application           | Points d'attention                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| UltraStar Deluxe      | Gère les nouveautés 1.1.0                                                                                                        |
| UltraStar World Party | **Refuse** les fichiers avec `VERSION`, `AUDIO`, `VOCALS`, `INSTRUMENTAL`, `TAGS`, `PROVIDEDBY` ; pas de `P1/P2` ni `CALCMEDLEY` |
| Vocaluxe              | `R` / `G` traités comme des notes libres                                                                                         |
| UltraStar Play        | Pas de `CREATOR`, ni medley                                                                                                      |
| Yass                  | Pas de `P1/P2` (en-tête), `RESOLUTION`, `NOTESGAP`, `CALCMEDLEY`                                                                 |
| Karedi                | Délimiteurs `P1/P2` et notes `R/G` à partir de 1.1.0                                                                             |

Conséquence : une correction en masse qui passe un fichier en 1.1.0 (ajout de `#VERSION`,
`#AUDIO`…) peut le rendre illisible pour certaines applis. **Toujours demander l'application
cible** avant de proposer une migration de format.

## 6. Avertissements que le parser doit produire

- Tag obligatoire manquant : `TITLE`, `ARTIST`, `AUDIO`/`MP3`, `BPM`.
- Tag déprécié présent (avec le remplaçant suggéré).
- Encodage non UTF-8, ou BOM présent.
- `#RELATIVE:yes`.
- Paires incomplètes : `MEDLEYSTARTBEAT` sans `MEDLEYENDBEAT` (et inversement),
  `VOCALS` sans `INSTRUMENTAL`.
- `YEAR` qui n'est pas un entier à 4 chiffres ; nombre invalide dans `BPM`, `GAP`, etc.
- Aucune note, ou ligne `E` absente ; ligne de corps non reconnue.
- En-tête en double.

## 7. Playlist `.upl`

Hors spécification usdx.eu. Fichier texte ; ligne `#NAME:` (nom de la playlist), puis une ligne
par chanson au format `Artiste : Titre`. **À confirmer sur les vrais fichiers de l'utilisateur**
avant d'écrire le parser (ajouter des fixtures réelles dans `test/fixtures/`).

## Nommage des dossiers et fichiers (vérifié par `src/parsers/naming.js`)

La spec 1.1.0 ne fixe que : audio « should have the same name as the folder », pochette
« should end with `[CO]` », fond `[BG]`, et « please add » `[VOC]` / `[INSTR]`. Rien pour le
dossier, le `.txt` ni les duos. Convention retenue par le projet (communauté, Karedi) :
`Artiste - Titre` partout, `.txt` d'un duo `Artiste - Titre [DUET].txt`, audio/vidéo sans suffixe,
`[CO]`, `[BG]`, `[VOC]`, `[INSTR]`. Comparaison souple : casse, accents, espaces ; caractère
interdit par Windows retiré ou remplacé (`-`, `_`, espace) ; marque de duo en fin de titre ignorée
pour le dossier et les médias. Avertissements `NAMING_FOLDER`, `NAMING_TXT`, `NAMING_AUDIO`,
`NAMING_VIDEO`, `NAMING_COVER`, `NAMING_BACKGROUND`, `NAMING_VOCALS`, `NAMING_INSTRUMENTAL`
(paramètres `file`, `expected`).
