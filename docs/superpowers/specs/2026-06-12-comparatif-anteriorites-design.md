# Comparatif d'antériorités (côte à côte) — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-12 · **Repo** : `horos-viewer` (MediView)
> **Prochaine étape** : plan d'implémentation (`superpowers:writing-plans`).
> **Sous-projet 1/3** de « comparaison d'antériorités » (recalage + mesure IA d'évolution = sous-projets séparés ultérieurs).

## Problème

MediView ne peut ouvrir une antériorité qu'en **remplaçant** la vue courante (dialog `Antér.`,
bouton « Ouvrir » → navigation). Aucune comparaison **côte à côte** d'un examen avec son
antérieur.

## Objectifs (succès)

1. Depuis les antériorités, ouvrir un **mode comparatif 1×2** : étude courante à gauche,
   **1 antériorité choisie** à droite.
2. Le viewport de droite charge l'**étude antérieure** (série sélectionnable).
3. **Défilement + W/L synchronisés** entre les deux vues (bascule activer/désactiver) ;
   zoom/pan indépendants.
4. UI claire pour **entrer / sortir** du mode comparatif et **choisir** l'antériorité.

## Non-objectifs (hors scope)

- ❌ **Recalage / alignement spatial** des images → sous-projet séparé.
- ❌ **Mesure d'évolution IA** (« +50 % ») → sous-projet séparé.
- ❌ Plus d'une antériorité simultanée (N>1).
- ❌ Comparatif en MPR/3D (2D stack uniquement).
- ❌ Alimentation automatique de la section comparaison du compte-rendu.

## Architecture (Approche 1 — mode dédié + 2e viewer + synchro React)

On exploite le fait que `CornerstoneViewer` est **piloté par props** (`currentSlice`,
`windowWidth`, `windowCenter`, `imageUrls`, `instances`). La synchro devient donc un **partage
d'état React** entre deux instances — sans toucher à la logique multi-viewport « même-série »
existante, ni aux synchroniseurs Cornerstone.

```
Viewer (mode comparatif actif)
 ├─ grille 1×2
 │   ├─ gauche : CornerstoneViewer (étude COURANTE) — cellImageUrls/cellInstances (existant)
 │   └─ droite : CornerstoneViewer (étude ANTÉRIEURE) — priorImageUrls/priorInstances
 ├─ état : comparePriorStudyId, comparePriorSeriesId, compareSync
 │   ├─ sync ON  → les 2 reçoivent currentSlice + WW/WC partagés (clampés à leur total)
 │   └─ sync OFF → le viewer droit a son état LOCAL (priorSlice, priorWw/Wc)
 └─ requêtes antériorité : series.listByStudy(priorStudyId) + instances.listBySeries(priorSeriesId)
```

## Composants & état

**État ajouté dans `client/src/pages/Viewer.tsx` :**

- `comparePriorStudyId: number | null` — l'antériorité comparée (null = mode off).
- `comparePriorSeriesId: number | null` — série affichée à droite.
- `compareSync: boolean` (défaut `true`).
- `priorSlice`, `priorWindowWidth`, `priorWindowCenter` — état LOCAL du viewer droit (utilisé quand `compareSync` est OFF).

**Données de l'antériorité :**

- `trpc.series.listByStudy.useQuery({ studyId: comparePriorStudyId }, { enabled: !!comparePriorStudyId })` → auto-sélection de `comparePriorSeriesId` = 1re série (ou même modalité que la courante si dispo).
- `trpc.instances.listBySeries.useQuery({ seriesId: comparePriorSeriesId }, { enabled: !!comparePriorSeriesId })` → `priorImageUrls` (storageUrl) + `priorInstances` ({id, storageUrl}), comme `cellImageUrls`/`cellInstances`.

**Rendu :** quand `comparePriorStudyId != null` ET `viewMode === "2d"`, on rend une grille
`grid grid-cols-2` avec deux `CornerstoneViewer` (au lieu du rendu mono/multi-viewport
habituel). Le viewer droit reçoit `priorImageUrls`/`priorInstances` et, selon `compareSync` :

- ON : `currentSlice={Math.min(currentSlice, priorTotal-1)}`, `windowWidth/Center` = ceux du courant ; ses `onSliceChange`/`onWindowLevelChange` mettent à jour l'état PARTAGÉ (courant).
- OFF : `currentSlice={priorSlice}`, `windowWidth/Center` = `priorWindowWidth/Center` ; ses callbacks mettent à jour l'état LOCAL.

## Logique pure (testable)

Nouveau module `client/src/lib/compareSync.ts` :

- `clampPriorSlice(currentSlice: number, priorTotal: number): number` — borne l'indice dans
  `[0, priorTotal-1]` (robuste : `priorTotal<=0` → 0 ; entrées dégénérées → 0).
- `pickPriorSeries(series: {id:number; modality?:string|null}[], currentModality?: string|null): number | null`
  — choisit la série de l'antériorité : 1re série de **même modalité** que la courante si
  elle existe, sinon la 1re série, sinon `null`.

## UI

- **Dialog `Antér.`** (existant, Lot 12) : à côté d'« Ouvrir », ajouter **« Comparer »** →
  `setComparePriorStudyId(p.id)` + ferme le dialog (reste sur l'étude courante).
- **Barre d'outils (mode comparatif actif)** : bouton **bascule synchro** (lié/délié) +
  bouton **« Fermer comparatif »** (`setComparePriorStudyId(null)`).
- **Viewport droit** : en-tête overlay (date + modalité + description de l'antériorité) +
  **sélecteur de série** (`<select>` des séries de l'antériorité → `setComparePriorSeriesId`).

## Gestion d'erreurs

- Antériorité sans série / sans instances → message « Aucune image dans cette antériorité » dans
  le viewport droit ; le mode reste utilisable (courant à gauche).
- Indice de coupe hors limites (étude antérieure plus courte) → borné via `clampPriorSlice`.
- Fail-soft : aucune erreur de chargement de l'antériorité ne casse le viewport courant.

## Tests

- **Logique pure** (vitest) : `clampPriorSlice` (nominal, bornes, dégénéré) et `pickPriorSeries`
  (même modalité prioritaire, repli 1re série, liste vide → null).
- **UI** : vérification live (entrer en comparatif depuis Antér., scroll synchronisé, bascule
  sync, sélecteur de série, fermeture).

## Intégration & déploiement

- Aucune migration DB (réutilise `series.listByStudy` / `instances.listBySeries` existants).
- Déploiement branche `self-host` (PR), jamais `main`.
- Anti-IDOR : les requêtes série/instances de l'antériorité passent par les procédures
  existantes (gating clinique) ; l'antériorité provient de `findPriors` (même PatientID).
