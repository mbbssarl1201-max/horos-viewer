# Lecture « niveau radiologue » native MediView — design validé

Date : 2026-08-22 · Validé par le gérant (chat) · Branche : `feat/lecture-radiologue` (base `dd5012a`)

## Problème

Le mode « Analyser (IA) » balaye déjà 100 % des coupes, mais le dépistage (phase 1)
est fait par le modèle local qwen2.5vl:7b en 384 px : Opus 5 ne voit que les ≤30
coupes que ce modèle faible signale. La « 2e opinion » est un qwen 3b qui répond
oui/non. 56/267 études n'ont que scano+SUMMARY (import PACS incomplet). Le service
de segmentation (`SEG_SERVICE_URL`) vivait sur l'A100, supprimé.

Décision stratégique du gérant (22.08) : **aucun fournisseur d'IA radio tiers**
(Gleamer/Aidoc/CARPL/Blackford exclus) ; les API LLM cloud (Claude, Gemini) sont
acceptées ; tout se passe dans MediView.

## Buts

1. Chaque coupe dépistée par un modèle cloud sérieux (plus de goulot qwen).
2. Double lecture croisée par deux familles de modèles + réconciliation visible.
3. Les 56 études incomplètes réimportées (ops).
4. Mesures automatiques de volumes rétablies (TotalSegmentator sur VPS72, CPU).

## Hors périmètre (non-buts)

- Certification médicale : le CR reste un brouillon signé par le médecin.
- Fournisseurs d'IA radio tiers, marketplace, Orthanc/DICOMweb.
- Achat de GPU ; le VPS72 reste CPU.
- Le mode rapide local (pré-analyse) et son comportement par défaut.

## Volet A — Dépistage cloud Gemini Flash (Vertex UE)

- Nouveau client `server/report/geminiVision.ts` : appel vision Vertex UE en
  réutilisant la config existante (`geminiVertexProject/Location/Token`), modèle
  dédié `GEMINI_SCREEN_MODEL` (défaut `gemini-2.5-flash`).
- `screenBatch` (exhaustivePreanalysis.ts) route vers Gemini Flash quand
  `cloudAiPhiConsent` **et** la config Vertex sont présents ; sinon, et sur toute
  erreur, **repli automatique sur le qwen local** (fail-soft, comportement actuel
  conservé comme filet).
- Dépistage en 512 px (au lieu de 384), lots de 16. Contrat inchangé : numéros
  de coupes suspectes ou « RAS ».
- Phase 2 (rapport Opus 5, ≤30 coupes pleine résolution) inchangée.
- Coût visé ~0.10–0.30 CHF par CT.

## Volet B — Double lecture croisée Opus 5 × Gemini 2.5 Pro

- Nouvelle fonction `secondReadGemini` : Gemini 2.5 Pro (Vertex UE) reçoit les
  MÊMES images clés + contexte (indication, modalité, mesures) et produit un
  mini-CR indépendant (résultats, conclusion, abnormal). Il ne voit PAS la
  lecture d'Opus 5 (indépendance).
- Réconciliation par Opus 5 : compare les deux lectures → section « Double
  lecture (Opus 5 × Gemini) » dans le CR : points d'accord, désaccords listés
  comme « points de vigilance à vérifier par le médecin ».
- Remplace `secondOpinionAbnormal` (qwen 3b) DANS LE FLUX EXHAUSTIF uniquement ;
  le champ `secondOpinion` est étendu (modèle, désaccords) et affiché dans
  `ReportPanel.tsx`. Fail-soft : si Gemini échoue, le CR sort sans la section,
  avec mention honnête.

## Volet C — Micro-service TotalSegmentator CPU (VPS72)

- FastAPI + TotalSegmentator mode rapide CPU, conteneur Docker dans la stack
  médicale du VPS72, **réseau interne uniquement** (les DICOM ne quittent pas le
  VPS). Un job à la fois (sémaphore), timeout généreux.
- Contrat = celui déjà consommé par `ctSegmentation.ts` (zip DICOM en entrée ;
  JSON `{durationS, count, structures[{name, volumeMl}], overlays?}`) — relire le
  fichier pour coller à l'API exacte (endpoint, champs) avant d'écrire le service.
- `SEG_SERVICE_URL` posé dans le `.env` mediview → le code existant réintègre les
  mesures dans le CR sans autre changement.
- Pré-requis : vérifier l'espace disque VPS72 (récemment 91 %) — ~5 Go modèles.

## Volet D — Réimport des 56 études incomplètes (ops, pas de code)

- Backfill PACS sur les 3 archives (.180/.210/.211) pour les études scano-only,
  procédure existante (fiche mediview-backfill-pacs), hors heures de charge.
- Critère de succès : le refus honnête « import incomplet » disparaît pour ces
  études (série de coupes diagnostique présente).

## Erreurs & garde-fous

- Tout chemin cloud reste gardé par `cloudAiPhiConsent` (Claude ET Gemini).
- Chaque étage est fail-soft : échec Gemini dépistage → qwen local ; échec
  double lecture → CR sans section ; échec segmentation → CR sans mesures.
- Jamais de CR silencieusement dégradé : le CR nomme les étages qui ont tourné
  (modèles) comme aujourd'hui (`result.model`).

## Tests

- TDD Vitest sur fonctions pures/isolables : routage du dépistage (Gemini vs
  repli), parsing des réponses Gemini, construction du prompt de dépistage,
  réconciliation double lecture, extension `secondOpinion`.
- `selectExhaustiveSeries`/anti-scanogramme : non-régression (tests existants).

## Déploiement

- Procédure MediView habituelle : build Mac→VPS72, tag image + tag rollback,
  `docker compose up -d`, ping santé, hard-refresh SPA (piège chunks périmés).
- Nouvelles variables : `GEMINI_SCREEN_MODEL`, `GEMINI_SECOND_READ_MODEL`
  (défaut `gemini-2.5-pro`), `SEG_SERVICE_URL`.

## Coût/durée attendus

~1–2 CHF et ~5–10 min par examen complet (dépistage Flash + rapport Opus 5 +
relecture Gemini Pro). Non bloquant : job de fond existant, le client sonde.
