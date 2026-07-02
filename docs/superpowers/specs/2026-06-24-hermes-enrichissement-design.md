# Hermès — Enrichissement agent : 8 nouveaux outils

## Contexte

Hermès Copilote (MediView, branche `self-host`) est l'agent conversationnel côté serveur.
Il utilise Ollama local (`qwen2.5:14b`) via `streamOllamaChat`, respecte le tool-gate
(`assertToolAllowed` + `runAgentTool`), et ne sort jamais de PHI du périmètre de confiance.

Ce design ajoute **8 outils** répartis en 4 groupes, tous enregistrés dans `registry.ts`
et accessibles uniquement à l'agent `copilote`.

---

## Architecture globale

**Pattern retenu : tout en outils Hermès (Option 1).**

Chaque capacité est un outil déclaré dans `AgentSpec` du copilote avec une fonction
implémentée dans `server/tools/`. Le tool-gate existant filtre les accès ; aucun
middleware d'injection automatique n'est ajouté.

```
Hermès chat
  └─ streamOllamaChat (tool_use)
       └─ runAgentTool → assertToolAllowed
            ├─ searchVault(query)           [Group A]
            ├─ getWeather()                 [Group B]
            ├─ getLocalTime()               [Group B]
            ├─ calendarToday(date?)         [Group B]
            ├─ pubmedSearch(query)          [Group C]
            ├─ searchGuidelines(query)      [Group C]
            ├─ getCRDraft(studyId)          [Group D]
            ├─ requestCRGeneration(studyId) [Group D]
            └─ listPendingSignatures()      [Group D]
```

**Pipeline learn (Group A, hors tool-gate) :**

```
report.sign → sectionsChangedSignificantly? → collectCorrections → applySuggestionAsChunk
  → knowledgeChunks (source="learning:")
```

**Cron guidelines (Group C, hors tool-gate) :**

```
cron 03:00 → guidelinesSync → fetch ESR/ACR/RSNA RSS → chunk → embed → knowledgeChunks
  (source="guidelines:")
```

---

## Group A — Vault RAG + auto-amélioration

### Outil : `searchVault(query: string)`

**Fichier :** `server/tools/vaultTools.ts`

1. `embedText(query)` → vecteur 768 dims via Ollama
2. `searchSimilar(vector, { sourcePrefix: 'vault:', limit: 5 })`
3. `buildContextFromChunks(chunks)` → texte formaté
4. Retourne `{ context: string, sources: string[] }`

`searchSimilar` dans `store.ts` doit accepter un paramètre optionnel `sourcePrefix?: string`
ajoutant `WHERE source LIKE CONCAT(?, '%')`. À étendre si absent (probable).

**Isolation :** seule la table `knowledgeChunks` est lue. Pas de chemin fichier direct
dans la réponse. Les chunks vault sont préfixés `vault:` (existant dans `vaultSync.ts`).

### Cron vault sync

`server/knowledge/vaultSync.ts` → `syncVault()` existe.
Ajouter une route tRPC `knowledge.syncVault` (admin only) + un cron VPS `0 2 * * *` :

```sh
curl -X POST https://mediview.ch/api/trpc/knowledge.syncVault \
  -H "Authorization: Bearer $VAULT_SYNC_TOKEN"
```

`VAULT_SYNC_TOKEN` dans `.env`, jamais versionné.

### Pipeline auto-amélioration

**Fichier :** `server/agents/learning.ts` (existe — à brancher)

Déclencheur : dans `reports.sign` (router tRPC), après mise à jour du statut,
appeler `maybeLearnFromReport(reportId, db)` :

1. `selectRelevant` récupère le brouillon IA vs. le texte signé final
2. `sectionsChangedSignificantly()` → si faux, skip
3. `collectCorrections()` → liste de corrections structurées
4. `applySuggestionAsChunk()` → insert dans `knowledgeChunks` avec `source = "learning:"`

Aucune écriture directe dans le vault Obsidian. Hermès bénéficie des corrections
au prochain `searchVault` (learning chunks remontés avec vault chunks).

