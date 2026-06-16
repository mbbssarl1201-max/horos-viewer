// server/report/reportAssist.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAssistMessages,
  REPORT_ASSIST_SYSTEM_PROMPT,
  prepareReportAssist,
} from "./reportAssist";
import * as embeddings from "../knowledge/embeddings";
import * as store from "../knowledge/store";
import * as db from "../db";

describe("buildAssistMessages", () => {
  it("system contient la règle anti-invention", () => {
    expect(REPORT_ASSIST_SYSTEM_PROMPT.toLowerCase()).toContain("aucun");
    const msgs = buildAssistMessages("reformuler", "Texte", "CTX", "");
    expect(msgs[0]).toEqual({
      role: "system",
      content: REPORT_ASSIST_SYSTEM_PROMPT,
    });
  });
  it("inclut le texte courant et l'instruction de l'action", () => {
    const msgs = buildAssistMessages("reformuler", "nodule lsd 8mm", "CTX", "");
    const joined = msgs.map(m => m.content).join("\n");
    expect(joined).toContain("nodule lsd 8mm");
    expect(joined.toLowerCase()).toContain("reformule");
  });
  it("conclure : l'instruction porte sur les résultats → conclusion", () => {
    const msgs = buildAssistMessages("conclure", "Résultats…", "CTX", "");
    expect(
      msgs
        .map(m => m.content)
        .join("\n")
        .toLowerCase()
    ).toContain("conclusion");
  });
  it("sans bloc connaissances → pas de message connaissances", () => {
    const a = buildAssistMessages("reformuler", "T", "CTX", "");
    const b = buildAssistMessages("reformuler", "T", "CTX", "BLOC");
    expect(b.length).toBe(a.length + 1);
    expect(b.some(m => m.content.includes("BLOC"))).toBe(true);
  });
});

describe("prepareReportAssist", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(db, "countRecentAccess").mockResolvedValue(0);
    vi.spyOn(db, "getStudyById").mockResolvedValue({
      id: 7,
      modality: "CT",
      studyDescription: "Scanner",
    } as any);
    vi.spyOn(db, "getReportByStudy").mockResolvedValue(null as any);
    vi.spyOn(embeddings, "embedText").mockResolvedValue([1, 0, 0]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("injecte les connaissances pertinentes (RAG)", async () => {
    vi.spyOn(store, "searchSimilar").mockResolvedValue([
      { source: "p.md", heading: "H", content: "ref", score: 0.9 },
    ]);
    const out = await prepareReportAssist(
      { studyId: 7, action: "reformuler", currentText: "txt" },
      { user: { id: 1 } }
    );
    expect(out.messages.some(m => m.content.includes("ref"))).toBe(true);
    expect(out.useClaude).toBe(false);
  });

  it("RAG fail-open : embedText jette → pas d'erreur", async () => {
    vi.spyOn(embeddings, "embedText").mockRejectedValue(new Error("down"));
    const out = await prepareReportAssist(
      { studyId: 7, action: "reformuler", currentText: "txt" },
      { user: { id: 1 } }
    );
    expect(out.messages.length).toBeGreaterThan(0);
  });
});
