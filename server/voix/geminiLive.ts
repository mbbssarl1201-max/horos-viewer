// server/voix/geminiLive.ts
// Session vocale Gemini Live pour MediView — navigation radiologique.
// Le proxy Vertex (vertexLiveProxy.ts) ouvre la session avec ces paramètres.
// PHI-safe : Eva ne lit jamais de données patient à voix haute sans nécessité.

const trim = (s?: string) => (s ?? "").trim();

function vertexVoixModele(): string {
  return (
    trim(process.env.VOICE_VERTEX_MODEL) ||
    "gemini-live-2.5-flash-preview-native-audio"
  );
}
function vertexVoixRegion(): string {
  return (
    trim(process.env.VOICE_VERTEX_REGION) ||
    trim(process.env.VERTEX_LOCATION) ||
    "europe-west1"
  );
}

const INSTRUCTIONS =
  "Tu es Eva, l'assistante vocale de MediView (logiciel de visualisation radiologique). " +
  "Tu parles français, naturellement et brièvement. " +
  "Tu aides le radiologue à naviguer dans l'interface. " +
  "Quand on te demande d'ouvrir une page, utilise l'outil 'naviguer' avec la route. " +
  "Pages : worklist principale (/), viewer DICOM (/viewer/<studyId>), " +
  "base de connaissances radiologiques (/admin/knowledge), recherche (/knowledge). " +
  "Ne lis jamais de données PHI (nom patient, diagnostic) à voix haute.";

const TOOLS = [
  {
    type: "function",
    name: "naviguer",
    description:
      "Navigue vers une page de MediView dans le navigateur Selenium.",
    parameters: {
      type: "object",
      properties: {
        route: {
          type: "string",
          description:
            "Route absolue ex: / · /viewer/42 · /knowledge · /admin/knowledge",
        },
      },
      required: ["route"],
    },
  },
];

export function construireSessionGeminiLive(): {
  model: string;
  systemInstruction: string;
  tools: unknown[];
  region: string;
} {
  return {
    model: vertexVoixModele(),
    systemInstruction: INSTRUCTIONS,
    tools: TOOLS,
    region: vertexVoixRegion(),
  };
}