---

## Group B — Météo + fuseau horaire + calendrier

**Fichier :** `server/tools/contextTools.ts`

### Outil : `getWeather()`

- Source : Open-Meteo (`https://api.open-meteo.com/v1/forecast`) — gratuit, RGPD-friendly, hébergé en Europe, pas de clé requise.
- Config : `CABINET_LAT`, `CABINET_LNG` dans `.env` (ex. Genève : 46.2044, 6.1432).
- Paramètres fetchés : `temperature_2m`, `weathercode`, `precipitation`, `wind_speed_10m` (current + prévision J+1).
- Si réseau indisponible → retourne `{ available: false, reason: "météo indisponible" }`.
- Retour : `{ temperature: number, condition: string, tomorrow: { ... } }`

### Outil : `getLocalTime()`

- Pas d'API externe. `new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', ... }).format(new Date())`
- Retourne `{ iso: string, formatted: string, timezone: "Europe/Zurich" }`

### Outil : `calendarToday(date?: string)`

Date par défaut = aujourd'hui (ISO). Fusionne deux sources :

**Source 1 — Google Calendar (service account)**

- Lib : `googleapis` (npm), clé JSON service account dans `GOOGLE_SA_KEY_JSON` (env var contenant le JSON stringifié).
- Le calendrier du médecin est partagé en lecture avec l'email du service account.
- Appel : `calendar.events.list({ calendarId, timeMin, timeMax, singleEvents: true })`
- Timeout 5s ; si échec → source ignorée, pas d'erreur bloquante.

**Source 2 — MySQL études**

- `SELECT studyId, modality, studyDate FROM studies WHERE DATE(studyDate) = ?`
- Retourne uniquement `studyId + modality + studyDate` — pas de nom patient (PHI).

**Fusion :** tri chronologique, dédup par `studyId`. Retour :

```ts
{
  events: Array<{
    time: string;
    title: string;
    source: "gcal" | "studies";
    studyId?: string;
  }>;
}
```

---

## Group C — Veille radiologie

**Fichier :** `server/tools/researchTools.ts` + `server/knowledge/guidelinesSync.ts`

### Outil : `pubmedSearch(query: string, maxResults?: number)`

- NCBI E-utilities (API publique HTTPS).
  - Step 1 : `esearch.fcgi?db=pubmed&term=<query>&retmax=<maxResults>&sort=relevance`
  - Step 2 : `efetch.fcgi?db=pubmed&id=<pmids>&rettype=abstract&retmode=text`
- Clé NCBI optionnelle : `NCBI_API_KEY` dans `.env` (lève la limite 3 req/s → 10 req/s).
- `maxResults` par défaut : 5, max : 10.
- Résultats éphémères (non stockés). Retour : liste `{ pmid, title, abstract, year }`.
- Timeout 10s ; si échec réseau → `{ available: false }`.

### Outil : `searchGuidelines(query: string)`

- Identique à `searchVault` mais filtre `source LIKE "guidelines:%"`.
- `embedText(query)` → `searchSimilar(vector, { sourcePrefix: 'guidelines:', limit: 5 })`
- Retour : `{ context: string, sources: string[] }`

### Cron guidelines sync

**Fichier :** `server/knowledge/guidelinesSync.ts`

Sources initiales (liste en dur, extensible via `.env`) :

- ESR RSS : `https://www.myesr.org/rss/guidelines`
- ACR : pages guidelines publiques (fetch HTML → extract text)
- Quelques requêtes PubMed de fond : `"radiology"[jour] AND "review"[pt]` (derniers 90j)

Logique :

1. Fetch chaque source (HTTP, timeout 15s)
2. `chunkMarkdown()` ou découpage par paragraphe
3. `embedText()` par chunk
4. `insertChunks()` avec `source = "guidelines:<source-slug>"` et `updatedAt = NOW()`
5. Purge les chunks `source LIKE "guidelines:%"` datant de plus de 90 jours

