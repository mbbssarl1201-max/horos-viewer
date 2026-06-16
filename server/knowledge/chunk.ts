/**
 * Découpage PUR d'un markdown en chunks pour le RAG : par titres (#…), avec une
 * borne de taille. Conserve la source (nom de fichier) et le dernier titre
 * rencontré (heading). Sans I/O.
 */
export interface KnowledgeChunk {
  source: string;
  heading: string;
  content: string;
}

export function chunkMarkdown(
  source: string,
  markdown: string,
  opts?: { maxChars?: number }
): KnowledgeChunk[] {
  const maxChars = opts?.maxChars ?? 1000;
  const out: KnowledgeChunk[] = [];
  let heading = "";
  let buf = "";
  const flush = () => {
    const c = buf.trim();
    if (c) out.push({ source, heading, content: c });
    buf = "";
  };
  for (const line of markdown.split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h) {
      flush();
      heading = h[2].trim();
      continue;
    }
    if (buf && buf.length + line.length + 1 > maxChars) flush();
    let rest = line;
    while (rest.length > maxChars) {
      out.push({ source, heading, content: rest.slice(0, maxChars) });
      rest = rest.slice(maxChars);
    }
    buf += (buf ? "\n" : "") + rest;
  }
  flush();
  return out;
}
