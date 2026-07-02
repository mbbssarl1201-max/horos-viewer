export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  // Chiffrement applicatif au repos des identités patient (nLPD). 32 octets en
  // base64. Vide = fail-open (données en clair) pour migration progressive.
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  // Self-hosted object storage (S3-compatible, e.g. MinIO). Replaces Forge.
  s3Endpoint: process.env.S3_ENDPOINT ?? "",
  s3Region: process.env.S3_REGION ?? "us-east-1",
  s3Bucket: process.env.S3_BUCKET ?? "horos-dicom",
  s3AccessKey: process.env.S3_ACCESS_KEY ?? "",
  s3SecretKey: process.env.S3_SECRET_KEY ?? "",
  // MinIO needs path-style addressing (bucket in the path, not the host).
  s3ForcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
  // Auth: openId of the bootstrap admin (self-host email/password mode).
  authMode: process.env.AUTH_MODE ?? "local",
  // Orthanc PACS Server
  orthancUrl: process.env.ORTHANC_URL ?? "http://localhost:8042",
  orthancUser: process.env.ORTHANC_USER ?? "",
  orthancPassword: process.env.ORTHANC_PASSWORD ?? "",
  // IA locale (Ollama auto-hébergé) — pré-analyse vision des images clés.
  ollamaUrl: process.env.OLLAMA_URL ?? "http://ollama-hermes:11434",
  // Endpoint Ollama DÉDIÉ à la vision (pré-analyse d'images). Séparé d'`ollamaUrl`
  // pour router uniquement la vision vers le GPU (L4 Infomaniak, via tunnel chiffré),
  // tout en gardant le texte/embeddings sur l'Ollama CPU local. Repli sur `ollamaUrl`.
  ollamaVisionUrl:
    process.env.OLLAMA_VISION_URL ??
    process.env.OLLAMA_URL ??
    "http://ollama-hermes:11434",
  ollamaVisionModel: process.env.OLLAMA_VISION_MODEL ?? "qwen2.5vl:7b",
  // 2e modèle vision pour la « double lecture » (avis indépendant anomalie oui/non).
  ollamaVisionModel2: process.env.OLLAMA_VISION_MODEL2 ?? "qwen2.5vl:3b",
  // Provider VISION : "ollama" (local A100, défaut) | "infomaniak" (VLM managé CH,
  // ex. gemma-4-31B / Mistral-Small-119B). DORMANT tant que VISION_PROVIDER≠infomaniak
  // ET INFOMANIAK_VISION_KEY absent → aucun changement de comportement.
  // ⚠️ Basculer sur Infomaniak = envoyer les images patient à un sous-traitant CH
  // (dé-identifier avant + mettre à jour l'AIPD).
  visionProvider: (process.env.VISION_PROVIDER ?? "ollama").toLowerCase(),
  infomaniakVisionUrl:
    process.env.INFOMANIAK_VISION_URL ?? process.env.INFOMANIAK_BASE_URL ?? "",
  infomaniakVisionKey: process.env.INFOMANIAK_VISION_KEY ?? "",
  infomaniakVisionModel:
    process.env.INFOMANIAK_VISION_MODEL ?? "google/gemma-4-31B-it",
  // Plan de contrôle du GPU vision (sidecar gpu-control) : pilote la mise en
  // veille (shelve) / réveil (unshelve) de l'instance GPU pour ne payer qu'à
  // l'usage. Vide = fonctionnalité désactivée (le GPU est supposé toujours là).
  gpuControlUrl: process.env.GPU_CONTROL_URL ?? "",
  gpuControlToken: process.env.GPU_CONTROL_TOKEN ?? "",
  // Service de segmentation CT open-source (TotalSegmentator) sur le GPU.
  // Vide = fonctionnalité désactivée. PHI-safe : tourne sur le GPU suisse.
  segServiceUrl: process.env.SEG_SERVICE_URL ?? "",
  segToken: process.env.SEG_TOKEN ?? "",
  // Détecteur d'IA radiologique CERTIFIÉ CE (plateforme deepc/Incepto/Blackford).
  // Aide à la détection (fractures, nodules, hémorragie…). Vide = désactivé.
  // `mock` = démo sans clé. `http` = vraie plateforme (URL + clé + DPA nLPD requis).
  // Brancher UNIQUEMENT un hébergement CH/UE (pas de cloud US pour le PHI).
  detectorProvider: process.env.DETECTOR_PROVIDER ?? "", // "" | "mock" | "http"
  detectorApiUrl: process.env.DETECTOR_API_URL ?? "",
  detectorApiKey: process.env.DETECTOR_API_KEY ?? "",
  // Service de transcription vocale (Whisper) sur le GPU. PHI-safe (Suisse).
  // Vide = dictée désactivée.
  whisperUrl: process.env.WHISPER_URL ?? "",
  whisperToken: process.env.WHISPER_TOKEN ?? "",
  // Modèle de texte Ollama pour le chat Hermès (instruction-following). Présent
  // sur ollama-hermes. PHI-safe (local).
  ollamaTextModel: process.env.OLLAMA_TEXT_MODEL ?? "qwen2.5:3b",
  // Modèle d'embeddings Ollama (RAG Hermès). Local, PHI-safe. `ollama pull nomic-embed-text`.
  ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
  // Coffre Obsidian dédié (connaissances radiologiques NON-PHI) monté en lecture
  // seule. Vide = non configuré. Source de la mémoire RAG (sync à la demande).
  knowledgeVaultDir: process.env.KNOWLEDGE_VAULT_DIR ?? "",
  // Backend IA pour l'analyse d'images : "claude" (Anthropic cloud, meilleure
  // qualité) ou "ollama" (local, PHI-safe). Défaut "ollama".
  aiBackend: process.env.AI_BACKEND ?? "ollama",
  // Moteur de GÉNÉRATION DE CR (pré-analyse) : "auto" (défaut, historique :
  // Infomaniak CH prioritaire dès que sa clé est là), "claude" (router le CR
  // vers Claude — ex. Fable 5 — sans retirer Infomaniak des autres chemins
  // vision), "infomaniak". Cf. server/report/crProvider.ts.
  crProvider: (process.env.CR_PROVIDER ?? "auto").toLowerCase(),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
  // nLPD (audit H4) : envoyer des pixels d'imagerie (PHI potentiellement brûlé)
  // vers Claude (cloud US) exige un consentement documenté (DPA). Sans ce flag,
  // même si AI_BACKEND=claude, on retombe sur Ollama local (PHI-safe).
  cloudAiPhiConsent:
    (process.env.MEDIVIEW_CLOUD_AI_PHI_CONSENT ?? "false") === "true",

  // --- Moteurs d'IA CERTIFIÉS tiers (dispositifs médicaux CE/FDA/Swissmedic) --
  // Chacun est INACTIF tant que son URL+clé ne sont pas fournies (contrat requis).
  // Le flag *_PHI_CONSENT garde l'envoi de PHI vers le cloud du fournisseur
  // (DPA + nLPD + enregistrement Swissmedic obligatoires avant activation).
  // CARPL.ai — marketplace vendor-neutral (recommandé pour démarrer/évaluer).
  carplUrl: process.env.CARPL_URL ?? "",
  carplApiKey: process.env.CARPL_API_KEY ?? "",
  carplPhiConsent: (process.env.CARPL_PHI_CONSENT ?? "false") === "true",
  // Blackford — plateforme 90+ apps multi-vendeurs.
  blackfordUrl: process.env.BLACKFORD_URL ?? "",
  blackfordApiKey: process.env.BLACKFORD_API_KEY ?? "",
  blackfordPhiConsent:
    (process.env.BLACKFORD_PHI_CONSENT ?? "false") === "true",
  // Gleamer BoneView — radio (fractures/MSK).
  gleamerUrl: process.env.GLEAMER_URL ?? "",
  gleamerApiKey: process.env.GLEAMER_API_KEY ?? "",
  gleamerPhiConsent: (process.env.GLEAMER_PHI_CONSENT ?? "false") === "true",
  // Koios DS Breast — échographie/mammo mammaire (BI-RADS).
  koiosUrl: process.env.KOIOS_URL ?? "",
  koiosApiKey: process.env.KOIOS_API_KEY ?? "",
  koiosPhiConsent: (process.env.KOIOS_PHI_CONSENT ?? "false") === "true",
  // Aidoc — CT/urgences (AVC, EP, hémorragie).
  aidocUrl: process.env.AIDOC_URL ?? "",
  aidocApiKey: process.env.AIDOC_API_KEY ?? "",
  aidocPhiConsent: (process.env.AIDOC_PHI_CONSENT ?? "false") === "true",

  // SMTP Email
  smtpHost: process.env.SMTP_HOST ?? "",
  smtpPort: parseInt(process.env.SMTP_PORT ?? "587"),
  smtpUser: process.env.SMTP_USER ?? "",
  smtpPassword: process.env.SMTP_PASSWORD ?? "",
  smtpFrom: process.env.SMTP_FROM ?? "noreply@horos-viewer.com",
  // Allow a self-hosted relay without a public TLS cert (e.g. Mailu notls on
  // the same host). Only safe when the SMTP hop stays on a trusted network.
  // Fail-safe : en production, on IGNORE SMTP_INSECURE et on force TLS — le PHI
  // ne doit jamais transiter sur un canal SMTP non chiffré en prod.
  smtpInsecure:
    process.env.NODE_ENV !== "production" &&
    (process.env.SMTP_INSECURE ?? "false") === "true",
  // Allow-list OPTIONNELLE de domaines destinataires pour les envois PHI
  // (compte-rendu). Vide = AUCUNE restriction. Séparateur : virgule.
  reportEmailAllowedDomains: (process.env.REPORT_EMAIL_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
  // Boîte du RIS (système d'information de radiologie) à notifier sur les
  // transitions de statut/priorité d'une étude. OPT-IN : si vide, AUCUNE
  // notification automatique n'est envoyée (la fonctionnalité est un no-op).
  risNotifyEmail: process.env.RIS_NOTIFY_EMAIL ?? "",
  // Observabilité (opt-in). Si défini ET que @sentry/node est installé, les
  // erreurs serveur sont remontées à Sentry. Sinon, no-op (aucune dépendance
  // ajoutée). Pour activer : `npm i @sentry/node` puis définir SENTRY_DSN.
  sentryDsn: process.env.SENTRY_DSN ?? "",
  // Intervalle (ms) du worker agent CR autonome. Défaut 5 min. 0 = ne pas démarrer.
  agentPollMs: Number(process.env.AGENT_POLL_MS ?? "300000"),
  // Backend du chat Hermès : "local" (Ollama, PHI-safe) | "vertex" (Gemini UE) | "claude".
  chatBackend: process.env.CHAT_BACKEND ?? "local",
  geminiVertexProject: process.env.GEMINI_VERTEX_PROJECT ?? "",
  geminiVertexLocation: process.env.GEMINI_VERTEX_LOCATION ?? "europe-west1",
  geminiVertexModel: process.env.GEMINI_VERTEX_MODEL ?? "gemini-2.0-flash",
  geminiVertexToken: process.env.GEMINI_VERTEX_TOKEN ?? "",
  // Coordonnées GPS du cabinet pour la météo Open-Meteo (pas de clé requise).
  cabinetLat: process.env.CABINET_LAT ?? "",
  cabinetLng: process.env.CABINET_LNG ?? "",
  // Service account Google Calendar (JSON stringifié). Vide = calendrier désactivé.
  googleServiceAccountJson: process.env.GOOGLE_SA_KEY_JSON ?? "",
  // ID du calendrier Google à lire (défaut = "primary" du service account).
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID ?? "primary",
  // Clé API NCBI optionnelle (lève la limite 3→10 req/s pour PubMed).
  ncbiApiKey: process.env.NCBI_API_KEY ?? "",
};

// Garde fail-safe : signaler quand SMTP_INSECURE est posé en production mais
// délibérément ignoré (TLS forcé).
if (
  process.env.NODE_ENV === "production" &&
  process.env.SMTP_INSECURE === "true"
) {
  console.warn("[env] SMTP_INSECURE ignoré en production (TLS forcé)");
}
