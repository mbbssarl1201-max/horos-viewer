# Partage interne d'étude — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Remplacer le stub « Cloud Sharing » par un partage d'étude INTERNE et nLPD-safe : transmettre une étude à un confrère MediView (notification + note), réutilisant l'infra `notifications`.

**Architecture:** enum `shared_study` (migration 0009) ; helper `listClinicalUsers` + `createNotification` étendu ; module pur `studyShare.buildShareNotification` ; procédures `users.listClinical` + `studies.share` (medicalProcedure) ; `ShareStudyDialog` client + câblage du stub + notif cliquable.

**Tech Stack:** tRPC v11, drizzle MySQL, React 19, Vitest.

**Branche :** `feat/study-share-internal` (déjà créée depuis `self-host`).

---

### Task 1 : module pur `studyShare.ts`

**Files:** Create `server/studyShare.ts` ; Test `server/studyShare.test.ts`

- [ ] **Step 1 : test (échec)**

```typescript
// server/studyShare.test.ts
import { describe, it, expect } from "vitest";
import { buildShareNotification } from "./studyShare";

describe("buildShareNotification", () => {
  it("titre avec le nom de l'expéditeur", () => {
    const r = buildShareNotification("Dr Martin", "À relire SVP");
    expect(r.title).toContain("Dr Martin");
    expect(r.message).toBe("À relire SVP");
  });
  it("nom vide → « un confrère »", () => {
    expect(buildShareNotification("", undefined).title.toLowerCase()).toContain(
      "confrère"
    );
  });
  it("note absente → message vide", () => {
    expect(buildShareNotification("X").message).toBe("");
  });
  it("note tronquée à 1000 caractères", () => {
    expect(buildShareNotification("X", "y".repeat(2000)).message.length).toBe(
      1000
    );
  });
});
```

- [ ] **Step 2 : lancer (échec)** — `pnpm exec vitest run server/studyShare.test.ts`

- [ ] **Step 3 : implémenter**

```typescript
// server/studyShare.ts
/** Construit le titre/message d'une notification de partage d'étude. PUR. */
export function buildShareNotification(
  senderName: string,
  note?: string
): { title: string; message: string } {
  const who = senderName.trim() || "un confrère";
  return {
    title: `Étude transmise par ${who}`,
    message: (note ?? "").slice(0, 1000),
  };
}
```

- [ ] **Step 4 : lancer (succès)** — `pnpm exec vitest run server/studyShare.test.ts`
- [ ] **Step 5 : commit** — `git add server/studyShare.* && git commit -m "feat(share): buildShareNotification (pur)"`

---

### Task 2 : enum `shared_study` + migration 0009

**Files:** Modify `drizzle/schema.ts` ; Generate `drizzle/0009_*.sql`

- [ ] **Step 1 : étendre l'enum**

Dans `drizzle/schema.ts`, table `notifications`, remplacer :

```typescript
    type: mysqlEnum("type", [
      "new_study",
      "stat_urgent",
      "report_finalized",
    ]).notNull(),
```

par :

```typescript
    type: mysqlEnum("type", [
      "new_study",
      "stat_urgent",
      "report_finalized",
      "shared_study",
    ]).notNull(),
```

- [ ] **Step 2 : générer la migration**

Run: `pnpm exec drizzle-kit generate`
Expected: crée `drizzle/0009_*.sql` contenant un `ALTER TABLE ... MODIFY ... ENUM(...,'shared_study')`.
Vérifier le contenu du fichier généré (1 ALTER sur `notifications.type`).

- [ ] **Step 3 : commit** — `git add drizzle/schema.ts drizzle/0009_*.sql && git commit -m "feat(share): enum notifications shared_study (migration 0009)"`

---

### Task 3 : helpers `db.ts` (createNotification + listClinicalUsers)

**Files:** Modify `server/db.ts`

- [ ] **Step 1 : étendre `createNotification`**

Remplacer le type de `type` :

```typescript
type: "new_study" | "stat_urgent" | "report_finalized";
```

par :

```typescript
type: "new_study" | "stat_urgent" | "report_finalized" | "shared_study";
```

