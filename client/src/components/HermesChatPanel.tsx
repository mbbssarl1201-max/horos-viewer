import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  studyId: number;
  onClose: () => void;
}

/**
 * Chat « Hermès radiologue » : assistant conversationnel (persona expert) sur
 * l'étude courante. Conversation ÉPHÉMÈRE (état local). Aide non-diagnostique.
 */
export default function HermesChatPanel({ studyId, onClose }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const ask = trpc.ai.askHermes.useMutation();

  const send = async () => {
    const content = input.trim();
    if (!content || ask.isPending) return;
    const next: Msg[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    try {
      const r = await ask.mutateAsync({ studyId, messages: next });
      setMessages([...next, { role: "assistant", content: r.reply }]);
    } catch {
      setMessages([
        ...next,
        { role: "assistant", content: "⚠️ Erreur : réponse indisponible." },
      ]);
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
            <div>{m.content}</div>
          </div>
        ))}
        {ask.isPending && (
          <div className="text-cyan-300 text-xs">Hermès réfléchit…</div>
        )}
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
          disabled={ask.isPending || !input.trim()}
          onClick={() => void send()}
        >
          Envoyer
        </Button>
      </div>
    </div>
  );
}
