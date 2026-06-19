export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
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
  // Plan de contrôle du GPU vision (sidecar gpu-control) : pilote la mise en
  // veille (shelve) / réveil (unshelve) de l'instance GPU pour ne payer qu'à
  // l'usage. Vide = fonctionnalité désactivée (le GPU est supposé toujours là).
  gpuControlUrl: process.env.GPU_CONTROL_URL ?? "",
  gpuControlToken: process.env.GPU_CONTROL_TOKEN ?? "",
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
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
  // nLPD (audit H4) : envoyer des pixels d'imagerie (PHI potentiellement brûlé)
  // vers Claude (cloud US) exige un consentement documenté (DPA). Sans ce flag,
  // même si AI_BACKEND=claude, on retombe sur Ollama local (PHI-safe).
  cloudAiPhiConsent:
    (process.env.MEDIVIEW_CLOUD_AI_PHI_CONSENT ?? "false") === "true",
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
};

// Garde fail-safe : signaler quand SMTP_INSECURE est posé en production mais
// délibérément ignoré (TLS forcé).
if (
  process.env.NODE_ENV === "production" &&
  process.env.SMTP_INSECURE === "true"
) {
  console.warn("[env] SMTP_INSECURE ignoré en production (TLS forcé)");
}
