# Horos Viewer — Migration to a Dedicated Domain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status (2026-06-05):** PARKED. Decision was to keep `horos.mbbssarl.ch` for now. Kept on disk for a future dedicated-domain move (e.g. when the Hostinger free domain becomes active). To use a subdomain of an already-live zone instead (e.g. `viewer.mbbssarl.ch`), Task 0's activation gate passes immediately.

**Goal:** Move the live, self-hosted Horos Viewer from `horos.mbbssarl.ch` to its own dedicated domain (the Hostinger free domain), issue a fresh Let's Encrypt certificate for it, and 301-redirect the old domain to the new one.

**Architecture:** Horos runs as the Docker Compose project `horos` at `/docker/horos` on the MBBS VPS (`76.13.55.44`, Hostinger VM 1377524), published by the host-mode Traefik `traefik-fblq` (entrypoint `websecure`, cert resolver `letsencrypt`, ACME HTTP-01). Routing is purely Traefik-label-driven off the single `Host(...)` rule, the app's session cookies are already domain-agnostic (`sameSite:"none"`, `secure` derived from the request — see `server/_core/cookies.ts`), and there is no CORS origin allowlist. So the migration is an **infrastructure/ops change**, not an app-code change: new DNS record → repoint the Traefik rule → new ACME cert → redirect the old host. We update the repo's deploy docs/defaults to keep them as the source of truth.

**Tech Stack:** Hostinger DNS (via MCP `DNS_*` tools or hPanel), Docker Compose, Traefik v3 (`traefik-fblq`), Let's Encrypt (ACME HTTP-01), SSH (key-based, `root@76.13.55.44`), `dig`/`curl` for verification.

---

## ⚠️ The one value you must set — and one contradiction to resolve first

This plan is parameterized by **exactly one** value: the new domain. Set it once in **Task 0, Step 1** as the shell variable `NEW_DOMAIN` and it is used verbatim everywhere below. There are no other placeholders.

**Contradiction to resolve (Task 0 is a hard gate):** Hostinger's domain API currently reports the free domain as `status: "pending_setup"` with `domain: null` (id `29045619`) — i.e. _not yet a registered, DNS-manageable domain_. If you intend to use that free domain, Task 0 proves it is actually active before any change is made. If it is not active with a Hostinger-managed DNS zone, **stop** — you cannot create an A record or get a cert for a name that does not resolve. (Using a subdomain of an already-live zone such as `mbbssarl.ch` sidesteps this entirely.)

**Assumptions (correct them in Task 0 if wrong):**

- Horos will live at the **apex** of the new domain (e.g. `https://<newdomain>/`), using an `@` A record. If you instead want a subdomain (e.g. `viewer.mbbssarl.ch`), set `NEW_DOMAIN` to that full host and change the DNS record `name` from `@` to the subdomain label in Task 1.
- The new domain's DNS zone is managed at **Hostinger** (so the MCP `DNS_*` tools work). If it's managed elsewhere, do the DNS steps at that registrar instead — the record content (`76.13.55.44`) is identical.

---

## File / Resource Map

This task changes infrastructure and three repo files. What each touches:

| Resource                                    | Responsibility                                                                                                                | Where                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Hostinger DNS zone (new domain)             | New `A @ → 76.13.55.44` record so the name resolves to the VPS                                                                | Hostinger (MCP `DNS_updateDNSRecordsV1` or hPanel)   |
| `/docker/horos/docker-compose.yml` (on VPS) | Live Traefik routing labels — the `Host(...)` rule that publishes the app, plus the new old-domain redirect router/middleware | `root@76.13.55.44` via SSH                           |
| `.env.example` (repo)                       | Documented default for `HOROS_DOMAIN` so the source of truth matches the live domain                                          | `~/Documents/GitHub/horos-viewer/.env.example`       |
| `DEPLOY.md` (repo)                          | Deploy doc examples reference the canonical domain                                                                            | `~/Documents/GitHub/horos-viewer/DEPLOY.md`          |
| `docker-compose.yml` (repo)                 | Header comment mentions the required DNS A record domain                                                                      | `~/Documents/GitHub/horos-viewer/docker-compose.yml` |

The app source (cookies, CORS, auth) needs **no** change — verified: `server/_core/cookies.ts` does not pin a cookie domain, and no CORS origin allowlist exists in `server/`.

