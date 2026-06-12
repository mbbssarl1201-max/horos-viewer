# Compte-rendu radiologique IA — Design

> **Statut** : design validé (brainstorming) · **Date** : 2026-06-12 · **Repo** : `horos-viewer` (MediView)
> **Prochaine étape** : plan d'implémentation (`superpowers:writing-plans`).

## Problème

MediView génère un brouillon IA **éphémère** (utilisé pour email/PDF), mais n'a **aucun
compte-rendu persisté, structuré et signable**. Un radiologue ne peut donc pas produire un
document officiel, immuable, qui fasse foi.

## Objectifs (critères de succès)

1. L'IA produit un brouillon **structuré en 4 sections** (Indication · Technique ·
   Résultats+comparaison antériorités · Conclusion), **PHI-safe** (backend hybride, défaut
   Ollama local).
2. Le compte-rendu est **persisté** (entité `reports`, cycle Brouillon→Signé).
3. La **signature du médecin** le verrouille : immuable, signataire + horodatage, **PDF
   officiel**, journalisé (audit).
4. Correction post-signature = **addendum daté** (le signé d'origine reste intact).

## Non-objectifs (hors scope)

- ❌ Facturation TARDOC/CIM-10 & pont **MediAdmin/Hermès** → projet d'intégration **séparé** (cloisonnement).
- ❌ Modèles par modalité / éditeur de modèles configurables.
- ❌ Dictée vocale, collaboration multi-lecteurs temps réel.
- ❌ Multi-versions de brouillon (un brouillon par étude).
- ❌ **Signature électronique qualifiée** cryptographique (on enregistre signataire +
  horodatage + audit ; la signature qualifiée est une étape réglementaire ultérieure).
- ❌ Re-câblage de la pré-analyse IA existante (on la **réutilise**).

## Architecture

Approche retenue : **entité `reports` dédiée + sortie IA structurée**, en réutilisant
l'infrastructure existante (échantillonnage volume + coupe-clé de `aiPreanalysis`,
antériorités `patientHistory`, génération PDF `reportPdf`, audit `server/audit.ts`, backend
LLM hybride Claude/Ollama). Tout passe par tRPC, gated rôle + accès-étude (anti-IDOR).

```
ReportPanel (UI 4 sections + Signer/Addendum)
   │  tRPC reports.*
   ▼
routeur reports ── aiGenerate ──► aiPreanalysis (échantillon volume + coupe-clé)
   │                          └─► patientHistory (antériorités)
   │                          └─► LLM hybride (Ollama local PHI-safe / Claude) → JSON zod
   ├─ upsertDraft (rejet si signé)
   ├─ sign ──► reportPdf (PDF officiel) → MinIO ; audit
   ├─ addAddendum ──► report_addenda ; régénère PDF ; audit
   └─ getByStudy / pdfUrl
   ▼
DB : reports (1/étude) + report_addenda (append-only)
```

## Modèle de données (migration manuelle, drizzle)

**`reports`** — un compte-rendu par étude (`studyId` unique)

| champ                                            | type                       | rôle                         |
| ------------------------------------------------ | -------------------------- | ---------------------------- |
| `id`                                             | pk                         |                              |
| `studyId`                                        | fk → studies, unique       | l'étude                      |
| `status`                                         | enum `'draft' \| 'signed'` | cycle de vie                 |
| `indication` `technique` `findings` `impression` | text                       | les 4 sections               |
| `aiGenerated`                                    | boolean                    | brouillon issu de l'IA       |
| `aiModel`                                        | varchar                    | modèle utilisé (traçabilité) |
| `createdBy`                                      | userId                     | auteur du brouillon          |
| `createdAt` `updatedAt`                          | timestamp                  |                              |
| `signedBy`                                       | userId, null               | médecin signataire           |
| `signedAt`                                       | timestamp, null            | date de signature            |
| `pdfStorageKey`                                  | varchar, null              | PDF officiel (MinIO)         |

**`report_addenda`** — corrections post-signature (append-only)

`id` (pk) · `reportId` (fk → reports) · `text` · `createdBy` (userId) · `createdAt`

## Cycle de vie (machine à états, testable)

