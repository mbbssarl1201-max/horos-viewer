import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

interface Source {
  source: string;
  heading: string | null;
  score: number;
}
interface Msg {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

interface Props {
  studyId: number;
  onClose: () => void;
}

/**
 * Chat « Hermès radiologue » : réponses en STREAMING (tokens token-par-token,
 * modèle local) ancrées dans la base de connaissances (RAG). Conversation
 * ÉPHÉMÈRE. Aide non-diagnostique. Repli non-streaming via tRPC si le flux échoue.
 */
export default function HermesChatPanel({ studyId, onClose }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = trpc.ai.askHermes.useMutation();

  const send = async () => {
    const content = input.trim();
    if (!content || busy) return;
    const history: Msg[] = [...messages, { role: "user", content }];
    setMessages(history);
    setInput("");
    setBusy(true);
    // Place un message assistant vide qu'on remplit au fil du flux.
    setMessages([...history, { role: "assistant", content: "" }]);
    const payload = {
      studyId,
      messages: history.map(m => ({ role: m.role, content: m.content })),
    };

    const appendToLast = (delta: string) =>
      setMessages(cur => {
        const copy = cur.slice();
        const last = copy[copy.length - 1];
        if (last?.role === "assistant")
          copy[copy.length - 1] = { ...last, content: last.content + delta };
        return copy;
      });
    const setLastSources = (sources: Source[]) =>
      setMessages(cur => {
        const copy = cur.slice();
        const last = copy[copy.length - 1];
        if (last?.role === "assistant")
          copy[copy.length - 1] = { ...last, sources };
        return copy;
      });

    try {
      const resp = await fetch("/api/hermes/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!resp.ok || !resp.body) throw new Error("no-stream");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          try {
            const evt = JSON.parse(json);
            if (typeof evt.t === "string") appendToLast(evt.t);
            else if (evt.done) setLastSources(evt.sources ?? []);
            else if (evt.error) appendToLast(`\n⚠️ ${evt.error}`);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      // Repli : mutation tRPC non-streaming.
      try {
        const r = await ask.mutateAsync(payload);
        setMessages(cur => {
          const copy = cur.slice();
          copy[copy.length - 1] = {
            role: "assistant",
            content: r.reply,
            sources: r.sources,
          };
          return copy;
        });
      } catch {
        appendToLast("⚠️ Erreur : réponse indisponible.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute right-0 top-0 z-30 h-full w-[360px] bg-background border-l border-border p-3 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold text-sm">Hermès radiologue</h3>
        <button onClick={onClose} className="text-xs text-muted-foreground">
          Fermer
        </button>
      </div>
      <div className="text-[10px] text-amber-500 mb-2">
        Aide non-diagnostique — à valider par le médecin.
      </div>
      <div className="flex-1 overflow-y-auto space-y-2 text-sm">
        {messages.length === 0 && (
          <p className="text-muted-foreground text-xs">
            Posez une question sur l'examen courant (différentiel, signe,
            protocole, reformulation…).
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === "user"
                ? "text-foreground"
                : "text-cyan-300 whitespace-pre-wrap"
            }
          >
            <span className="text-[10px] uppercase opacity-60">
              {m.role === "user" ? "Vous" : "Hermès"}
            </span>
            <div>
              {m.content || (busy && i === messages.length - 1 ? "▍" : "")}
            </div>
            {m.sources && m.sources.length > 0 && (
              <div className="mt-1 text-[10px] text-muted-foreground border-t border-border pt-1">
                <div className="opacity-70">📚 Sources consultées</div>
                {m.sources.map((s, j) => (
                  <div key={j}>
                    • {s.source}
                    {s.heading ? ` › ${s.heading}` : ""} ({s.score.toFixed(2)})
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1">
        <textarea
          className="flex-1 rounded bg-muted/40 border border-border px-2 py-1 text-sm"
          rows={2}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Votre question…"
        />
        <Button
          size="sm"
          disabled={busy || !input.trim()}
          onClick={() => void send()}
        >
          Envoyer
        </Button>
      </div>
    </div>
  );
}
