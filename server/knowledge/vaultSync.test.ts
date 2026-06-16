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

  it("synchronise les .md et supprime les sources disparues", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-"));
    await fs.writeFile(path.join(dir, "a.md"), "# A\nContenu A");
    await fs.writeFile(path.join(dir, "b.md"), "# B\nContenu B");
    // En base, une source "vieux.md" qui n'existe plus dans le coffre.
    vi.spyOn(store, "listKnowledgeSources").mockResolvedValue([
      "a.md",
      "vieux.md",
    ]);
    const out = await syncVault(dir);
    expect(out.files).toBe(2);
    expect(out.chunks).toBeGreaterThan(0);
    // "vieux.md" supprimée (clearKnowledge appelée avec cette source).
    expect(
      (store.clearKnowledge as any).mock.calls.some(
        (c: any[]) => c[0] === "vieux.md"
      )
    ).toBe(true);
    expect(out.removed).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
