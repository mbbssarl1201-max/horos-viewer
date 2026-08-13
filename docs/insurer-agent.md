# Agent SUVA — runbook de mise en production

Spec : `docs/superpowers/specs/2026-08-13-agent-suva-design.md`. Ce document
couvre uniquement la mise en prod : création de la boîte, variables d'env,
migration, déploiement, vérifications post-deploy, test E2E et révocation.

## Fonctionnement (rappel)

Un poller IMAP (`server/insurer/mailPoller.ts`, intervalle 2 min, no-op tant
que `INSURER_IMAP_HOST` est vide) lit la boîte dédiée. Chaque mail est
enregistré (`insurer_requests`, idempotent par `Message-ID`), puis passe le
pipeline : extraction (texte + pièces jointes via LLM/vision CH — jamais un
fournisseur US) → identification patient multi-critère (jamais la DDN seule)
→ recherche des études → colisage (CR PDF + ZIP DICOM sur lien à jeton,
`insurer_bundle_tokens`, haché, expirable, révocable). Le contenu des mails
entrants est traité comme non fiable (parsing pur, jamais d'instructions
exécutées).

L'envoi est **automatique** seulement si les 4 conditions sont TOUTES
réunies (sinon statut `a_valider` + notification au gérant + validation
1 clic sur `/demandes-assureurs`) :

1. expéditeur du mail entrant dans `INSURER_TRUSTED_SENDERS` ;
2. patient identifié de façon unique et exacte (nom + prénom + DDN) ;
3. toutes les études demandées trouvées, à date exacte ;
4. adresse de réponse dans un domaine de `INSURER_AUTO_SEND_DOMAINS`
   (`suva.ch`).

Tout envoi (auto ou validé) passe par la garde d'egress
`isAllowedPhiRecipientStrict` (fail-closed) : le destinataire doit être dans
`REPORT_EMAIL_ALLOWED_DOMAINS`, sans quoi l'envoi est bloqué même si les 4
conditions ci-dessus sont remplies.

## 1. Créer la boîte mail dédiée (Mailu, VPS72)

Le Mailu du VPS72 sert aujourd'hui `DOMAIN=mediadmin.ch`
(`HOSTNAMES=mail.mediadmin.ch`) — il ne sert pas encore `mediview.ch`. Deux
options, **à trancher par le gérant au déploiement** :

**Option A — zéro DNS (rapide)**
Créer la boîte `suva@mediadmin.ch` directement dans l'admin Mailu (mot de
passe fort, généré). Aucune modification DNS. Inconvénient : l'adresse ne
porte pas le nom de MediView/mediview.ch.

**Option B — propre (ajoute le domaine mediview.ch à Mailu)**

1. Dans l'admin Mailu : ajouter le domaine `mediview.ch`.
2. Chez Hostinger (DNS de `mediview.ch`) : ajouter un enregistrement
   MX `mediview.ch → mail.mediadmin.ch` (priorité 10) + un enregistrement
   SPF (`TXT` `v=spf1 mx ~all` ou fusionné avec un SPF existant sur le
   domaine).
3. Créer la boîte `suva@mediview.ch` dans l'admin Mailu.

Dans les deux cas : noter le mot de passe (gestionnaire de secrets, jamais
dans un `.md` versionné — cf. règle globale secrets), et vérifier la
connexion IMAP avant d'activer le poller (`openssl s_client -connect
mail.mediadmin.ch:993` ou un client mail de test).

## 2. Variables d'environnement (`/opt/medical/mediview/.env`)

À ajouter/mettre à jour :

```
INSURER_IMAP_HOST=mail.mediadmin.ch      # ou l'IP du conteneur front Mailu
INSURER_IMAP_PORT=993
INSURER_IMAP_USER=suva@mediadmin.ch      # ou suva@mediview.ch (option B)
INSURER_IMAP_PASS=<mot de passe fort>
INSURER_TRUSTED_SENDERS=institut.med.champel@gmail.com
INSURER_AUTO_SEND_DOMAINS=suva.ch
INSURER_NOTIFY_EMAIL=institut.med.champel@gmail.com
REPORT_EMAIL_ALLOWED_DOMAINS=gmail.com,suva.ch
```

`REPORT_EMAIL_ALLOWED_DOMAINS` est actuellement `gmail.com` en prod : il
faut y **ajouter** `suva.ch` (ne pas le remplacer, l'envoi des CR existants
vers `gmail.com` doit continuer à fonctionner). Si le cabinet transfère
depuis d'autres adresses que `institut.med.champel@gmail.com`, les ajouter à
`INSURER_TRUSTED_SENDERS` (séparateur `,`).

`INSURER_IMAP_MAILBOX` (défaut `INBOX`) n'a pas besoin d'être posée sauf cas
particulier.

Ne pas activer `INSURER_IMAP_HOST` avant d'avoir vérifié la connexion IMAP
(étape 1) : tant qu'il est absent, le poller reste no-op (aucun risque).

## 3. Migration SQL manuelle

Fichier : `drizzle/0020_gorgeous_blizzard.sql` (2 `CREATE TABLE` :
`insurer_requests`, `insurer_bundle_tokens`). `__drizzle_migrations` n'est
pas fiable sur cette instance (migrations passées appliquées à la main) —
toujours vérifier l'absence préalable des tables avant d'exécuter :

```sh
docker exec -it mysql-medical mysql -uroot -p horos \
  -e "SHOW TABLES LIKE 'insurer%';"