---

## Task 0: Set the domain variable and resolve the activation contradiction (HARD GATE)

**Files:** none (verification only).

- [ ] **Step 1: Pin the new domain as a shell variable (use this exact var in every later SSH/curl/dig step)**

```bash
# EDIT THIS LINE — put the exact, final domain (no scheme, no trailing dot).
# Apex example: NEW_DOMAIN="myhoros.online"   Subdomain example: NEW_DOMAIN="viewer.mbbssarl.ch"
export NEW_DOMAIN="REPLACE_WITH_THE_NEW_DOMAIN"
export OLD_DOMAIN="horos.mbbssarl.ch"
export VPS_IP="76.13.55.44"
echo "NEW_DOMAIN=$NEW_DOMAIN | OLD_DOMAIN=$OLD_DOMAIN | VPS_IP=$VPS_IP"
```

Expected: the line echoes your real domain, e.g. `NEW_DOMAIN=viewer.mbbssarl.ch | OLD_DOMAIN=horos.mbbssarl.ch | VPS_IP=76.13.55.44`. If it still prints `REPLACE_WITH_THE_NEW_DOMAIN`, **stop and set it.**

- [ ] **Step 2: Confirm the domain (or its parent zone) is registered & active**

Use the Hostinger MCP tool `domains_getDomainListV1` (no arguments).

- If `NEW_DOMAIN` is a **subdomain of a zone you already own** (e.g. `mbbssarl.ch`): confirm that parent zone shows `"status": "active"`. ✅ proceed.
- If `NEW_DOMAIN` is a **brand-new registrable domain** (the free domain): confirm an entry whose `domain` equals it with `"status": "active"`. If instead you still see `{"id":29045619,"domain":null,"status":"pending_setup",...}` and no matching active entry: **STOP.** Finalize it in hPanel (Domains → complete the free domain setup), wait until `active`, then restart this task.

- [ ] **Step 3: Confirm the DNS zone is manageable at Hostinger**

Use the Hostinger MCP tool `DNS_getDNSRecordsV1` with `{"domain": "<the registrable apex, e.g. mbbssarl.ch>"}`.

Expected (to proceed): a JSON array of existing records is returned (proves Hostinger hosts the zone). For `mbbssarl.ch` this already returns records including the existing `horos` A record → `76.13.55.44`. If it errors "domain not found"/"not managed": the zone is NOT at Hostinger — do Task 1's DNS step at the real DNS provider instead.

- [ ] **Step 4: Record the starting state of the live stack (so you can prove the change later)**

```bash
ssh root@76.13.55.44 "cd /docker/horos && grep -nE 'HOROS_DOMAIN|Host\\(|horosviewer|certresolver' docker-compose.yml; echo '--- running ---'; docker compose ps"
```

Expected: prints the current `Host(\`horos.mbbssarl.ch\`)`rule (router`horosviewer`) and shows `app`, `db`, `minio` `Up`/healthy. Note the exact line(s) containing `horos.mbbssarl.ch`— Task 3 replaces that literal. If SSH prompts for a password, your key isn't loaded; fix SSH access first (the key is authorized for`root@76.13.55.44`).

---

## Task 1: Create the DNS A record for the new domain

**Files:** Hostinger DNS zone for the new domain (no repo files).

- [ ] **Step 1: Verify the name does NOT already resolve (baseline)**

```bash
dig +short A "$NEW_DOMAIN" @1.1.1.1
```

Expected: empty output (the new name has no A record yet). If it already prints `76.13.55.44`, the record exists — skip to Step 3 to verify.

- [ ] **Step 2: Create the A record → VPS, TTL 300 (mirrors the existing `horos.mbbssarl.ch` record)**

Use the Hostinger MCP tool `DNS_updateDNSRecordsV1`. For a **subdomain** of `mbbssarl.ch`, set `"name"` to the label only (e.g. `"viewer"`):

```json
{
  "domain": "mbbssarl.ch",
  "overwrite": false,
  "zone": [
    {
      "name": "viewer",
      "type": "A",
      "ttl": 300,
      "records": [{ "content": "76.13.55.44" }]
    }
  ]
}
```

For an **apex** deployment of a standalone domain, use `"domain": "<apex>"` and `"name": "@"`.

