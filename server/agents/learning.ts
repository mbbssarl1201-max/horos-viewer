export interface Correction {
  modality: string;
  draft: string;
  signed: string;
}

/** Regroupe par modalité, ne garde que celles atteignant le seuil. */
export function groupByModality(
  items: Correction[],
  minSamples: number
): Map<string, Correction[]> {
  const map = new Map<string, Correction[]>();
  for (const it of items) {
    const k = (it.modality || "?").toUpperCase();
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }
  Array.from(map.keys()).forEach(k => {
    if (map.get(k)!.length < minSamples) map.delete(k);
  });
  return map;
}

/** Filet anti-PHI : retire noms en MAJUSCULES, dates, identifiants numériques longs. */
export function stripPhiLike(text: string): string {
  return (text ?? "")
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, "[date]")
    .replace(/\b\d{6,}\b/g, "[id]")
    .replace(/\b[A-ZÀ-Þ]{2,}(?:\s+[A-ZÀ-Þ]{2,}){1,5}\b/g, "[nom]")
    .trim();
}

import { ENV } from "../_core/env";

const MIN_SAMPLES = Number(process.env.LEARNING_MIN_SAMPLES ?? "3");

/** Reports signés avec snapshot + correction majeure → couples anonymisés par modalité. */
export async function collectCorrections(): Promise<Correction[]> {
  const { getDb, getStudyById } = await import("../db");
  const { reports, reportAiSnapshots } = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const { sectionsChangedSignificantly } = await import("./metrics");
  const db = await getDb();
  if (!db) return [];
  const signed = await db
    .select()
    .from(reports)
    .where(eq(reports.status, "signed"));
  const out: Correction[] = [];
  for (const r of signed) {
    const snap = await db
      .select()
      .from(reportAiSnapshots)
      .where(eq(reportAiSnapshots.studyId, r.studyId))
      .limit(1);
    if (!snap[0]) continue;
    const draft = JSON.parse(snap[0].sectionsJson);
    if (!sectionsChangedSignificantly(draft, r as any)) continue;
    const study = (await getStudyById(r.studyId)) as any;
    out.push({
      modality: study?.modality ?? "?",
      draft: stripPhiLike(
        `${draft.resultats ?? ""}\n${draft.conclusion ?? ""}`
      ),
      signed: stripPhiLike(`${r.resultats ?? ""}\n${r.conclusion ?? ""}`),
    });
  }
  return out;
}

/** Abstraction LOCALE (Ollama, PHI-safe) → règle générale anonyme. */
export async function abstractRule(
  modality: string,
  samples: Correction[]
): Promise<{ heading: string; content: string } | null> {
  const examples = samples
    .slice(0, 5)
    .map(
      (s, i) =>
        `Exemple ${i + 1}\n- Brouillon IA : ${s.draft}\n- Corrigé par le médecin : ${s.signed}`
    )
    .join("\n\n");
  const sys =
    'Tu es un radiologue senior. À partir de corrections FRÉQUENTES apportées par un médecin à des brouillons d\'IA, formule UNE règle radiologique GÉNÉRALE et ANONYME que l\'IA devrait suivre la prochaine fois. INTERDIT : tout nom, date, identifiant ou détail propre à un patient. Réponds STRICTEMENT en JSON {"heading":"...","content":"2 à 4 phrases"}.';
  const user = `Modalité : ${modality}.\n${examples}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 120_000);
  try {
    const resp = await fetch(`${ENV.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: ENV.ollamaTextModel,
        stream: false,
        keep_alive: -1,
        format: "json",
        options: { num_thread: 4, temperature: 0.2 },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const parsed = JSON.parse(data?.message?.content ?? "{}");
    const heading = stripPhiLike(String(parsed.heading ?? "")).slice(0, 500);
    const content = stripPhiLike(String(parsed.content ?? "")).slice(0, 4000);
    if (!heading || !content) return null;
    return { heading: `${heading} (appris — ${modality})`, content };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Batch : collecte → groupe(seuil) → abstrait → propose (agent_suggestions, open). */
export async function runLearningAgent(): Promise<{ proposed: number }> {
  const { getDb } = await import("../db");
  const { agentSuggestions } = await import("../../drizzle/schema");
  const { and, eq } = await import("drizzle-orm");
  const { logAgentActivity } = await import("./state");
  const { runAgentTool } = await import("./tools");
  const db = await getDb();
  if (!db) return { proposed: 0 };
  const corrections = await collectCorrections();
  const groups = groupByModality(corrections, MIN_SAMPLES);
  let proposed = 0;
  for (const [modality, samples] of Array.from(groups)) {
    const existing = await db
      .select()
      .from(agentSuggestions)
      .where(
        and(
          eq(agentSuggestions.agentKey, "apprentissage"),
          eq(agentSuggestions.kind, "rag_fiche"),
          eq(agentSuggestions.modality, modality),
          eq(agentSuggestions.status, "open")
        )
      )
      .limit(1);
    if (existing[0]) continue;
    const rule = await runAgentTool(
      "apprentissage",
      "proposeRagFiche",
      () => abstractRule(modality, samples),
      null
    );
    if (!rule) continue;
    await db.insert(agentSuggestions).values({
      agentKey: "apprentissage",
      kpiKey: "fichesProposed",
      kind: "rag_fiche",
      modality,
      proposedHeading: rule.heading,
      proposedContent: rule.content,
      sampleCount: samples.length,
      suggestion: `Fiche apprise (${modality}, vue ${samples.length}×) : ${rule.heading}`,
      status: "open",
    });
    proposed++;
    await logAgentActivity("apprentissage", "proposeRagFiche", "ok", {
      detail: `${modality} x${samples.length}`,
    });
  }
  return { proposed };
}

/** À l'approbation : insère la fiche en base RAG (source radio-ref-appris). Idempotent. */
export async function applyRagFiche(suggestionId: number): Promise<boolean> {
  const { getDb } = await import("../db");
  const { agentSuggestions, knowledgeChunks } = await import(
    "../../drizzle/schema"
  );
  const { eq, and } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .select()
    .from(agentSuggestions)
    .where(eq(agentSuggestions.id, suggestionId))
    .limit(1);
  const s = rows[0];
  if (!s || s.kind !== "rag_fiche" || s.status !== "approved") return false;
  if (!s.proposedHeading || !s.proposedContent) return false;
  const dup = await db
    .select()
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.source, "radio-ref-appris"),
        eq(knowledgeChunks.heading, s.proposedHeading)
      )
    )
    .limit(1);
  if (dup[0]) return true;
  const { embedText } = await import("../knowledge/embeddings");
  const { insertChunks } = await import("../knowledge/store");
  const embedding = await embedText(
    `${s.proposedHeading}\n${s.proposedContent}`
  );
  await insertChunks([
    {
      source: "radio-ref-appris",
      heading: s.proposedHeading,
      content: s.proposedContent,
      embedding,
    },
  ]);
  return true;
}