- **draft** : éditable par le médecin ; l'IA peut (re)générer ; champs mutables.
- **signed** : **immuable** — le serveur **rejette** toute modification (`status !== 'draft'`
  → FORBIDDEN) ; seule action permise = ajouter un **addendum daté**.
- Transitions : `draft --sign--> signed` ; `signed --addAddendum--> signed`.
- Helpers purs : `canEdit(status)`, `canSign(status, sections)`, `canAddendum(status)`.

## Génération IA (structurée)

- Endpoint `reports.aiGenerate({studyId})` :
  1. réutilise l'**échantillonnage volume** + la **coupe-clé** de `aiPreanalysis` (images base64) ;
  2. ajoute le contexte **antériorités** (`patientHistory`) ;
  3. demande au LLM une **sortie JSON** `{indication, technique, findings, impression}`,
     validée par **zod** côté serveur (parsing défensif : si le modèle renvoie du texte
     hors-JSON, fallback dans `findings`) ;
  4. la comparaison antériorités est **tissée dans `findings`**.
- Backend **hybride** : défaut **Ollama vision local (PHI-safe)** ; Claude via ENV (comme
  l'existant `aiPreanalysis`).
- Le brouillon **pré-remplit** le draft sans écraser une saisie médecin déjà présente.
- **Fail-soft** : échec/timeout LLM → panneau éditable, saisie manuelle, jamais bloquant.

## Signature, immuabilité, PDF, audit

- `reports.sign({reportId})` — **rôle médecin** :
  1. vérifie `status==='draft'` + **Conclusion non vide** ;
  2. `status='signed'`, `signedBy`, `signedAt` ;
  3. génère le **PDF officiel** (4 sections + images-clés + en-tête patient via
     `champelHeader` + bloc « Signé par Dr X le … ») via `reportPdf` **étendu** → MinIO
     (`pdfStorageKey`) ;
  4. **audit** `report.sign`.
- Immuabilité **au serveur** : `upsertDraft` rejette si `status==='signed'`.
- `reports.addAddendum({reportId, text})` — médecin : ajoute une ligne datée dans
  `report_addenda`, **régénère le PDF** (addenda à la suite), audit `report.addendum`.
- Audit `report.generate` / `report.sign` / `report.addendum` (userId + reportId + studyId).

## Surface API (routeur tRPC `reports`)

| procédure                          | accès                | effet                               |
| ---------------------------------- | -------------------- | ----------------------------------- |
| `getByStudy({studyId})`            | accès-étude          | CR + addenda                        |
| `upsertDraft({studyId, sections})` | médecin, accès-étude | crée/màj brouillon ; rejet si signé |
| `aiGenerate({studyId})`            | médecin, accès-étude | brouillon structuré (pré-remplit)   |
| `sign({reportId})`                 | médecin              | verrou + PDF + audit                |
| `addAddendum({reportId, text})`    | médecin              | addendum + régénère PDF + audit     |
| `pdfUrl({reportId})`               | accès-étude          | URL présignée du PDF officiel       |

Anti-IDOR : `report ∈ study` vérifié via le contrôle d'accès étude existant ; toutes les
mutations gated par le rôle médecin.

## UI (`ReportPanel` → éditeur de compte-rendu)

- 4 zones de texte (Indication · Technique · Résultats · Conclusion).
- Boutons : **Générer (IA)** · **Enregistrer brouillon** · **Signer** (médecin, confirmation).
- Si `signed` : champs **lecture seule** + bloc signature (Dr X, date) + liste addenda +
  **Ajouter un addendum** (médecin) + **Télécharger PDF**.
- Charge le CR existant (`getByStudy`) ; sinon brouillon vierge (option auto-IA conservée).
  Images-clés conservées (mécanisme existant).

## Tests

- **Logique pure** (vitest, pattern repo) : machine à états (`canEdit/canSign/canAddendum`),
  validation zod du JSON IA + parsing défensif, assemblage des sections PDF.
- **Serveur** : immuabilité (`upsertDraft` rejeté si signé), gardes rôle/accès-étude.

## Intégration & déploiement

- **Migration DB manuelle** (règle prod MBBS) : nouvelles tables `reports` / `report_addenda`
  — fournir le SQL à appliquer.
- Déploiement branche `self-host` (PR), jamais `main`.
- Revue sécu (anti-IDOR `report ∈ study`, rôle médecin) avant déploiement.
