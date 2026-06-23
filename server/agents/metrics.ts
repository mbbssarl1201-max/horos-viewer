type Sections = {
  indication: string;
  technique: string;
  resultats: string;
  conclusion: string;
};

function changeRatio(a: string, b: string): number {
  const x = (a ?? "").trim();
  const y = (b ?? "").trim();
  if (!x && !y) return 0;
  if (!x || !y) return 1;
  const max = Math.max(x.length, y.length);
  let same = 0;
  const min = Math.min(x.length, y.length);
  for (let i = 0; i < min; i++) if (x[i] === y[i]) same++;
  return 1 - same / max;
}

/** Correction MAJEURE si résultats OU conclusion ont changé de plus de 30 %. */
export function sectionsChangedSignificantly(
  draft: Sections,
  signed: Sections
): boolean {
  return (
    changeRatio(draft.resultats, signed.resultats) > 0.3 ||
    changeRatio(draft.conclusion, signed.conclusion) > 0.3
  );
}

export function acceptanceRate(input: {
  signed: number;
  changedMajor: number;
}): number {
  if (input.signed <= 0) return 0;
  return Math.round(((input.signed - input.changedMajor) / input.signed) * 100);
}

export interface AgentKpiValue {
  key: string;
  label: string;
  value: number;
  target: number;
  unit: string;
  goal: "max" | "min";
  onTarget: boolean;
}

export async function computeAgentKpis(
  agentKey: string
): Promise<AgentKpiValue[]> {
  const { getAgentSpec } = await import("./registry");
  const spec = getAgentSpec(agentKey);
  if (!spec) return [];
  const { getDb } = await import("../db");
  const db = await getDb();
  const out: AgentKpiValue[] = [];
  for (const k of spec.kpis) {
    let value = 0;
    if (db) {
      try {
        value = await computeOneKpi(db, agentKey, k.key);
      } catch {
        value = 0;
      }
    }
    const onTarget = k.goal === "max" ? value >= k.target : value <= k.target;
    out.push({
      key: k.key,
      label: k.label,
      value,
      target: k.target,
      unit: k.unit,
      goal: k.goal,
      onTarget,
    });
  }
  return out;
}

async function computeOneKpi(
  db: any,
  agentKey: string,
  kpiKey: string
): Promise<number> {
  const { reports, reportAiSnapshots, agentActivity } = await import(
    "../../drizzle/schema"
  );
  const { eq, and, sql } = await import("drizzle-orm");
  if (agentKey === "redacteur" && kpiKey === "acceptanceRate") {
    const signedRows = await db
      .select()
      .from(reports)
      .where(eq(reports.status, "signed"));
    let signed = 0;
    let changedMajor = 0;
    for (const r of signedRows) {
      const snap = await db
        .select()
        .from(reportAiSnapshots)
        .where(eq(reportAiSnapshots.studyId, r.studyId))
        .limit(1);
      if (!snap[0]) continue;
      signed++;
      const draft = JSON.parse(snap[0].sectionsJson);
      if (sectionsChangedSignificantly(draft, r)) changedMajor++;
    }
    return acceptanceRate({ signed, changedMajor });
  }
  if (agentKey === "redacteur" && kpiKey === "draftsPerDay") {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const { gte } = await import("drizzle-orm");
    const rows = await db
      .select({ n: sql`COUNT(*)` })
      .from(agentActivity)
      .where(
        and(
          eq(agentActivity.agentKey, "redacteur"),
          eq(agentActivity.action, "generateDraft"),
          gte(agentActivity.createdAt, since)
        )
      );
    return Number(rows[0]?.n ?? 0);
  }
  if (agentKey === "copilote" && kpiKey === "conversations") {
    return countActivity(db, "copilote", "chat");
  }
  // Compteurs d'activité (journal agent_activity) pour les KPIs « combien de fois ».
  if (agentKey === "apprentissage" && kpiKey === "fichesProposed") {
    return countActivity(db, "apprentissage", "proposeRagFiche");
  }
  if (agentKey === "codage" && kpiKey === "codageRuns") {
    return countActivity(db, "codage", "suggestBillingCodes");
  }
  if (agentKey === "referent" && kpiKey === "envois") {
    return countActivity(db, "referent", "sendReport");
  }
  // Fiches apprises réellement APPROUVÉES par le gérant (depuis agent_suggestions).
  if (agentKey === "apprentissage" && kpiKey === "fichesApproved") {
    const { agentSuggestions } = await import("../../drizzle/schema");
    const rows = await db
      .select({ n: sql`COUNT(*)` })
      .from(agentSuggestions)
      .where(
        and(
          eq(agentSuggestions.agentKey, "apprentissage"),
          eq(agentSuggestions.kind, "rag_fiche"),
          eq(agentSuggestions.status, "approved")
        )
      );
    return Number(rows[0]?.n ?? 0);
  }
  // Latence moyenne des conversations Copilote (durée mesurée à l'exécution).
  if (agentKey === "copilote" && kpiKey === "avgLatencyMs") {
    const rows = await db
      .select({ avg: sql`AVG(${agentActivity.durationMs})` })
      .from(agentActivity)
      .where(
        and(
          eq(agentActivity.agentKey, "copilote"),
          eq(agentActivity.action, "chat")
        )
      );
    return Math.round(Number(rows[0]?.avg ?? 0));
  }
  // Non encore capturé (nécessite le verdict du médecin sur les désaccords) → 0.
  // qualite.disagreementConfirmedRate.
  return 0;
}

/** Compte les entrées du journal d'un agent pour une action donnée. */
async function countActivity(
  db: any,
  agentKey: string,
  action: string
): Promise<number> {
  const { agentActivity } = await import("../../drizzle/schema");
  const { eq, and, sql } = await import("drizzle-orm");
  const rows = await db
    .select({ n: sql`COUNT(*)` })
    .from(agentActivity)
    .where(
      and(
        eq(agentActivity.agentKey, agentKey),
        eq(agentActivity.action, action)
      )
    );
  return Number(rows[0]?.n ?? 0);
}