Alternative (no MCP): hPanel → Domains → DNS / Nameservers → add record: Type `A`, Name `<label>` (or `@`), Points to `76.13.55.44`, TTL `300`.

Expected: the tool/panel returns success (HTTP 200 / "DNS records updated").

- [ ] **Step 3: Verify the new name resolves to the VPS (the "test" for this task)**

```bash
# DNS can take a minute at TTL 300; re-run until it returns the IP.
for i in 1 2 3 4 5 6; do R=$(dig +short A "$NEW_DOMAIN" @1.1.1.1); [ -n "$R" ] && break; sleep 15; done
echo "resolved: $R"
```

Expected: `resolved: 76.13.55.44`. Do not proceed to Task 3 until this prints the VPS IP — ACME HTTP-01 will fail otherwise.

---

## Task 2: Update repo source-of-truth (docs/defaults) to the new domain

Do this while DNS propagates. These are the only **code/repo** edits; they keep the repo honest about the canonical domain. Work on a branch off `self-host` (the deployed branch).

**Files:**

- Modify: `~/Documents/GitHub/horos-viewer/.env.example` (the `HOROS_DOMAIN=` line)
- Modify: `~/Documents/GitHub/horos-viewer/docker-compose.yml` (header comment line referencing the DNS A record domain)
- Modify: `~/Documents/GitHub/horos-viewer/DEPLOY.md` (the example domain on the `DNS A record` bullet)

- [ ] **Step 1: Create a working branch**

```bash
cd ~/Documents/GitHub/horos-viewer
git checkout self-host && git pull --ff-only
git checkout -b chore/new-domain
```

Expected: `Switched to a new branch 'chore/new-domain'`.

- [ ] **Step 2: Point the `.env.example` default at the new domain**

In `~/Documents/GitHub/horos-viewer/.env.example`, replace the line:

```
HOROS_DOMAIN=horos.example.com
```

with (substitute your real domain for `<NEW_DOMAIN>`):

```
HOROS_DOMAIN=<NEW_DOMAIN>
```

- [ ] **Step 3: Update the `docker-compose.yml` header comment**

In `~/Documents/GitHub/horos-viewer/docker-compose.yml`, replace the comment line:

```
# Required: a DNS A record for HOROS_DOMAIN -> 76.13.55.44 (ACME HTTP-01).
```

with:

```
# Required: a DNS A record for HOROS_DOMAIN (e.g. <NEW_DOMAIN>) -> 76.13.55.44 (ACME HTTP-01).
```

- [ ] **Step 4: Update the `DEPLOY.md` example domain**

In `~/Documents/GitHub/horos-viewer/DEPLOY.md`, on the bullet that currently reads:

```
- A **DNS A record** for the chosen domain (e.g. `horos.mbbsarl.ch`) →
```

replace `horos.mbbsarl.ch` with your real domain so it reads (substitute `<NEW_DOMAIN>`):

```
- A **DNS A record** for the chosen domain (e.g. `<NEW_DOMAIN>`) →
```

- [ ] **Step 5: Verify no stale `horos.mbbssarl.ch` / `horos.example.com` remains in deploy docs**

```bash
cd ~/Documents/GitHub/horos-viewer
grep -rnE 'horos\.mbbssarl\.ch|horos\.example\.com|horos\.mbbsarl\.ch' .env.example DEPLOY.md docker-compose.yml
```