- [ ] **Step 2 : ajouter `listClinicalUsers`**

Après `getUserNotifications`, ajouter (importer `users`, `and`, `ne`, `inArray` si besoin depuis drizzle/le schema) :

```typescript
export async function listClinicalUsers(excludeUserId: number) {
  const db = await getDb();
  if (!db) return [];
  const { users } = await import("../drizzle/schema");
  const { and, ne, inArray } = await import("drizzle-orm");
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    })
    .from(users)
    .where(
      and(
        inArray(users.role, ["admin", "radiologist", "technician"]),
        ne(users.id, excludeUserId)
      )
    );
}
```

> Adapter le style d'import drizzle à celui déjà utilisé dans `db.ts` (imports en tête vs dynamiques).

- [ ] **Step 3 : compilation** — `pnpm check` (PASS).
- [ ] **Step 4 : commit** — `git add server/db.ts && git commit -m "feat(share): createNotification shared_study + listClinicalUsers"`

---

### Task 4 : procédures `users.listClinical` + `studies.share`

**Files:** Modify `server/routers.ts`

- [ ] **Step 1 : imports** — s'assurer que `listClinicalUsers` et `getStudyById`, `createNotification`, `countRecentAccess`, `recordAccess` sont importés depuis `./db`, et `buildShareNotification` depuis `./studyShare`.

- [ ] **Step 2 : `users.listClinical`** — ajouter (nouveau routeur `users` ou dans un existant) :

```typescript
  users: router({
    listClinical: medicalProcedure.query(async ({ ctx }) => {
      return listClinicalUsers(ctx.user.id);
    }),
  }),
```

> Si un routeur `users` existe déjà, y ajouter `listClinical` au lieu d'en créer un second.

- [ ] **Step 3 : `studies.share`** — dans le routeur `studies`, ajouter :

```typescript
    share: medicalProcedure
      .input(
        z.object({
          studyId: z.number().int(),
          recipientUserId: z.number().int(),
          note: z.string().max(1000).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const recent = await countRecentAccess(ctx.user.id, "study.share", 60);
        if (recent >= 60)
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Limite atteinte." });
        if (input.recipientUserId === ctx.user.id)
          throw new TRPCError({ code: "BAD_REQUEST", message: "Destinataire invalide." });
        const study = await getStudyById(input.studyId);
        if (!study) throw new TRPCError({ code: "NOT_FOUND", message: "Étude introuvable" });
        const clinical = await listClinicalUsers(ctx.user.id);
        if (!clinical.some(u => u.id === input.recipientUserId))
          throw new TRPCError({ code: "BAD_REQUEST", message: "Destinataire non clinique." });
        const { title, message } = buildShareNotification(
          (ctx.user as any).name ?? "",
          input.note
        );
        await createNotification({
          userId: input.recipientUserId,
          type: "shared_study",
          title,
          message,
          studyId: input.studyId,
        });
        await recordAccess({
          userId: ctx.user.id,
          action: "study.share",
          studyId: input.studyId,
          detail: `to=${input.recipientUserId}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { ok: true };
      }),
```

- [ ] **Step 4 : compilation + tests** — `pnpm check && pnpm exec vitest run server/routers.test.ts` (PASS).
- [ ] **Step 5 : commit** — `git add server/routers.ts && git commit -m "feat(share): users.listClinical + studies.share (medicalProcedure)"`

---

### Task 5 : `ShareStudyDialog` + câblage Home + notif cliquable

**Files:** Create `client/src/components/ShareStudyDialog.tsx` ; Modify `client/src/pages/Home.tsx`, `client/src/components/NotificationsPanel.tsx`

- [ ] **Step 1 : composant**

```tsx
// client/src/components/ShareStudyDialog.tsx
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface Props {
  studyId: number | null;
  open: boolean;
  onClose: () => void;
}

