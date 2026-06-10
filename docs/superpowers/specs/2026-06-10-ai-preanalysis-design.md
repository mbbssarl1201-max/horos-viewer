# Spec — Pré-analyse IA des images clés (brouillon de compte rendu, médecin→médecin)

- **Date** : 2026-06-10
- **Projet** : horos-viewer (visualiseur DICOM, PHI)
- **Statut** : design validé (brainstorming), en attente de relecture utilisateur avant plan
- **Sous-système** : **A** (diagnostic assisté par IA). Complète **B+C** (compte rendu PDF + ciné MP4) déjà livrés et déployés.

## 1. Problème

Rédiger le compte rendu radiologique prend du temps. On veut qu'une **IA locale** propose un **brouillon** des sections _Résultats_ et _Conclusion_ à partir des **images clés** sélectionnées par le médecin, pour accélérer la rédaction. Le médecin valide/corrige/signe avant envoi au confrère. Destiné aux médecins, jamais envoyé tel quel au patient.

## 2. Cadre réglementaire & PHI (déterminant)

- **Assistance uniquement** : l'IA produit un **brouillon** ; la validation et la **signature du médecin** sont obligatoires avant tout envoi. Le médecin signataire engage sa responsabilité. Ce n'est **pas** un dispositif médical certifié et l'app ne le prétend pas.
- **PHI 100 % local** : les images ne quittent **jamais** le périmètre de confiance. Le VLM tourne sur l'Ollama auto-hébergé du VPS (`ollama-hermes`). **Aucun cloud.**
- **Qualité** : VLM **généraliste** open-source (pas un modèle radiologue) → brouillon **grossier**, à valider. Le prompt impose l'expression de l'incertitude et interdit d'inventer mesures/chiffres.
- **Mention obligatoire** dans le PDF quand le brouillon IA a servi : « Pré-analyse assistée par IA, validée par le médecin signataire ».

## 3. Objectifs (critères de succès)

1. Depuis le panneau Compte rendu, un bouton **« Pré-analyse IA »** (actif si ≥1 image clé) envoie les **PNG des images clés** au VLM local et récupère un brouillon FR `{ resultats, conclusion }`.
2. Le brouillon **pré-remplit** les champs _Résultats_/_Conclusion_ (modifiables), avec un **badge « généré par IA — à valider »** et un disclaimer visible.
3. Le médecin édite, signe, puis envoie via le flux PDF + MP4 existant (C+B). Le PDF porte la **mention IA**.
4. Tout est **local**, **audité**, **rate-limité**, et **fail-soft** (panne IA ⇒ rédaction manuelle, pas de blocage).

## 4. Approche retenue

**① VLM léger sur l'Ollama du VPS** (validé contre : Mac/Metal = pas fiable en prod ; cloud = egress PHI ; assistant texte sans vision = écarté car on veut lire les images). Le serveur appelle `ollama-hermes` (même réseau Docker que l'app) avec un modèle vision.

## 5. Contrainte infra (à gérer à l'implémentation)

VPS : 31 Go RAM mais **~4 Go libres** (qwen3.6:27b = 17 Go + stack), **8 vCPU, CPU-only**. Aucun modèle vision installé. → Choisir un **petit** VLM (`qwen2.5-vl:3b`, ~3 Go), `keep_alive` court pour libérer la RAM après usage, accepter une **latence de ~15-60 s** pour 1-3 images. Au pull, **vérifier que le modèle charge** dans la RAM dispo ; sinon décharger temporairement le 27B ou ajouter de la RAM (à signaler au gérant).

## 6. Architecture & flux

```
Panneau Compte rendu (images clés capturées)
   │ clic « Pré-analyse IA »
   │ tRPC report.aiPreanalysis  (medicalProcedure + rate-limit + audit)
   ▼
Serveur → POST OLLAMA_URL/api/chat  (modèle OLLAMA_VISION_MODEL)
          messages: prompt système FR + user{ images: [pngBase64...], texte indication }
          options: { keep_alive court }
   ▼
parse la réponse → { resultats, conclusion }
   ▼
Client pré-remplit Résultats/Conclusion (badge IA), médecin valide+signe
   ▼
Envoi PDF (mention IA) + MP4 via report.sendStudyReport (déjà en place)
```

## 7. Composants

### 7.1 Serveur — client VLM `server/report/aiPreanalysis.ts` _(nouveau)_

