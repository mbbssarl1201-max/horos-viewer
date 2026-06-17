# MediView — parité « feel » du viewer Horos — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-17 · **Repo** : `horos-viewer` (MediView)
> 100 % client (Cornerstone3D/React). **Aucun PHI, aucun serveur, aucune migration.** Réf. visuelle :
> captures Horos du gérant (overlays curseur, règle calibrée, bouton souris, CLUT/opacité, menu 2D/3D).

## Problème

Le viewer MediView est riche (annotations, W/L, presets, MPR/3D/VR/Surface/Curved/MIP/fly-through,
CLUT, couches) mais son **« feel » diffère de Horos** : pas de lecture curseur px/mm/valeur, pas de
règle calibrée, pas d'affectation d'outil au **bouton droit**, CLUT/opacité non exposés en barre 2D, et
les modes de rendu existants ne sont pas regroupés dans un menu unique « 2D/3D » comme Horos (problème
de **découvrabilité**, pas d'absence).

## Objectifs (succès)

1. **Overlay curseur riche** : sous le curseur (ou coin dédié), affichage live `X/Y px`, `X/Y mm`,
   **valeur du pixel** ; coins complétés avec **taille image**, **view size**, **angle**, et **position
   patient** (étiquettes L/R/A/P/H/F dérivées de `ImageOrientationPatient`). Conserve l'existant
   (patient, WW/WC, coupe, zoom%).
2. **Règle / échelle calibrée** : barre graduée en **mm** sur un bord du viewport, recalculée selon le
   pixel spacing DICOM et le zoom courant. Masquée si pas de pixel spacing.
3. **Affectation bouton souris** : un contrôle « Bouton souris » permettant d'assigner un outil au
   **bouton droit** (défaut : W/L au clic-droit, façon Horos), en plus du bouton gauche (inchangé).
4. **CLUT + table d'opacité en barre 2D** : deux dropdowns — CLUT (palette couleur, via `setColormap`
   déjà exposé ; « No CLUT » = niveaux de gris) et **Table d'opacité** (fonction VOI LUT : Linéaire /
   Sigmoïde, via `setVoiLutFunction` déjà exposé).
5. **Menu unifié « 2D/3D »** : un sélecteur unique listant les modes **déjà existants** (2D, MPR ortho,
   Curved-MPR, MIP, Volume Rendering, Surface, Endoscopie/fly-through) qui déclenche les bascules
   actuelles ; + **vignettes/labels d'orientation** cliquables (axial/coronal/sagittal en MPR).

## Non-objectifs (hors scope)

- ❌ **MIP natif par épaisseur sur le StackViewport 2D** : techniquement le viewport 2D est un
  `ViewportType.STACK` (pas de slab MIP natif). Le thick-slab **reste** la fonction MPR existante ; le
  bouton « MIP/épaisseur » en 2D **route vers le chemin volumique** (MPR/MIP) existant. (MIP 2D natif =
  incrément séparé si demandé.)