/** Partage INTERNE d'une étude : transmet à un confrère MediView (notification). */
export default function ShareStudyDialog({ studyId, open, onClose }: Props) {
  const users = trpc.users.listClinical.useQuery(undefined, { enabled: open });
  const share = trpc.studies.share.useMutation();
  const [recipient, setRecipient] = useState<number | "">("");
  const [note, setNote] = useState("");
  if (!open || studyId == null) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-lg p-4 w-[360px] space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-bold text-sm">Partager l'étude</h3>
        <p className="text-[11px] text-muted-foreground">
          Transmettre à un confrère MediView (interne, audité).
        </p>
        <select
          className="w-full bg-muted/40 border border-border rounded text-sm px-2 py-1"
          value={recipient}
          onChange={e =>
            setRecipient(e.target.value ? Number(e.target.value) : "")
          }
        >
          <option value="">Choisir un destinataire…</option>
          {(users.data ?? []).map(u => (
            <option key={u.id} value={u.id}>
              {u.name || u.email || `#${u.id}`} ({u.role})
            </option>
          ))}
        </select>
        <textarea
          className="w-full bg-muted/40 border border-border rounded text-sm px-2 py-1"
          rows={3}
          placeholder="Note (facultative)…"
          value={note}
          onChange={e => setNote(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            size="sm"
            disabled={recipient === "" || share.isPending}
            onClick={async () => {
              try {
                await share.mutateAsync({
                  studyId,
                  recipientUserId: Number(recipient),
                  note: note || undefined,
                });
                toast.success("Étude transmise.");
                setNote("");
                setRecipient("");
                onClose();
              } catch {
                toast.error("Échec du partage.");
              }
            }}
          >
            {share.isPending ? "Envoi…" : "Partager"}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2 : Home.tsx — état + dialog + câblage du stub**

Ajouter `const [shareOpen, setShareOpen] = useState(false);` ; importer `ShareStudyDialog`. Le bouton
« Cloud Sharing » (toast « coming soon », l. ~496) : remplacer `onClick` par
`() => { if (selectedStudyId) setShareOpen(true); else toast("Sélectionnez une étude"); }`. Ajouter aussi
une entrée « Partager… » dans le menu d'actions de l'étude sélectionnée. Monter en bas du composant :
`<ShareStudyDialog studyId={selectedStudyId} open={shareOpen} onClose={() => setShareOpen(false)} />`.

- [ ] **Step 3 : NotificationsPanel — notif cliquable**

Si une notif a `studyId`, la rendre cliquable : au clic, `markRead(notif.id)` puis
`navigate("/viewer/" + notif.studyId)` (importer `useLocation` de wouter si absent). Conserver le
comportement existant pour les notifs sans `studyId`.

- [ ] **Step 4 : compilation** — `pnpm check` (PASS).
- [ ] **Step 5 : commit** — `git add client/src/components/ShareStudyDialog.tsx client/src/pages/Home.tsx client/src/components/NotificationsPanel.tsx && git commit -m "feat(share): shareStudyDialog + câblage cloud sharing + notif cliquable"`

---

### Task 6 : vérification + déploiement

- [ ] **Step 1** — `pnpm check && pnpm exec vitest run` → tout vert.
- [ ] **Step 2** — `git push -u origin feat/study-share-internal` ; puis (séparé) `gh pr create --base self-host ...`.
- [ ] **Step 3** — `gh run watch <id> --exit-status` (gate verify+build) ; `gh pr merge <num> --merge --delete-branch`.
- [ ] **Step 4** — déployer sur `root@76.13.55.44` (`/docker/horos`) : sed image → `docker compose pull migrate app` → `docker compose up -d migrate` (**exit 0 — applique la migration 0009 `shared_study`**) → `up -d app`.
- [ ] **Step 5** — ping : `healthz` 200, garde `/api/audit/export.csv` 401, `study.share` non-auth → 401 (POST /api/trpc) ; bonne image.
- [ ] **Step 6** — mémoire : `mediview-horos-parity.md` (Cloud Sharing → partage interne déployé ; reste lien externe OTP) + index `MEMORY.md`.

---

## Notes

- Migration 0009 = 1 enum value (`ALTER`). PHI-safe, interne, audité. Lien externe/OTP hors scope.
- Mono-tenant : le partage ne crée pas d'accès (déjà global) — c'est une transmission/notification.
