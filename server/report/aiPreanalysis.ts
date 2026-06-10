import { TRPCError } from "@trpc/server";
import { ENV } from "../_core/env";
import { getStudyById, countRecentAccess, recordAccess } from "../db";

export interface PreanalysisKeyImage {
  pngBase64: string;
  sliceIndex: number;
}

export interface PreanalysisResult {
  resultats: string;
  conclusion: string;
  model: string;
}

const SYSTEM_PROMPT = [
  "Tu es un assistant de pré-analyse d'imagerie médicale destiné à un MÉDECIN (pas au patient).",
  "Tu observes une ou plusieurs coupes et tu proposes un BROUILLON en français, à valider par le médecin.",
  "Règles STRICTES :",
  "- N'invente AUCUNE mesure, valeur chiffrée, ni diagnostic catégorique.",
  '- Exprime explicitement l\'incertitude ("aspect évocateur de", "à corréler", "sous réserve").',
  "- Ne tente pas d'identifier le patient.",
  "- Réponds UNIQUEMENT avec deux sections, exactement dans ce format :",
  "Résultats:",
  "<description des observations>",
  "",
  "Conclusion:",
  "<synthèse prudente>",
].join("\n");

export async function generatePreanalysis(
  keyImages: PreanalysisKeyImage[],
  opts: { indication?: string }
): Promise<PreanalysisResult> {
  const model = ENV.ollamaVisionModel;
  const userText = opts.indication
    ? `Indication clinique : ${opts.indication}\nDécris tes observations puis conclus.`
    : "Décris tes observations puis conclus.";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let content = "";
  try {
    const resp = await fetch(`${ENV.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: "30s",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: userText,
            images: keyImages.map(k => k.pngBase64),
          },
        ],
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Ollama HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = await resp.json();
    content = data?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
  return { ...parseSections(content), model };
}

// Indirection pour permettre au test de mocker l'appel réseau.
export const _internal = { generatePreanalysis };

function assertPng(b64: string) {
  const png = Buffer.from(b64, "base64");
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(sig)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Image clé : PNG attendu",
    });
  }
}

export interface RunAiPreanalysisInput {
  studyId: number;
  keyImages: PreanalysisKeyImage[];
  indication?: string;
}

export async function runAiPreanalysis(
  input: RunAiPreanalysisInput,
  ctx: { user: { id: number }; req?: { ip?: string } }
): Promise<PreanalysisResult> {
  const recent = await countRecentAccess(
    ctx.user.id,
    "study.ai.preanalysis",
    60
  );
  if (recent >= 30) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Limite de pré-analyses atteinte, réessayez plus tard.",
    });
  }
  const study = await getStudyById(input.studyId);
  if (!study)
    throw new TRPCError({ code: "NOT_FOUND", message: "Étude introuvable" });

  input.keyImages.forEach(k => assertPng(k.pngBase64));

  const result = await _internal.generatePreanalysis(input.keyImages, {
    indication: input.indication,
  });

  await recordAccess({
    userId: ctx.user.id,
    action: "study.ai.preanalysis",
    studyId: study.id,
    detail: result.model,
    ipAddress: ctx.req?.ip ?? null,
  });
  return result;
}

export function parseSections(text: string): {
  resultats: string;
  conclusion: string;
} {
  const m = text.match(
    /Résultats\s*:?\s*([\s\S]*?)\n\s*Conclusion\s*:?\s*([\s\S]*)$/i
  );
  if (m) return { resultats: m[1].trim(), conclusion: m[2].trim() };
  return { resultats: text.trim(), conclusion: "" };
}