Expected: **no output** (all example references now use the new domain). If any line prints, fix it.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/GitHub/horos-viewer
git add .env.example DEPLOY.md docker-compose.yml
git commit -m "chore: point deploy docs/defaults at the dedicated domain"
```

Expected: one commit created on `chore/new-domain`.

---

## Task 3: Repoint the live Traefik rule to the new domain and issue its cert

This edits the **live** stack on the VPS. Volumes (`horos_db-data`, `horos_minio-data`) are untouched, so imported studies and the admin account survive.

**Files:**

- Modify: `/docker/horos/docker-compose.yml` on `root@76.13.55.44` (the `horosviewer` router's `Host(...)` rule).

- [ ] **Step 1: Back up the live compose file**

```bash
ssh root@76.13.55.44 "cd /docker/horos && cp docker-compose.yml docker-compose.yml.bak-newdomain && ls -la docker-compose.yml*"
```

Expected: a `docker-compose.yml.bak-newdomain` now exists next to the original.

- [ ] **Step 2: Replace the old host literal with the new domain in the routing rule**

```bash
ssh root@76.13.55.44 "cd /docker/horos && sed -i 's/horos\\.mbbssarl\\.ch/${NEW_DOMAIN}/g' docker-compose.yml && grep -nE 'Host\\(|HOROS_DOMAIN' docker-compose.yml"
```

Expected: the `traefik.http.routers.horosviewer.rule` line now reads ``Host(`<NEW_DOMAIN>`)`` and any `HOROS_DOMAIN` env line now shows the new domain. **If Task 0 Step 4 showed the rule used `${HOROS_DOMAIN}` from an env value rather than a hardcoded host**, instead update that value: `ssh root@76.13.55.44 "cd /docker/horos && grep -rn HOROS_DOMAIN .env docker-compose.yml"` then `sed -i` the `.env` line `HOROS_DOMAIN=...` to `$NEW_DOMAIN`. Either way, the effective `Host(...)` must resolve to the new domain.

- [ ] **Step 3: Apply — recreate the app container so Traefik re-reads labels and requests the cert**

```bash
ssh root@76.13.55.44 "cd /docker/horos && docker compose up -d && docker compose ps"
```

Expected: `app` recreated and `Up`; `db`/`minio` still `Up`/healthy.

- [ ] **Step 4: Wait for ACME and verify HTTPS on the new domain (the "test")**

```bash
for i in $(seq 1 12); do
  C=$(curl -sk -o /dev/null -w '%{http_code}' "https://$NEW_DOMAIN/login");
  echo "attempt $i: $C"; [ "$C" = "200" ] && break; sleep 10;
done
echo "--- cert issuer ---"
echo | openssl s_client -servername "$NEW_DOMAIN" -connect "$NEW_DOMAIN:443" 2>/dev/null | openssl x509 -noout -issuer -subject
```

Expected: a `200` from `/login`, and the issuer contains `Let's Encrypt` with `subject= ...CN=<NEW_DOMAIN>`. If it stays `000`/`404`/`525`: re-check DNS (Task 1 Step 3), then `ssh root@76.13.55.44 "docker logs traefik-fblq --since 5m 2>&1 | grep -iE 'acme|error|$NEW_DOMAIN'"`.

- [ ] **Step 5: Verify the SPA loads on the new domain (app truly live, not just TLS)**

```bash
curl -sk "https://$NEW_DOMAIN/" -o /dev/null -w 'root: %{http_code}\n'
```

Expected: `root: 200`. The real proof is a successful login in Task 5.

---

## Task 4: 301-redirect the old domain to the new one

Keep `horos.mbbssarl.ch` working but bounce every request to the new canonical domain, so old links and the prior admin bookmark don't break.

**Files:**

- Modify: `/docker/horos/docker-compose.yml` on `root@76.13.55.44` (add a second router + a `redirectregex` middleware to the `app` service labels).

- [ ] **Step 1: Add the redirect router + middleware labels to the `app` service**

Edit `/docker/horos/docker-compose.yml` on the VPS and add these lines to the **`app` service's `labels:` list** (alongside the existing `horosviewer` labels). Note: `$$` escapes Compose interpolation so Traefik receives a literal `$`.

```yaml
- "traefik.http.routers.horos-oldredirect.rule=Host(`horos.mbbssarl.ch`)"
- "traefik.http.routers.horos-oldredirect.entrypoints=websecure"
- "traefik.http.routers.horos-oldredirect.tls.certresolver=letsencrypt"
- "traefik.http.routers.horos-oldredirect.service=horosviewer"
- "traefik.http.routers.horos-oldredirect.middlewares=horos-to-new"
- "traefik.http.middlewares.horos-to-new.redirectregex.regex=^https://horos.mbbssarl.ch/(.*)"
- "traefik.http.middlewares.horos-to-new.redirectregex.replacement=https://NEW_DOMAIN_HERE/$${1}"
- "traefik.http.middlewares.horos-to-new.redirectregex.permanent=true"
```

Substitute the literal new domain into the `replacement` line:

```bash
ssh root@76.13.55.44 "cd /docker/horos && sed -i 's#NEW_DOMAIN_HERE#${NEW_DOMAIN}#g' docker-compose.yml && grep -n 'horos-to-new\\|horos-oldredirect' docker-compose.yml"
```