# doit renvoyer un résultat vide
docker exec -i mysql-medical mysql -uroot -p horos < drizzle/0020_gorgeous_blizzard.sql
docker exec -it mysql-medical mysql -uroot -p horos \
  -e "SHOW TABLES LIKE 'insurer%';"
# doit renvoyer insurer_bundle_tokens + insurer_requests
```

## 4. Déploiement

Procédure standard MediView (build Mac → tgz → VPS76 → VPS72,
`/opt/medical/mediview` = dossier d'artefacts, PAS un checkout git) :

1. `pnpm build` sur le Mac (gate déjà vérifiée : `pnpm vitest run`,
   `pnpm check` et `pnpm build` tout vert — voir rapport Task 10).
2. `COPYFILE_DISABLE=1 tar czf /tmp/mediview-deploy.tgz --exclude='._*' dist drizzle patches package.json pnpm-lock.yaml drizzle.config.ts tsconfig.json`
3. `scp` Mac → VPS76 → `root@72.62.26.49:/tmp/` (pas d'accès SSH direct
   Mac→72), contrôler le `sha256sum` aux deux bouts.
4. Sur le 72, dans `/opt/medical/mediview` : sauvegarder
   `cp -a dist dist.bak-<date>` + `docker tag horos-viewer:depot
horos-viewer:rollback-<date>`, extraire le tgz, `find . -name '._*' -delete`.
5. Appliquer la migration (étape 3 ci-dessus) **avant** de redémarrer le
   conteneur applicatif.
6. `docker build -f Dockerfile.prebuilt -t horos-viewer:depot . && docker compose up -d --force-recreate mediview`.

**Rollback** : `docker tag horos-viewer:rollback-<date> horos-viewer:depot &&
docker compose up -d mediview` (+ restaurer `dist.bak-<date>` si rebuild
nécessaire).

## 5. Vérifications post-déploiement

Pings habituels :

- `/healthz` → 200
- `/login` et `/` → 200
- `/api/export/pdf-report/1` et `/storage/x` sans session → 401
- `/r/bogus` → 410

`docker logs mediview-app` : **attention, il n'existe pas de ligne positive
« poller démarré »** — le code (`demarrerPollerAssureur`) ne logge que le
cas désactivé :

```
[insurer] poller IMAP désactivé (INSURER_IMAP_HOST absent)
```

La vérification correcte est donc l'**absence** de cette ligne dans les
logs qui suivent le démarrage (elle apparaît une seule fois, au boot, si
`INSURER_IMAP_HOST` est vide). Si elle apparaît malgré les variables
posées : vérifier que le `.env` a bien été relu par le conteneur
(`--force-recreate`, pas juste `restart`). Ensuite, laisser passer un cycle
(~2 min) et vérifier l'absence d'erreurs `[insurer] passe boîte échouée` /
`[insurer] passe échouée` dans les logs, ce qui confirme une connexion IMAP
correcte.

## 6. Test end-to-end (patient fictif)

1. Transférer un mail au format SUVA réel (texte + pièce jointe si possible)
   vers la boîte dédiée, en utilisant un **patient fictif** existant dans
   MediView (jamais un vrai dossier patient pour un test).
2. Suivre `docker logs -f mediview-app` : la demande doit apparaître en base
   (`recue` → `extraite` → `identifiee`/`a_valider` selon le matching).
3. Aller sur `/demandes-assureurs` : la demande doit apparaître avec le
   statut, l'extraction lue, le patient identifié et les études trouvées.
4. Si `a_valider` : vérifier l'email de notification reçu à
   `INSURER_NOTIFY_EMAIL`, puis valider manuellement sur la page.
5. Vérifier la réception du mail de réponse (CR PDF + lien de
   téléchargement), et que le lien `/dl/...` fonctionne (téléchargement du
   ZIP DICOM).
6. Nettoyage : révoquer le lien (étape 7) après le test.

## 7. Révoquer un lien de téléchargement

Sur `/demandes-assureurs`, ouvrir la demande concernée puis cliquer
« Révoquer le lien » (bouton désactivé s'il n'y a aucun jeton actif ; une
confirmation est demandée). Le jeton est marqué révoqué en base
(`revoqueLe`) : toute tentative de téléchargement ultérieure renvoie 410,
sans possibilité de le réactiver — en cas de besoin, renvoyer un nouveau
colis depuis la même page (`resend`).
