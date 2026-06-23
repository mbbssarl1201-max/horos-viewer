import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../../drizzle/schema", () => ({
  reports: {},
  studies: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
  desc: vi.fn(col => col),
}));
vi.mock("../report/autoReportAgent", () => ({
  runAgentOnce: vi.fn().mockResolvedValue({ generated: 1 }),
}));

import {
  listPendingSignaturesFn,
  getCRDraftFn,
  requestCRGenerationFn,
} from "./crTools";
import { getDb } from "../db";

const makeDb = (reports: any[], joinResult?: any[]) => ({
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(joinResult ?? reports),
          }),
          limit: vi.fn().mockResolvedValue(joinResult ?? reports),
        }),
      }),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(reports),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(reports),
        }),
      }),
    }),
  }),
});

describe("listPendingSignaturesFn", () => {
  it("retourne les drafts IA en attente de signature", async () => {
    vi.mocked(getDb).mockResolvedValue(
      makeDb(
        [],
        [{ reportId: 1, studyId: 10, modality: "CT", studyDate: "2026-06-24" }]
      ) as any
    );
    const result = await listPendingSignaturesFn();
    expect(result.pending.length).toBe(1);
    expect(result.pending[0].reportId).toBe(1);
    expect(result.pending[0].modality).toBe("CT");
  });

  it("retourne un tableau vide si aucun draft", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([], []) as any);
    const result = await listPendingSignaturesFn();
    expect(result.pending).toEqual([]);
  });
});

describe("getCRDraftFn", () => {
  it("retourne found: false si aucun rapport", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([]) as any);
    const result = await getCRDraftFn({ studyId: 99 });
    expect(result.found).toBe(false);
  });

  it("retourne le rapport sans PHI patient", async () => {
    vi.mocked(getDb).mockResolvedValue(
      makeDb(
        [],
        [
          {
            id: 5,
            status: "draft",
            resultats: "Résultat normal",
            conclusion: "RAS",
            modality: "IRM",
            studyDate: "2026-06-24",
          },
        ]
      ) as any
    );
    const result = await getCRDraftFn({ studyId: 10 });
    expect(result.found).toBe(true);
    expect(result.draftText).toContain("Résultat normal");
    expect(result.status).toBe("draft");
  });
});

describe("requestCRGenerationFn", () => {
  it("retourne alreadyExists: true si draft existant", async () => {
    vi.mocked(getDb).mockResolvedValue(
      makeDb([{ id: 3, status: "draft" }]) as any
    );
    const result = await requestCRGenerationFn({ studyId: 10 });
    expect(result.alreadyExists).toBe(true);
    expect(result.jobStarted).toBe(false);
  });

  it("déclenche runAgentOnce si pas de draft existant", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([]) as any);
    const { runAgentOnce } = await import("../report/autoReportAgent");
    const result = await requestCRGenerationFn({ studyId: 10 });
    expect(result.jobStarted).toBe(true);
    expect(result.alreadyExists).toBe(false);
  });
});