Expected: the grep shows all 7 redirect labels, with `replacement=https://<NEW_DOMAIN>/$${1}`.

- [ ] **Step 2: Apply**

```bash
ssh root@76.13.55.44 "cd /docker/horos && docker compose up -d && docker compose ps"
```

Expected: `app` recreated, still `Up`.

- [ ] **Step 3: Verify the old domain 301s to the new one (the "test")**

```bash
curl -skI "https://horos.mbbssarl.ch/viewer/1" | grep -iE '^HTTP|^location'
```

Expected:

```
HTTP/2 301
location: https://<NEW_DOMAIN>/viewer/1
```

If you get `200` instead of `301`, the old `horosviewer` router still matches `horos.mbbssarl.ch` — confirm Task 3 Step 2 actually changed that rule to the new domain.

---

## Task 5: End-to-end smoke test on the new domain + update memory

**Files:** none in repo; updates project memory.

- [ ] **Step 1: Log in on the new domain (proves cookies/auth work cross-domain)**

In a browser, open `https://<NEW_DOMAIN>/login` and sign in with the existing admin (`mbbssarl1201@gmail.com`). Expected: login succeeds and the study list loads. (Confirms the domain-agnostic session cookie from `server/_core/cookies.ts` works on the new host.)

- [ ] **Step 2: Confirm the imported study + viewer still work (data survived)**

Open the previously imported study (`https://<NEW_DOMAIN>/viewer/1`). Expected: the CT image renders; Length/ROI tools and Export/Capture work (volumes preserved, so the 297-instance study is intact).

- [ ] **Step 3: Confirm the old bookmark redirects in a real browser**

Open `https://horos.mbbssarl.ch/`. Expected: lands on `https://<NEW_DOMAIN>/` (301 followed automatically).

- [ ] **Step 4: Push the repo branch and open a PR into `self-host`**

```bash
cd ~/Documents/GitHub/horos-viewer
git push -u origin chore/new-domain
gh pr create --base self-host --head chore/new-domain \
  --title "chore: migrate Horos to its dedicated domain" \
  --body "Repoints deploy docs/defaults from horos.mbbssarl.ch to the dedicated domain. Live DNS/Traefik/cert/redirect applied on the VPS per docs/superpowers/plans/2026-06-05-horos-new-domain-migration.md."
```

Expected: PR URL printed.

- [ ] **Step 5: Update project memory to reflect the new canonical domain**

Edit `/Users/mbbssarl/.claude/projects/-Users-mbbssarl/memory/horos-viewer-security-hardening.md`: change live URL references from `horos.mbbssarl.ch` to the new domain, add a note "`horos.mbbssarl.ch` now 301 → `<NEW_DOMAIN>`", and update the `MEMORY.md` index line for Horos to the new domain. Expected: memory names the new domain as canonical.

---

## Self-Review

**1. Spec coverage** (the four things requested):

- _DNS + Traefik + TLS_ → Task 1 (A record), Task 3 (Traefik rule + ACME cert). ✅
- _Reconfigure the app_ → Verified a no-op for app code (cookies domain-agnostic, no CORS allowlist); the real "reconfig" is the Traefik `Host(...)` rule + repo defaults → Task 2 & Task 3. ✅
- _Redeploy_ → Task 3 Step 3 (`docker compose up -d`, volumes preserved). ✅
- _Old domain_ → Task 4 (301 redirect), verified Task 5 Step 3. ✅

**2. Placeholder scan:** The only intentional substitution token is `NEW_DOMAIN` / `<NEW_DOMAIN>` / `NEW_DOMAIN_HERE`, defined once in Task 0 Step 1 and substituted by explicit `sed` or noted inline — not a vague "TBD". Every command and label is concrete. ✅

**3. Type/identifier consistency:** Router `horosviewer` (existing) and `horos-oldredirect` (new) are distinct; middleware `horos-to-new` is referenced by the same name in its definition and the router's `middlewares=` label; `NEW_DOMAIN`/`OLD_DOMAIN`/`VPS_IP` shell vars are used consistently; the redirect router reuses `service=horosviewer`. ✅

**Known gap deferred by design:** Does not touch SMTP `SMTP_FROM` (`noreply@mbbssarl.ch` stays valid) or the cosmetic `{{project_title}}` title artifact — both out of scope for a domain migration.
