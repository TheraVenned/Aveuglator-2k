# Aveuglator 2000

Aide à la navigation pour personnes déficientes visuelles, sous la forme d'un site web. Le
téléphone filme devant lui, estime la profondeur de la scène (MiDaS Small) et signale les
obstacles par des sons, une voix et des vibrations codés selon leur direction et leur proximité.

Le modèle tourne **dans le navigateur du téléphone** : aucun serveur de calcul, aucune image
enregistrée ni envoyée, rien à installer. Une adresse web suffit.

> **Avertissement.** Prototype expérimental. La profondeur estimée est relative et peut se
> tromper : le site ne remplace ni la canne blanche, ni le chien guide, ni la vigilance.

## Fonctionnement

```
Caméra arrière, objectif le plus large, format 4:3
  → MiDaS v2.1 Small 256 × 256, exécuté en WebAssembly (onnxruntime-web) dans un worker
  → carte de proximité normalisée
  → analyse 3 secteurs × 3 bandes (score de danger par zone)
  → signalement du danger prioritaire : sons, voix, vibrations
```

L'écran montre uniquement **ce que voit le modèle** : la carte de profondeur, rendue en ombres
(le lointain est blanc, ce qui est proche se détache en sombre). L'image de la caméra n'est
jamais affichée.

| Bande | Ce qui est détecté | Critère |
| --- | --- | --- |
| Tête (30 % hauts) | Branche, panneau, objet suspendu | Zone proche qui se détache de ce qui l'entoure verticalement. Plafond et ciel sont ignorés. |
| Corps (milieu) | Obstacle frontal | Proximité des 15 % de pixels les plus proches de la zone. |
| Sol (32 % bas) | Marche, quai, obstacle bas | Rupture brutale dans le dégradé régulier du sol. |

### Code des alertes

Sons et vibrations suivent le même code.

| Information | Codage |
| --- | --- |
| Secteur | Nombre d'impulsions finales : **1** = gauche, **2** = centre, **3** = droite. Au son, elles sont aussi de plus en plus aiguës et placées à gauche ou à droite dans des écouteurs. |
| Obstacle frontal | Impulsions seules |
| Obstacle en hauteur | Note longue et aiguë (vibration longue), puis les impulsions |
| Dénivelé au sol | Note descendante, puis les impulsions |
| Proximité | Volume et cadence : pause entre deux motifs de 0,9 s (à distance), 0,45 s (proche), 0,12 s (très proche) |
| Détection démarrée | Deux notes montantes |
| Détection perdue | Trois notes longues et graves |

Les dangers proches sont en plus annoncés à voix haute, par exemple « Obstacle très proche au
centre ». Ces annonces sont des enregistrements, pas la synthèse vocale du navigateur : sur
iPhone, Safari met en pause la vidéo de la caméra dès qu'un site appelle la synthèse vocale.

### Vibrations

Les vibrations fonctionnent sur les téléphones **Android**. Sur **iPhone**, Safari ne donne pas
accès au moteur de vibration aux sites web : les alertes y passent par le son et la voix.

## Mise en ligne

Le site est statique : n'importe quel hébergeur de fichiers en HTTPS convient. GitHub Pages est
le plus adapté ici : gratuit, sans limite d'utilisation (chaque téléphone fait lui-même le
calcul), en HTTPS (exigé par les navigateurs pour la caméra), et il accepte le modèle de 65 Mo.