- `generatePreanalysis(keyImages: Array<{ pngBase64: string; sliceIndex: number }>, opts: { indication?: string }): Promise<{ resultats: string; conclusion: string; model: string }>`.
- Construit la requête Ollama `/api/chat` : message système (radiologie FR, structuré, incertitude explicite, ne pas inventer, ne pas ré-identifier), message utilisateur avec `images` (base64 sans préfixe) + l'indication si fournie. `stream:false`, `keep_alive` court (ex. `"30s"`), timeout généreux (ex. 120 s, `AbortController`).
- Parse la sortie en deux sections (`Résultats:` / `Conclusion:`), avec repli : si le format n'est pas respecté, mettre tout le texte dans `resultats` et `conclusion=""`. Jamais throw sur contenu (fail-soft) ; throw uniquement si Ollama injoignable/timeout.
- Lit `OLLAMA_URL` (défaut `http://ollama-hermes:11434`) et `OLLAMA_VISION_MODEL` (défaut `qwen2.5-vl:3b`) depuis l'env.

### 7.2 Serveur — mutation `report.aiPreanalysis` _(nouveau)_

- `medicalProcedure`, input `{ studyId, keyImages: [{pngBase64, sliceIndex}] (≥1, ≤20, PNG validé signature+IHDR), indication?: string (max 5000) }`.
- Recharge l'étude (`getStudyById`, 404 sinon). Rate-limit (`countRecentAccess` action `study.ai.preanalysis`, ex. ≤30/h). Appelle `generatePreanalysis`. Audit `recordAccess` action `study.ai.preanalysis`. Retourne `{ resultats, conclusion, model }`.

### 7.3 Client — bouton dans `ReportPanel.tsx` _(modif)_

- Bouton **« Pré-analyse IA »** (désactivé si 0 image clé ou pendant l'appel). Appelle `trpc.report.aiPreanalysis`. Au retour, **pré-remplit** `resultats`+`conclusion` (écrase le contenu si l'utilisateur confirme, ou remplit seulement si vide — comportement : remplit toujours, l'utilisateur édite). Affiche un **badge** « généré par IA — à valider » au-dessus des champs et un court disclaimer. État loading (« Analyse en cours… »), erreur fail-soft (« IA indisponible, rédigez manuellement »).
- Nouveau flag local `aiAssisted` (true dès qu'un brouillon IA a été inséré) transmis à l'envoi.

### 7.4 Client/serveur — mention IA dans le PDF _(modif `reportPdf.ts` + `sendStudyReport`)_

- `report.sendStudyReport` reçoit un champ optionnel `aiAssisted: boolean`. `buildReportPdf` ajoute, sous la signature, la mention « Pré-analyse assistée par IA, validée par le médecin signataire. » quand `aiAssisted` est vrai.

### 7.5 Infra

- Variables d'env app : `OLLAMA_URL`, `OLLAMA_VISION_MODEL`. App déjà joignable à `ollama-hermes` ? → **ajouter le réseau** du conteneur ollama au service `horos-app` si nécessaire (vérifier ; `ollama-hermes` est sur `obsidian-mbbs_mbbs-net` que l'app partage déjà — à confirmer au déploiement).
- Pull du modèle : `docker exec ollama-hermes ollama pull qwen2.5-vl:3b`.

## 8. Gestion d'erreurs (fail-soft)

- Ollama injoignable / timeout / modèle absent → la mutation renvoie une erreur claire ; le client affiche « IA indisponible, rédigez manuellement » et **ne bloque pas** la rédaction/l'envoi.
- Réponse IA vide ou hors-format → repli (tout dans `resultats`), pas d'erreur.
- Le compte rendu reste **entièrement utilisable sans IA**.

## 9. Tests (Vitest)

- `generatePreanalysis` : mock `fetch` Ollama → parse correctement `{resultats, conclusion}` depuis une réponse type ; réponse hors-format → repli (tout dans resultats) ; Ollama 5xx/timeout → throw (capté en mutation) ; n'appelle pas Ollama si keyImages vide (la mutation rejette avant).
- Mutation `report.aiPreanalysis` : medicalProcedure, 404 étude absente, rate-limit (≥seuil → 429), validation PNG, audit appelé, retour `{resultats, conclusion, model}`.
- `reportPdf` : avec `aiAssisted:true` la mention IA apparaît ; sans, elle n'apparaît pas.
- Vérif live (après pull modèle) : capturer une image clé → « Pré-analyse IA » → champs remplis (brouillon FR) → éditer → envoyer → PDF avec mention IA.

## 10. Hors-périmètre (non-goals)

Cloud / egress PHI · analyse des 297 coupes (seulement les images clés) · diagnostic autonome ou envoi sans validation médecin · fine-tuning / modèle radiologie certifié · codage CIM-10 / TARDOC · mesures automatiques · streaming de la réponse IA · choix du modèle dans l'UI (env uniquement en v1).
