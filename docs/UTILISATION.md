# MediView — Guide d'utilisation

MediView est un visualiseur d'imagerie médicale (DICOM) web. Ce guide couvre
l'usage clinique courant. Application : `https://mediview.mbbssarl.ch` (démo) ou
l'instance on-premise du cabinet.

> ⚠️ **Avertissement clinique** — MediView est une aide à la visualisation et à
> la rédaction. Les pré-analyses par IA sont des **brouillons à valider et signer
> par un médecin**. MediView n'est pas (à ce stade) un dispositif médical
> certifié de diagnostic (voir `CONFORMITE-CE-MDR.md`).

## 1. Connexion

- Ouvrir l'URL, saisir email + mot de passe.
- Le **premier compte créé** sur une instance devient administrateur.
- 2FA / rôles selon configuration.

## 2. Liste des études

- Recherche/tri par patient, date, modalité.
- **Statut** (Nouveau / En cours / Rapporté / Finalisé) et **Priorité**
  (Routine / STAT / Urgent) modifiables par étude (rôle clinique/admin).
- **Send (C-STORE)** : renvoyer une étude vers une modalité PACS (admin).

## 3. Visualiseur 2D

- **Vignettes de séries** à gauche (rendu réel) ; cliquer pour ouvrir une série.
- Barre d'outils : **W/L** (fenêtrage), Zoom, Pan, Défilement.
- **Mesures** (calibrées en mm / HU) : Longueur, Angle, Ellipse, Rectangle,
  Texte, **Cobb** (rachis), **Bidirectionnel** (RECIST), **Sonde** (HU),
  **ROI main levée**. Les mesures sont **sauvegardées** et réapparaissent au
  rechargement.
- **Segmentation** : Pinceau / Gomme / Effacer (superposition labelmap).
- **Presets W/L** : Default, Bone, Lung, Brain, Abdomen, Liver, Mediastinum.
- **Ciné** : lecture automatique des coupes (fps réglable).
- **Multi-viewports** : 1×1 / 1×2 / 2×2 (la cellule active pilote les outils).
- **Raccourcis clavier** : voir le bouton « Raccourcis » (flèches = coupes,
  Espace = ciné, W/Z/P/S/L/A/E/R/T = outils, 1–4 = presets W/L).

## 4. MPR & 3D

- **MPR** : reconstruction tri-planaire (axial / sagittal / coronal + oblique),
  crosshairs synchronisés, **épaisseur de slab** réglable (MIP / MinIP / Moyenne).
- **3D** : rendu volumique avec **12 presets** (os, angio, cœur, poumon…),
  **rotation** (clic-glisser), et **« Rendu réaliste »** (éclairage cinématique).
- **Exporter 3D** : génère un modèle de surface depuis le volume.
  - **Format** : GLB (glTF binaire, web/AR), PLY (binaire compact), OBJ (texte).
  - **Résolution** : Pleine / Moyenne (½) / Basse (¼).
  - **Lissage** (Taubin) activable ; **couleur** issue des vraies densités HU.

## 5. Compte rendu & IA

- Bouton **« Compte rendu »** : ouvre le panneau de rédaction.
- **Pré-analyse IA** : analyse **tout le volume** (échantillon de coupes dans la
  fenêtre courante) et propose un brouillon + désigne la **coupe de l'anomalie**.
  - **« Analyser les fractures »** : force l'analyse sur la **série osseuse** en
    fenêtre osseuse.
  - ⚠️ Brouillon **à valider et signer** par le médecin avant émission.
- **Antécédents** pré-remplis automatiquement (imagerie antérieure du patient).
- **Export PDF** / **envoi au confrère** (PDF + ciné MP4 optionnel).

## 6. PACS (on-premise)

- Interroger le PACS (Query/C-FIND), récupérer une étude (C-MOVE), l'ouvrir.
- Voir `deploy/on-premise/README-macos.md` pour l'installation au cabinet.

## 7. Administration

- **Export d'audit** (journaux d'accès), **rétention** (purge), gestion des
  comptes/rôles. `/healthz` expose l'état (DB/stockage) pour la supervision.
