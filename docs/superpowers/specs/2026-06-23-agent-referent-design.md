# Agent Référent/Envoi Hermès — design

**Date** : 2026-06-23. **Projet** : MediView (horos-viewer), `self-host`, mono-tenant.
**Statut** : design validé (brainstorming). Dernier sous-projet du socle [[agents Hermès]].

## Problème

L'envoi du CR au médecin référent fonctionne déjà (agent CR + `signAndSend` →
`sendStudyReport` après signature). Mais : (1) le **carnet des référents** (`referring_contacts`,
nom→e-mail) n'est ni **visible** ni **gérable** dans l'UI ; (2) il n'y a pas de **journal**
des envois consultable ; (3) l'envoi n'est pas formalisé comme **agent**.

## Objectifs

1. **Annuaire des référents** : lister / ajouter / corriger / supprimer les contacts
   (nom normalisé → e-mail). UI dans les réglages admin.
2. **Suivi des envois** : journaliser chaque envoi de CR comme activité de l'agent `referent`
   (`logAgentActivity("referent","sendReport",...)`), affiché via le journal d'activité existant.
3. **Formaliser l'agent `referent`** au registre (fiche métier, tool-gate `manageContacts`/
   `sendReport`, KPI `envois`).

## Non-objectifs

- ❌ Re-coder l'envoi (déjà fait ; on l'instrumente seulement).
- ❌ Lever la garde « pas d'envoi sans signature » (inchangée).
- ❌ Stocker le **nom patient** (le carnet ne contient que des médecins référents + e-mails).
- ❌ Relances automatiques (option écartée pour ce lot).
- ❌ Migration DB / multi-tenant.

## Composants

1. **db.ts** : `listReferringContacts()` (id, name, email, updatedAt), `deleteReferringContact(id)`.
   (`resolveReferringEmail`/`upsertReferringEmail` existent déjà.)
2. **Registre** (`server/agents/registry.ts`) : agent `referent` — tools
   `["manageContacts","sendReport"]`, access `["report.read","email.send"]`, garde-fous
   « jamais d'envoi sans signature », « carnet = médecins référents, pas de patient », KPI
   `envois` (max).
3. **Router** (`server/routers.ts`) :
   - `referringContacts.list` (medicalProcedure) → contacts.
   - `referringContacts.delete` (adminProcedure {id}).
   - dans `reports.signAndSend` (et l'envoi auto de l'agent CR si distinct) : après un envoi
     réussi, `logAgentActivity("referent","sendReport","ok",{studyId})`.
4. **UI** : panneau « Carnet des référents » (réglages admin) = liste éditable (nom, e-mail,
   supprimer) + champ d'ajout (réutilise `referringContacts.upsert`). Le journal des envois
   s'affiche via `agentsRegistry.activity({agentKey:"referent"})`.

## Garde-fous / sécurité

- Envoi inchangé (garde « pas d'envoi sans signature » intacte) ; on ne fait que **logguer**.
- Carnet = référents (pas de PHI patient) ; `delete`/édition = adminProcedure.
- Tool-gate : `referent` limité à `manageContacts`/`sendReport`.
- Mono-tenant ; activité auditée.

## Tests

- `listReferringContacts` / `deleteReferringContact` (existence + suppression) — via test
  d'intégration si DB requise ; au minimum vérifier les endpoints typés.
- Registre : agent `referent` présent (maj du compte d'agents → 6), tools ⊆ TOOLS.
- Tool-gate : `sendReport` autorisé pour `referent`, refusé ailleurs.

## Migration

Aucune (réutilise `referring_contacts` + `agent_activity`).
