# VR avancé (rendu volumétrique) — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-16 · **Repo** : `horos-viewer` (MediView)
> **Prochaine étape** : plan d'implémentation du 1er incrément (`superpowers:writing-plans`).
> **Épopée 1a** de « modélisation 3D avancée pour la radiologie ». Sous-projets suivants :
> 1b modèle 3D depuis segmentation + STL, 1c mesures/outils 3D, 1d options de visualisation ;
> épopée 2 = agent Hermès radiologue IA (RAG vectoriel PHI-safe). Tous séparés.

## Problème

Le rendu volumétrique (VR) de MediView est **fonctionnel mais fermé** : `VolumeViewer.tsx`
(≈955 l., Cornerstone3D + presets VTK) expose déjà le mode **3D** (bouton 3D), ~11 presets
cliniques (Os, Angio, Cœur, Poumon, Anévrisme…), un rendu **réaliste cinématique**
(`realistic3d`), un mode **iso-surface** (`surface3d`), le **scissor** (découpe) et l'**export
maillage OBJ**. Mais on ne peut pas : entrer dans le volume avec des **plans de coupe
interactifs**, régler soi-même le **fenêtrage 3D** (presets figés), faire du **MIP/MinIP à
épaisseur réglable**, ni **exporter une vidéo de rotation**.

## Objectifs (succès)

Ajouter au viewport 3D **existant** (sans nouveau moteur ni nouveau viewport) :

1. **Export vidéo turntable** — vidéo de rotation du rendu 3D courant, encodée **côté client**.
2. **MIP / MinIP + épaisseur de dalle** — mode de composition réglable (COMPOSITE / MIP / MinIP)
   avec épaisseur de dalle ajustable.
3. **Plans de coupe interactifs (clipping)** — couper le volume par plan(s) axial / sagittal /
   coronal (+ oblique), déplaçables, activables/désactivables.
4. **Éditeur de fonction de transfert + presets perso** — régler les courbes opacité/couleur
   (fenêtrage 3D), créer/sauvegarder ses propres presets.

**Ordre de livraison** : 1 (turntable) → 2 (MIP/slab) → 3 (clipping) → 4 (éditeur TF). Chaque
incrément = sa spec courte (dérivée de celle-ci) → plan → PR → déploiement.

## Non-objectifs (hors scope de 1a)

- ❌ Segmentation / génération de maillage 3D + STL → **incrément 1b**.
- ❌ Mesures / annotations en 3D → **incrément 1c**.
- ❌ Nouveaux layouts / fusion multi-modalités / colormaps 2D → **incrément 1d**.
- ❌ Nouveau moteur de rendu (on reste **Cornerstone3D/VTK**).
- ❌ **Tout changement serveur, PHI sortant, ou migration DB** — 1a est **100 % client**, rendu
  local sur le GPU. Aucun pixel ne quitte le périmètre de confiance.
- ❌ Positionnement diagnostic : reste une **aide non-certifiée** (inchangé).

## Architecture (Approche A — extension Cornerstone3D, modulaire, client-only)

```
VolumeViewer.tsx (mode "3d", acteur volume VTK déjà monté)
 ├─ barre d'outils 3D (Viewer.tsx) : ajoute 4 contrôles selon l'incrément
 ├─ 1. turntable   → lib/turntable.ts (PUR: génère les angles de rotation)
 │                   + capture du canvas WebGL → MediaRecorder (WebM) → download local
 ├─ 2. blendMode3d → lib/blendMode3d.ts (PUR: mappe mode↔blend VTK + dalle)
 │                   → applique le blend mode du mapper + épaisseur
 ├─ 3. clipPlanes  → lib/clipPlanes.ts (PUR: bornes/normales des plans par axe+oblique)
 │                   → ajoute/maj des vtkPlane sur le mapper
 └─ 4. transferFn  → lib/transferFunction.ts (PUR: points opacité/couleur ↔ TF VTK)
                     → applique piecewise/color TF à la propriété du volume ; presets perso localStorage
```

**Principe** : le composant `VolumeViewer` est déjà gros (955 l.). Chaque incrément met sa
**logique pure et testable dans un module dédié** (`client/src/lib/*.ts`), `VolumeViewer` ne fait
que **brancher** ce module sur l'acteur/mapper Cornerstone3D et exposer un contrôle UI. On NE
gonfle PAS davantage le composant ; au besoin, on extrait la logique 3D existante au passage
(sans refactor non lié).

