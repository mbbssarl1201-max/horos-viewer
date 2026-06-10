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
  ollamaVisionModel: process.env.OLLAMA_VISION_MODEL ?? "qwen2.5vl:3b",
  // SMTP Email
  smtpHost: process.env.SMTP_HOST ?? "",
  smtpPort: parseInt(process.env.SMTP_PORT ?? "587"),
  smtpUser: process.env.SMTP_USER ?? "",
  smtpPassword: process.env.SMTP_PASSWORD ?? "",
  smtpFrom: process.env.SMTP_FROM ?? "noreply@horos-viewer.com",
  // Allow a self-hosted relay without a public TLS cert (e.g. Mailu notls on
  // the same host). Only safe when the SMTP hop stays on a trusted network.
  smtpInsecure: (process.env.SMTP_INSECURE ?? "false") === "true",
};
