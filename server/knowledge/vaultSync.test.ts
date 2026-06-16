// server/knowledge/vaultSync.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { isIgnoredPath, listVaultMarkdown, syncVault } from "./vaultSync";
import * as embeddings from "./embeddings";
import * as store from "./store";

describe("isIgnoredPath", () => {
  it("ignore .obsidian, .trash et dossiers cachés", () => {
    expect(isIgnoredPath(".obsidian/app.json")).toBe(true);
    expect(isIgnoredPath(".trash/old.md")).toBe(true);
    expect(isIgnoredPath("notes/.hidden/x.md")).toBe(true);
  });
  it("garde les notes normales", () => {
    expect(isIgnoredPath("notes/a.md")).toBe(false);
    expect(isIgnoredPath("protocoles/irm.md")).toBe(false);
  });
});

describe("listVaultMarkdown", () => {
  it("dossier inexistant → []", async () => {
    expect(await listVaultMarkdown("/n/existe/pas/xyz")).toEqual([]);
  });
  it("renvoie les .md relatifs, ignore .obsidian", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-"));
    await fs.mkdir(path.join(dir, "protocoles"), { recursive: true });
    await fs.mkdir(path.join(dir, ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(dir, "a.md"), "# A");
    await fs.writeFile(path.join(dir, "protocoles", "irm.md"), "# IRM");
    await fs.writeFile(path.join(dir, ".obsidian", "app.json"), "{}");
    await fs.writeFile(path.join(dir, "notes.txt"), "non md");
    const rels = (await listVaultMarkdown(dir)).sort();
    expect(rels).toEqual(["a.md", "protocoles/irm.md"]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("syncVault", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(embeddings, "embedText").mockResolvedValue([1, 0, 0]);
    vi.spyOn(store, "clearKnowledge").mockResolvedValue(undefined as any);
    vi.spyOn(store, "insertChunks").mockResolvedValue(1 as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("dir vide → erreur explicite, rien d'inséré", async () => {
    const out = await syncVault("");
    expect(out.files).toBe(0);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it("synchronise les .md (sources préfixées vault:) et supprime les sources coffre disparues, jamais les uploads manuels", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-"));
    await fs.writeFile(path.join(dir, "a.md"), "# A\nContenu A");
    await fs.writeFile(path.join(dir, "b.md"), "# B\nContenu B");
    // En base : une source coffre disparue (vault:vieux.md), la source coffre
    // courante (vault:a.md), et un upload manuel (manuel.md, sans préfixe).
    vi.spyOn(store, "listKnowledgeSources").mockResolvedValue([
      "vault:a.md",
      "vault:vieux.md",
      "manuel.md",
    ]);
    const out = await syncVault(dir);
    expect(out.files).toBe(2);
    expect(out.chunks).toBeGreaterThan(0);
    const cleared = (store.clearKnowledge as any).mock.calls.map(
      (c: any[]) => c[0]
    );
    // les chunks insérés portent le préfixe vault:
    expect((store.insertChunks as any).mock.calls[0][0][0].source).toContain(
      "vault:"
    );
    // vault:vieux.md supprimée ; manuel.md JAMAIS supprimée
    expect(cleared).toContain("vault:vieux.md");
    expect(cleared).not.toContain("manuel.md");
    expect(out.removed).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