Cron VPS : `0 3 * * *` (même pattern que vault sync).
Route admin tRPC `knowledge.syncGuidelines` pour déclenchement manuel.

---

## Group D — Hermès ↔ Agent CR

**Fichier :** `server/tools/crTools.ts`

### Outil : `listPendingSignatures()`

- Query : `SELECT studyId, modality, studyDate FROM reports JOIN studies WHERE reports.status = 'pending_signature'`
- Retourne max 10 entrées. Pas de PHI (pas de nom patient).
- Retour : `{ pending: Array<{ studyId, modality, studyDate, reportId }> }`

### Outil : `getCRDraft(studyId: string)`

- Vérifie que `studyId` appartient bien à une étude existante (anti-IDOR : même garde que les routes existantes).
- Lit `reports WHERE studyId = ? ORDER BY createdAt DESC LIMIT 1`.
- Retourne `{ status, draftText, modality, studyDate }`.
- `draftText` = texte du brouillon (non-PHI : c'est le rapport généré, pas les données patient brutes).

### Outil : `requestCRGeneration(studyId: string)`

- Vérifie qu'aucun rapport `pending_signature` n'existe pour ce `studyId` (évite doublon).
- Si un rapport `draft` existe déjà → retourne `{ alreadyExists: true, status: "draft" }`.
- Sinon → appelle `autoReportAgent.triggerForStudy(studyId)` de façon asynchrone (fire-and-forget).
- Retourne `{ jobStarted: true, studyId, expectedDelaySeconds: 30 }`.

**Garde-fous :** aucun outil de signature ou d'envoi email n'est exposé à Hermès.
Le chemin `sign → email` reste humain-in-the-loop.

---

## Enregistrement dans le registry

`server/agents/registry.ts` — agent `copilote`, section `tools` :

```ts
tools: [
  "searchPatient",
  "explainReport",
  // Group A
  "searchVault",
  // Group B
  "getWeather",
  "getLocalTime",
  "calendarToday",
  // Group C
  "pubmedSearch",
  "searchGuidelines",
  // Group D
  "listPendingSignatures",
  "getCRDraft",
  "requestCRGeneration",
];
```

Chaque outil = une entrée dans le map `TOOL_REGISTRY` de `tools.ts` avec sa fonction.

---

## Schéma DB

**Aucune migration nécessaire.** `knowledgeChunks` existe déjà et supporte tous les
prefixes source (`vault:`, `learning:`, `guidelines:`). Google Calendar = service account
→ clé dans `.env`, pas de table.

---

## Variables d'environnement ajoutées

| Variable             | Groupe | Description                                        |
| -------------------- | ------ | -------------------------------------------------- |
| `VAULT_SYNC_TOKEN`   | A      | Token Bearer pour déclencher syncVault via HTTP    |
| `CABINET_LAT`        | B      | Latitude GPS du cabinet (ex: 46.2044)              |
| `CABINET_LNG`        | B      | Longitude GPS du cabinet (ex: 6.1432)              |
| `GOOGLE_SA_KEY_JSON` | B      | JSON stringifié du service account Google Calendar |
| `NCBI_API_KEY`       | C      | Clé NCBI optionnelle (≥ 3 req/s)                   |

Toutes dans `.env` (gitignoré). `.env.example` mis à jour.

---

## Tests

- Chaque outil testé unitairement avec `vi.mock` sur les dépendances réseau (fetch, googleapis, Ollama).
- Pipeline learn : test que `maybeLearnFromReport` insère un chunk si diff significatif, skip sinon.
- `assertToolAllowed` : test que les outils D ne sont pas accessibles à l'agent `redacteur`.
- Vitest, mêmes conventions que le projet existant.

---

## Out of scope

- UI admin pour gérer les outils ou la liste des guidelines sources
- Signature automatique ou envoi d'email par Hermès
- Modification du vault Obsidian par Hermès (read-only)
- Cloud US pour PHI
- Multi-tenant (mono-cabinet)
- Authentification OAuth utilisateur pour Google Calendar (service account suffit)
