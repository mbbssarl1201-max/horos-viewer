// server/knowledge/vaultSync.ts
import { promises as fs } from "fs";
import path from "path";
import { chunkMarkdown } from "./chunk";
import { embedText } from "./embeddings";
import { insertChunks, clearKnowledge, listKnowledgeSources } from "./store";

const MAX_FILE_BYTES = 2_000_000;

// Préfixe des sources issues du coffre Obsidian. Isole la synchro de coffre des
// chunks uploadés manuellement (2b, sources sans préfixe) : la suppression des
// sources « disparues » ne touche QUE les sources `vault:`.
const VAULT_PREFIX = "vault:";

/** Chemins ignorés : .obsidian, .trash, tout segment commençant par un point. PUR. */
export function isIgnoredPath(rel: string): boolean {
  return rel.split("/").some(seg => seg.startsWith("."));
}

/** Liste récursive des `.md` (chemins relatifs), hors dossiers ignorés. */
export async function listVaultMarkdown(dir: string): Promise<string[]> {
  if (!dir) return [];
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isIgnoredPath(childRel)) continue;
      // Anti-traversée : on ne suit jamais les liens symboliques (pourraient
      // pointer hors du coffre monté).
      if (e.isSymbolicLink()) continue;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) await walk(childAbs, childRel);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md"))
        out.push(childRel);
    }
  }
  await walk(dir, "");
  return out;
}

export interface SyncResult {
  files: number;
  chunks: number;
  removed: number;
  errors: string[];
}

/**
 * Synchronise le coffre `dir` vers la base RAG : par fichier, remplace ses
 * chunks (clear par source + insert) ; supprime les sources absentes du coffre.
 * Best-effort par fichier. Embeddings + lecture LOCAUX (PHI-safe).
 */
export async function syncVault(dir: string): Promise<SyncResult> {
  const errors: string[] = [];
  if (!dir) {
    return {
      files: 0,
      chunks: 0,
      removed: 0,
      errors: ["coffre non configuré"],
    };
  }
  const rels = await listVaultMarkdown(dir);
  if (rels.length === 0) {
    // Dossier vide ou introuvable : on ne supprime rien (sécurité).
    return {
      files: 0,
      chunks: 0,
      removed: 0,
      errors: [`coffre vide ou introuvable: ${dir}`],
    };
  }
  let chunksTotal = 0;
  for (const rel of rels) {
    try {
      const stat = await fs.stat(path.join(dir, rel));
      if (stat.size > MAX_FILE_BYTES) {
        errors.push(`${rel}: fichier trop volumineux (ignoré)`);
        continue;
      }
      const content = await fs.readFile(path.join(dir, rel), "utf8");
      const source = `${VAULT_PREFIX}${rel}`;
      const chunks = chunkMarkdown(source, content);
      const rows: {
        source: string;
        heading: string;
        content: string;
        embedding: number[];
      }[] = [];
      for (const c of chunks) {
        try {
          const embedding = await embedText(
            `${c.heading}\n${c.content}`.trim()
          );
          rows.push({ ...c, embedding });
        } catch {
          errors.push(`${rel}: embedding échoué (chunk)`);
        }
      }
      // N'écrase l'ancienne version QUE si on a produit des embeddings : sinon
      // (Ollama indisponible) on conserve l'existant plutôt que de vider la source.
      if (rows.length > 0) {
        await clearKnowledge(source);
        chunksTotal += await insertChunks(rows);
      } else if (chunks.length > 0) {
        errors.push(
          `${rel}: aucun embedding produit (ancienne version conservée)`
        );
      }
    } catch {
      errors.push(`${rel}: lecture/ingestion échouée`);
    }
  }
  // Supprime les sources COFFRE en base qui ne sont plus dans le coffre. Ne
  // touche jamais les sources d'upload manuel (sans préfixe `vault:`).
  let removed = 0;
  const current = new Set(rels.map(r => `${VAULT_PREFIX}${r}`));
  for (const src of await listKnowledgeSources()) {
    if (src.startsWith(VAULT_PREFIX) && !current.has(src)) {
      await clearKnowledge(src);
      removed++;
    }
  }
  return { files: rels.length, chunks: chunksTotal, removed, errors };
}