1. Installez [GitHub Desktop](https://desktop.github.com) et connectez-vous à votre compte GitHub.
   L'envoi par le site github.com ne convient pas : il refuse les fichiers de plus de 25 Mo.
2. **File → New repository** : donnez au dépôt le nom du dossier du projet et choisissez comme
   « Local path » le dossier qui le **contient**. Laissez « Initialize with a README » décoché.
3. Écrivez un titre en bas à gauche, puis **Commit to main**.
4. **Publish repository**, en décochant « Keep this code private » (GitHub Pages est payant pour
   un dépôt privé). Un avertissement sur la taille du modèle est normal.
5. Sur la page du dépôt : **Settings → Pages**. Sous « Build and deployment », choisissez
   **Deploy from a branch**, branche **main**, dossier **/ (root)**, puis **Save**.
6. Après une à deux minutes, l'adresse `https://<votre-compte>.github.io/<votre-depot>/`
   s'affiche en haut de cette page. C'est l'adresse du site.

Pour mettre le site à jour ensuite : **Commit to main**, puis **Push origin**. Le site en ligne
suit une à deux minutes plus tard ; rechargez alors la page sur le téléphone.

### Essayer sur l'ordinateur

Avec [Node.js](https://nodejs.org), depuis le dossier du projet :

```powershell
npx serve
```

Ouvrez ensuite `http://localhost:3000` : le site utilise la webcam. Ouvrir `index.html` par
double-clic ne fonctionne pas, les navigateurs exigeant un serveur pour la caméra.

## Utilisation

1. Ouvrez l'adresse du site sur le téléphone (Safari sur iPhone, Chrome sur Android).
2. Appuyez sur **Démarrer la détection** et autorisez la caméra.
3. Tenez le téléphone **à la verticale, caméra vers l'avant, à hauteur de poitrine**, et montez
   le volume. Le découpage en bandes suppose cette position ; un téléphone incliné vers le bas
   fait remonter le sol dans la bande « corps ».

La première ouverture télécharge environ 85 Mo (modèle, moteur de calcul, annonces vocales),
gardés ensuite en cache : les ouvertures suivantes sont rapides et fonctionnent même hors
connexion. L'écran reste allumé pendant la détection, qui se met en pause quand le site passe
en arrière-plan.

Pour le plein écran sur iPhone : bouton Partager de Safari → **Sur l'écran d'accueil**.

### Lire l'écran

- **Vision** : la carte de profondeur, entière, découpée en 9 zones (bandes Tête, Corps, Sol ;
  secteurs gauche, centre, droite). Le cadre prend la couleur du danger en cours.
- **Mesures** (bouton « Mesures affichées ») : score de chaque zone, FPS réels et leur courbe,
  temps d'inférence (INF) et de traitement total (TOT), étendue brute du modèle (PROF), caméra
  en service et nombre de relances automatiques.
- **Bandeau du bas** : danger prioritaire, matrice des 9 zones (elle réagit à chaque motif
  joué), puis moteur de calcul, vibration et voix disponibles.

### Réglages

- **Sons, annonces vocales, vibrations, volume**.
- **Caméra** : par défaut l'angle le plus large (objectif ultra grand-angle s'il existe, zoom au
  minimum, format 4:3 pour ne pas rogner les côtés). Une caméra précise peut être imposée.
- **Rendu** : ombres (par défaut) ou fausses couleurs (rouge = proche, bleu = loin).
- **Sensibilité** : multiplie les scores avant seuillage.
- **Référence proche** : MiDaS ne donne qu'une profondeur relative, normalisée image par image.
  Une scène entièrement lointaine est donc étirée jusqu'au plus sombre. Pour l'éviter, relevez
  la valeur haute de « PROF » face à un obstacle à environ un mètre et reportez-la ici.
- **Accélération WebGPU** (expérimental) : fait le calcul sur la carte graphique du téléphone.
  À essayer si les FPS sont faibles ; en cas d'échec, le moteur standard reprend la main.

Les seuils et le découpage sont regroupés dans `defaultConfig` (`js/analyzer.js`).

### Pannes prises en charge

Le site se répare seul quand il le peut, et prévient à l'écran et à voix haute sinon :

- vidéo mise en pause par le navigateur : relancée aussitôt ;
- flux de la caméra figé ou coupé : caméra rouverte automatiquement ; « Détection suspendue »
  n'est annoncé que si cela ne suffit pas, puis l'arrêt après quatre tentatives ;
- calcul bloqué ou en erreur : moteur relancé dans un mode plus simple (un seul fil, puis calcul
  dans la page), sans interrompre la détection ;
- caméra refusée ou indisponible : message d'erreur, la détection ne démarre pas ;
- cadence durablement inférieure à 4 images par seconde : avertissement « réactivité dégradée ».

## Arborescence

```
index.html, app.css       Interface
js/main.js                Orchestration, affichage, réglages
js/camera.js              Ouverture au plus grand angle, capture, surveillance du flux
js/inference.js           Moteurs de calcul et ordre de repli
js/inference-worker.js    Exécution de MiDaS hors de la page
js/depth.js               Appel du modèle et normalisation de la profondeur
js/analyzer.js            Découpage en zones et scores de danger
js/feedback.js            Sons, annonces vocales, vibrations et leur cadence
js/heatmap.js             Rendu de la carte (ombres, fausses couleurs)
sw.js                     Cache hors connexion et calcul multi-fil
models/                   MiDaS v2.1 Small au format ONNX
vendor/ort/               Moteur d'inférence onnxruntime-web
audio/                    Annonces vocales préenregistrées
tools/build-voice.mjs     Régénère les annonces après modification d'une phrase (Windows)
```

## Limites connues

- Profondeur **relative** : aucune distance en mètres. « Très proche » signifie « aussi proche
  que ce qu'il y a de plus proche dans l'image », en général le sol à environ deux mètres.
- La détection des dénivelés est une heuristique : elle repère les ruptures nettes (escalier
  descendant, quai), pas une bordure de trottoir basse.
- Les seuils ont été vérifiés sur des scènes synthétiques, pas calibrés en conditions réelles :
  prévoyez une séance de réglage avec les mesures affichées.
- Les tests automatisés tournent dans Edge sur ordinateur, avec une caméra simulée (environ
  10 images par seconde sur le poste de développement). Le comportement sur iPhone, notamment la
  reprise après une interruption de la caméra, n'a pas pu y être vérifié.
- Pas de vibration sur iPhone (voir plus haut).

## Licences

MiDaS (Intel ISL) est distribué sous licence MIT ; `models/midas_small_256.onnx` est le fichier
`model-small.onnx` de la version v2.1 officielle. `vendor/ort/` contient onnxruntime-web 1.30.0
(Microsoft, licence MIT). Les annonces de `audio/voice.wav` sont produites par la voix de
synthèse française de Windows (Microsoft Hortense) ; vous pouvez les remplacer par vos propres
enregistrements en conservant les positions indiquées dans `audio/voice.json`.
