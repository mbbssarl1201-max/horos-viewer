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
  "Tu es Eva, radiologue IA senior et assistante vocale de MediView. " +
  "Tu as une expertise complète en imagerie diagnostique : TDM, IRM, radio, écho, mammographie, médecine nucléaire. " +
  "Tu maîtrises la sémiologie radiologique, les fenêtrages HU, les classifications (BI-RADS, LI-RADS, PI-RADS, Fleischner, LungRADS), " +
  "les diagnostics différentiels et les protocoles d'injection. " +
  "Tu parles UNIQUEMENT en français, naturellement, comme un radiologue senior qui s'adresse à un collègue. " +
  "Tu contrôles TOUTE l'application MediView : navigation, albums, recherche, études. " +
  "Outils : naviguer, chercherEtudes, selectAlbum, searchWorklist. " +
  "Pages : worklist (/), viewer (/viewer/<id>), base de connaissances (/admin/knowledge), recherche (/knowledge). " +
  "Albums : database (tout), recent_hour (Just Acquired), added_hour (Just Added), opened (Just Opened). " +
  "Pour les questions radiologiques, réponds avec précision : valeurs HU, dimensions, caractéristiques sémiologiques, score ou classification si applicable, diagnostics différentiels. " +
  "PHI INTERDIT : jamais de nom, prénom ni date de naissance patient à voix haute.";

const TOOLS = [
  {
    type: "function",
    name: "naviguer",
    description: "Navigue vers une page de MediView (React + Selenium).",
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
  {
    type: "function",
    name: "chercherEtudes",
    description:
      "Retourne les études DICOM récentes (7 jours) sans PHI. Utile pour lister les examens.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "selectAlbum",
    description:
      "Sélectionne un album dans la worklist MediView pour filtrer les études.",
    parameters: {
      type: "object",
      properties: {
        album: {
          type: "string",
          enum: ["database", "recent_hour", "added_hour", "opened"],
          description:
            "Clé de l'album : database=tout, recent_hour=Just Acquired, added_hour=Just Added, opened=Just Opened",
        },
      },
      required: ["album"],
    },
  },
  {
    type: "function",
    name: "searchWorklist",
    description:
      "Lance une recherche textuelle dans la worklist MediView (par description, modalité, etc.).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Termes de recherche ex: 'thorax', 'CT', 'MR genou'",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "genererCompteRendu",
    description:
      "Génère un compte rendu radiologique IA structuré pour une étude DICOM. Utilise quand le médecin demande un CR, une analyse IA ou une aide à la rédaction.",
    parameters: {
      type: "object",
      properties: {
        studyId: {
          type: "number",
          description:
            "Identifiant entier de l'étude (visible dans la worklist)",
        },
      },
      required: ["studyId"],
    },
  },
  {
    type: "function",
    name: "envoyerRapport",
    description:
      "Envoie le compte rendu IA d'une étude par email. Utilise après avoir généré un CR ou quand le médecin demande d'envoyer un rapport.",
    parameters: {
      type: "object",
      properties: {
        studyId: {
          type: "number",
          description: "Identifiant de l'étude",
        },
        emailDestinataire: {
          type: "string",
          description:
            "Adresse email du destinataire (ex: dr.martin@hopital.ch)",
        },
      },
      required: ["studyId", "emailDestinataire"],
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
