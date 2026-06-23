import { useState } from "react";
import { trpc } from "@/lib/trpc";

export function ReferentDirectory() {
  const list = trpc.referringContacts.list.useQuery();
  const upsert = trpc.referringContacts.upsert.useMutation({
    onSuccess: () => list.refetch(),
  });
  const del = trpc.referringContacts.delete.useMutation({
    onSuccess: () => list.refetch(),
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const items = list.data?.items ?? [];
  return (
    <div className="space-y-2">
      <h3 className="font-bold text-sm">Carnet des référents</h3>
      <div className="flex gap-1">
        <input
          className="flex-1 rounded bg-muted/40 border border-border px-2 py-1 text-[11px]"
          placeholder="Nom du médecin"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <input
          className="flex-1 rounded bg-muted/40 border border-border px-2 py-1 text-[11px]"
          placeholder="email@..."
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
        <button
          className="text-[11px] rounded bg-primary/15 text-primary px-2 py-1 disabled:opacity-50"
          disabled={!name.trim() || !email.trim() || upsert.isPending}
          onClick={() => {
            upsert.mutate({ name, email });
            setName("");
            setEmail("");
          }}
        >
          Ajouter
        </button>
      </div>
      <ul className="divide-y divide-border">
        {items.length === 0 && (
          <li className="py-2 text-[11px] text-muted-foreground">
            Aucun référent enregistré.
          </li>
        )}
        {items.map(c => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-2 py-1.5 text-[11px]"
          >
            <div>
              <span className="font-medium">{c.name}</span>{" "}
              <span className="text-muted-foreground">{c.email}</span>
            </div>
            <button
              className="rounded bg-destructive/15 text-destructive px-2 py-0.5"
              onClick={() => del.mutate({ id: c.id })}
            >
              Suppr.
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
