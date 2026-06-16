# Mesure IA d'évolution entre examens — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-12 · **Repo** : `horos-viewer` (MediView)
> **Prochaine étape** : plan d'implémentation (`superpowers:writing-plans`).
> **Sous-projet 3/3** du comparatif d'antériorités (1 = côte à côte LIVRÉ ; 2 = recalage, séparé).

## Problème

Le compte-rendu IA analyse l'étude courante **isolément**, alors que la question clinique
centrale est souvent l'**évolution** par rapport à l'examen précédent (stable ? progression ?).
Le radiologue compare manuellement.

## Objectifs (succès)

1. Quand le patient a une antériorité, **« Générer (IA) » compare automatiquement** les deux
   examens : le serveur échantillonne **les deux volumes** (réutilise `sampleSeriesPngs`) et
   le LLM produit une évaluation comparative en **un seul appel multimodal**.
2. L'évolution est **tissée dans la section Résultats** (« Comparaison au [date] : … »).
3. Un **verdict structuré** (`stable` / `progression` / `regression`, ou `null`) est renvoyé
   et affiché en **badge** dans le panneau compte-rendu (+ date de l'examen comparé).
4. **Anti-IDOR** : l'antériorité doit appartenir au **même patient** (vérifié serveur) ;
   choix = antériorité du mode comparatif si actif, sinon la **plus récente** du patient.
5. **PHI-safe** : backend hybride existant (défaut Ollama local) ; **fail-soft** à chaque
   étage : sans antériorité ou en cas d'échec, le compte-rendu se génère comme aujourd'hui.

## Non-objectifs (hors scope)

- ❌ Recalage spatial (sous-projet 2).
- ❌ Mesures chiffrées automatiques de lésions (appariement géométrique « 6→9 mm » exact) —
  l'IA décrit l'évolution visuellement, le médecin valide/chiffre.
- ❌ Persistance du verdict en DB (pas de migration ; le texte du CR + l'affichage suffisent).
- ❌ Comparaison multi-antériorités (une seule, la plus pertinente).

## Architecture (Approche 1 — extension de runAiPreanalysis, prompt comparatif unique)

```
ReportPanel « Générer (IA) »
  └─ reports.aiGenerate({studyId, seriesId?, priorStudyId?, priorSeriesId?, …})
       ├─ priorStudyId absent → helper DB : plus récente antériorité du MÊME patient
       ├─ runAiPreanalysis(…, priorStudyId, priorSeriesId)
       │    ├─ anti-IDOR : priorStudy.patientId === study.patientId (sinon FORBIDDEN)
       │    │              + priorSeries ∈ priorStudy (garde existante)
       │    ├─ priorSeriesId absent → 1re série de même modalité de l'antériorité
       │    ├─ sampleSeriesPngs(seriesId, count: 8) + sampleSeriesPngs(priorSeriesId, count: 8)
       │    │    (échec antérieur → continue SANS comparaison, comportement actuel)
       │    ├─ UN appel LLM (hybride) : blocs « EXAMEN ACTUEL » / « EXAMEN ANTÉRIEUR du [date] »
       │    │    consigne : Technique / Résultats (avec ¶ « Comparaison au [date] : … ») /
       │    │    Conclusion + ligne finale `Évolution: stable|progression|régression`
       │    └─ parseEvolution(text) → verdict (parseur pur, tolérant, retire la ligne du texte)
       └─ renvoie sections + evolution + comparedPriorDate
```

## Modifications serveur

**`server/report/aiPreanalysis.ts`** :

- `RunAiPreanalysisInput` += `priorStudyId?: number`, `priorSeriesId?: number`.
- `RunAiPreanalysisResult` += `evolution?: "stable" | "progression" | "regression" | null`,
  `comparedPriorDate?: string | null`.
- `runAiPreanalysis` :
  1. si `priorStudyId` : charger les deux études, **vérifier même patient** (FORBIDDEN sinon) ;
  2. si `priorSeriesId` : vérifier `∈ priorStudy` (même garde que l'existant) ; sinon choisir
     la 1re série de même modalité de l'antériorité (logique `pickPriorSeries`) ;
  3. échantillonner les deux séries à **8 coupes chacune** (au lieu de 16 pour une seule) ;
  4. prompt comparatif (blocs étiquetés + consigne d'évolution) — un seul appel LLM hybride ;
  5. `parseEvolution` sur la réponse ; la ligne `Évolution:` est retirée du texte (comme
     `Anomalie:`/`Coupe-clé:` aujourd'hui).
- **Parseur pur** `parseEvolution(text): {evolution: "stable"|"progression"|"regression"|null, cleaned: string}`
  — tolérant (casse, accents, absence de la ligne → null).

**`server/routers.ts` (`reports.aiGenerate`)** :

- input += `priorStudyId?: number`, `priorSeriesId?: number` (zod optionnels) ;
- si absents → helper DB « plus récente antériorité du même patient » (équivalent serveur de
  `findPriors` : même `patients.id`, `studies.id !== courant`, tri date desc, limit 1) ;
- renvoie `evolution` + `comparedPriorDate` en plus de `{sections, aiModel, keyImage}` ;
- audit `report.generate` : `detail` mentionne la comparaison (`compared:<priorStudyId>`).

## UI (`ReportPanel` / `Viewer`)

- Le Viewer transmet `comparePriorStudyId`/`comparePriorSeriesId` (mode comparatif) au
  `ReportPanel` en props optionnelles ; « Générer (IA) » les passe à `aiGenerate` (sinon rien
  → choix serveur automatique).
- **Badge d'évolution** sous les boutons quand `evolution` est non-null :
  `🟢 Stable` / `🔴 Progression` / `🔵 Régression` + « vs examen du [comparedPriorDate] ».
  Pas de badge si premier examen / comparaison échouée.
- La mention « Brouillon généré par IA — à valider » existante est conservée (aide, pas un
  diagnostic — positionnement non-certifié inchangé).

## Gestion d'erreurs (fail-soft)

- Pas d'antériorité → génération inchangée (aucune régression de comportement).
- Échantillonnage de l'antériorité échoue → génération normale, `evolution: null`.
- LLM ne produit pas la ligne `Évolution:` → texte conservé, verdict `null`.
- Patient différent (anti-IDOR) → FORBIDDEN explicite.

## Tests (logique pure, vitest)

- `parseEvolution` : 3 verdicts, casse/accents variés, ligne absente → null, la ligne est
  retirée du texte nettoyé, ne pollue pas la Conclusion.
- Helper « plus récente antériorité » : même patient, exclut l'étude courante, tri par date,
  aucune → null.
- Garde anti-IDOR même-patient (test du rejet).

## Intégration & déploiement

- **Aucune migration DB** (verdict non persisté).
- Déploiement branche `self-host` (PR), jamais `main`.
- Coût/latence : 8+8 images par appel (vs 16 aujourd'hui) — comparable ; Ollama local par
  défaut (PHI-safe), Claude via ENV comme l'existant.
