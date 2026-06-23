export function kpiNeedsImprovement(k: {
  value: number;
  target: number;
  goal: "max" | "min";
}): boolean {
  return k.goal === "max" ? k.value < k.target : k.value > k.target;
}

/** Texte de suggestion par défaut selon l'agent/KPI (déterministe, sans LLM). */
export function defaultSuggestion(agentKey: string, kpiKey: string): string {
  if (agentKey === "redacteur" && kpiKey === "acceptanceRate")
    return "Taux d'acceptation bas : revoir le prompt et les fiches RAG des modalités les plus corrigées ; comparer brouillons↔signés récents.";
  if (agentKey === "copilote" && kpiKey === "avgLatencyMs")
    return "Latence élevée : garder le modèle chaud (keep_alive -1), réduire le contexte injecté, envisager un modèle local plus rapide.";
  return `KPI ${kpiKey} de l'agent ${agentKey} sous l'objectif : analyser les activités récentes et ajuster la configuration.`;
}

/** Calcule et persiste les suggestions ouvertes pour un agent. Renvoie le nb créé. */
export async function computeSuggestions(agentKey: string): Promise<number> {
  const { computeAgentKpis } = await import("./metrics");
  const { getDb } = await import("../db");
  const { agentSuggestions } = await import("../../drizzle/schema");
  const { and, eq } = await import("drizzle-orm");
  const kpis = await computeAgentKpis(agentKey);
  const db = await getDb();
  if (!db) return 0;
  let created = 0;
  for (const k of kpis) {
    if (!kpiNeedsImprovement(k)) continue;
    const existing = await db
      .select()
      .from(agentSuggestions)
      .where(
        and(
          eq(agentSuggestions.agentKey, agentKey),
          eq(agentSuggestions.kpiKey, k.key),
          eq(agentSuggestions.status, "open")
        )
      )
      .limit(1);
    if (existing[0]) continue;
    await db.insert(agentSuggestions).values({
      agentKey,
      kpiKey: k.key,
      gap: Math.round(
        k.goal === "max" ? k.target - k.value : k.value - k.target
      ),
      suggestion: defaultSuggestion(agentKey, k.key),
      status: "open",
    });
    created++;
  }
  return created;
}