**Données / état** : nouveaux états UI dans `Viewer.tsx` (mode de blend, épaisseur, plans actifs

- positions, points de TF, preset perso sélectionné). Les **presets perso** sont persistés en
  **localStorage** (clé non-PHI : courbes opacité/couleur uniquement) — aucun appel serveur, aucune
  migration.

## Détail des 4 incréments

**1. Turntable export.** `lib/turntable.ts` (pur) : `turntableAngles(count, axis)` → liste
d'angles répartis sur 360°. `VolumeViewer` fait tourner la caméra incrémentalement, capture le
canvas WebGL à chaque frame (`canvas.captureStream()` + `MediaRecorder` WebM, ou capture frame par
frame), assemble et **déclenche un download local** (`.webm`). Bouton « Exporter rotation » visible
en mode 3D. **Rien n'est envoyé au serveur** (PHI reste local). Repli si `MediaRecorder` indispo
(navigateur) → message clair.

**2. MIP / MinIP + dalle.** `lib/blendMode3d.ts` (pur) : `resolveBlendMode("composite"|"mip"|"minip")`
→ constante de blend VTK + helper de validation d'épaisseur de dalle (bornée au volume).
`VolumeViewer` applique le blend mode au mapper du volume et l'épaisseur. Sélecteur 3 modes +
slider d'épaisseur dans la barre 3D (mode 3D uniquement).

**3. Plans de coupe interactifs.** `lib/clipPlanes.ts` (pur) : pour chaque axe (X/Y/Z) + un plan
oblique optionnel, calcule **origine + normale** d'un `vtkPlane` à partir d'une position normalisée
[0..1] sur l'étendue du volume ; `clampClipPosition`. `VolumeViewer` ajoute/maj/retire les
`vtkPlane` sur le mapper (`addClippingPlane`/`removeAllClippingPlanes`). UI : toggle + slider de
position par plan (axial/sagittal/coronal), + inversion de sens. (Oblique = amélioration ; si trop
coûteux, reporté en fin d'incrément, signalé.)

**4. Éditeur de fonction de transfert.** `lib/transferFunction.ts` (pur) : modèle de points
`{ value(HU), opacity, color }` ↔ application sur `vtkPiecewiseFunction` (opacité) +
`vtkColorTransferFunction` (couleur) de la propriété du volume ; `serialize`/`deserialize` pour
localStorage. UI : petit éditeur **canvas** (points déplaçables sur l'histogramme HU), boutons
« Enregistrer comme preset », liste des presets perso (localStorage), « Réinitialiser au preset
clinique ». Coexiste avec les 11 presets fournis (qui restent le point de départ).

## Gestion d'erreurs

- Chaque levier (blend, clip, TF, capture) est **best-effort en try/catch isolé** — même pattern
  que `realistic3d`/`surface3d` aujourd'hui : un échec dégrade la fonctionnalité, **ne casse jamais
  le rendu de base**.
- Turntable : si `MediaRecorder`/codec WebM indispo → toast explicite, pas de crash.
- localStorage indispo / quota → presets perso désactivés silencieusement (presets fournis
  toujours là).
- Volume non chargé / mode ≠ 3D → contrôles masqués/désactivés.

## Tests

- **Logique pure (vitest)** : `turntableAngles` (répartition, bornes, count=1) ; `blendMode3d`
  (mapping + clamp dalle) ; `clipPlanes` (origine/normale par axe, `clampClipPosition`, inversion) ;
  `transferFunction` (points↔TF, serialize/deserialize round-trip, points hors-bornes).
- **UI** : vérification visuelle navigateur par incrément (turntable lit/télécharge ; MIP change le
  rendu ; clip coupe le volume ; éditeur TF modifie opacité/couleur + sauvegarde/recharge).

## Intégration & déploiement

- **Aucune migration DB. Aucun changement serveur.** Tout est client (`client/src/`).
- Déploiement branche `self-host` (PR), jamais `main`. Le **gate CI** (verify: tsc+tests+audit)
  protège chaque PR ; build image GHCR ; déploiement VPS via la procédure habituelle (healthz 200 +
  garde 401 + image SHA).
- Vérification visuelle du rendu 3D après chaque incrément (test gérant).