- ❌ Réécriture des modes de rendu (tous existent — on regroupe seulement l'UI).
- ❌ Base/worklist (albums, filtres, burn/email/share) = bloc suivant.
- ❌ PHI / serveur / migration / cloud.

## Architecture

```
client/src/lib/viewportOverlay.ts   (PUR)  formatCursorReadout / formatImageInfo / patientOrientationLabels
client/src/lib/scaleBar.ts          (PUR)  computeScaleBar(pixelSpacingMm, zoom, lengthPx) → {barPx,labelMm,ticks}
        │
CornerstoneViewer.tsx :
  - onCursor?(data|null)  : émet {xPx,yPx,xMm,yMm,value} au mousemove (null à la sortie)
  - setSecondaryTool(name): lie un outil au bouton DROIT (MouseBindings.Secondary)
  - dessine la règle calibrée sur un canvas overlay (computeScaleBar)
        │
Viewer.tsx :
  - overlay coins enrichis (viewportOverlay) + état `cursor`
  - barre 2D : dropdown CLUT (setColormap) + dropdown Opacité (setVoiLutFunction)
            + contrôle « Bouton souris » (setSecondaryTool)
            + menu unifié « 2D/3D » (déclenche les modes existants) + vignettes orientation
```

### Composants

- **`lib/viewportOverlay.ts`** (nouveau, PUR) :
  - `formatCursorReadout(c: { xPx:number; yPx:number; xMm:number|null; yMm:number|null; value:number|null }): string`
    → ex. `"X: 305.8 mm Y: 241.9 mm — px (2224, 1759) — Val 0"` ; champs mm omis si null.
  - `patientOrientationLabels(iop: number[] | null): { top:string; bottom:string; left:string; right:string }`
    → étiquettes L/R/A/P/H/F dérivées d'`ImageOrientationPatient` ; `{top:"",...}` si null.
  - `formatImageInfo(info: { rows?:number; cols?:number; zoomPct?:number; angleDeg?:number }): string[]`.
- **`lib/scaleBar.ts`** (nouveau, PUR) :
  - `computeScaleBar(pixelSpacingMm: number|null, zoom: number, lengthPx: number): { barPx:number; labelMm:number } | null`
    → choisit un « joli » pas (1/2/5×10ⁿ mm) tenant dans `lengthPx` ; `null` si spacing absent/zoom≤0.
- **`CornerstoneViewer.tsx`** (modifié) :
  - Prop `onCursor?: (c: CursorData | null) => void` ; handler `mousemove`/`mouseleave` → coords image
    via `cornerstone` (`canvasToWorld`/imageData), mm = px × pixelSpacing, valeur via `getPixelData`.
  - Handle `setSecondaryTool(name: string)` → `toolGroup.setToolActive(name, { bindings:[{mouseButton: Secondary}] })`
    (et W/L par défaut sur Secondary à l'init).
  - Dessin de la règle : sur le canvas overlay déjà présent, dessine la barre + ticks + label (depuis
    `computeScaleBar`), redessiné aux events `CAMERA_MODIFIED`/`IMAGE_RENDERED`.
- **`Viewer.tsx`** (modifié) :
  - État `cursor` alimenté par `onCursor` → coins overlay via `viewportOverlay`.
  - Barre 2D : dropdown **CLUT** (liste de `lib/colormaps`, « Aucun » + palettes) → `setColormap` ;
    dropdown **Opacité** (Linéaire/Sigmoïde) → `setVoiLutFunction`.
  - Contrôle **« Bouton souris »** : petit menu affectant l'outil du bouton droit → `setSecondaryTool`.
  - Menu **« 2D/3D »** : un `<select>`/menu regroupant les modes existants (déclenche les setters de
    `viewMode`/MPR/3D actuels) ; vignettes orientation en MPR (réutilise l'état ortho existant).

## Gestion d'erreurs

- Pas de pixel spacing → règle masquée, mm omis dans l'overlay (px/valeur restent).
- `getImageOrientation` null → étiquettes d'orientation masquées.
- Colormap inconnue → ignorée (déjà géré par `ensureColormapRegistered`).
- Curseur hors image → `onCursor(null)` → coin curseur vidé.

## Tests

- **Pur (vitest)** :
  - `viewportOverlay` : `formatCursorReadout` (mm présents/null, arrondis) ; `patientOrientationLabels`
    (axial → L/R/A/P, iop null → vides) ; `formatImageInfo`.
  - `scaleBar` : `computeScaleBar` choisit un pas rond tenant dans la largeur ; spacing null → null ;
    zoom plus grand → barre plus longue pour le même mm.
- **UI** : vérif visuelle (curseur px/mm/valeur, règle, bouton droit = W/L, CLUT, menu 2D/3D).

## Intégration & déploiement

- **Aucune migration, aucun nouveau modèle.** Branche `feat/viewer-feel-parity` (depuis `self-host`).
- Gate CI (tsc+tests+audit) → build GHCR → compose VPS → healthz 200 + garde 401. Vérif navigateur :
  curseur affiche px/mm/valeur, règle calibrée visible, clic-droit fait du W/L, dropdowns CLUT/opacité
  agissent, menu « 2D/3D » bascule les modes.
