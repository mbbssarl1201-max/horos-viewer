// Self-hosted object storage on an S3-compatible backend (MinIO).
// Replaces the Manus "Forge" presigned-S3 service.
//
// Stored objects are raw patient DICOM (PHI). Downloads are served through the
// authenticated `/manus-storage/{key}` proxy (see storageProxy.ts), which
// streams bytes from S3 — the bucket is never exposed publicly.

import { Readable } from "stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";

let _s3: S3Client | null = null;

function getS3(): { client: S3Client; bucket: string } {
  if (!ENV.s3Endpoint || !ENV.s3AccessKey || !ENV.s3SecretKey) {
    throw new Error(
      "Storage config missing: set S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY",
    );
  }
  if (!_s3) {
    _s3 = new S3Client({
      endpoint: ENV.s3Endpoint,
      region: ENV.s3Region,
      forcePathStyle: ENV.s3ForcePathStyle,
      credentials: {
        accessKeyId: ENV.s3AccessKey,
        secretAccessKey: ENV.s3SecretKey,
      },
    });
  }
  return { client: _s3, bucket: ENV.s3Bucket };
}

/** True when the storage backend is configured (used to gate the proxy). */
export function isStorageConfigured(): boolean {
  return Boolean(ENV.s3Endpoint && ENV.s3AccessKey && ENV.s3SecretKey);
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const { client, bucket } = getS3();
  const key = appendHashSuffix(normalizeKey(relKey));

  const body = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  return { key, url: `/manus-storage/${key}` };
}

export async function storageGet(
  relKey: string,
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/manus-storage/${key}` };
}

/**
 * Presigned GET URL — for server-internal use (e.g. the export ZIP route fetches
 * objects over the internal network). Not handed to browsers.
 */
export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const { client, bucket } = getS3();
  const key = normalizeKey(relKey);
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 300 },
  );
}

/**
 * Fetch an object's bytes as a stream for the authenticated download proxy to
 * pipe to the client, keeping the bucket private.
 */
export async function storageGetObject(
  relKey: string,
): Promise<{ body: Readable; contentType?: string }> {
  const { client, bucket } = getS3();
  const key = normalizeKey(relKey);
  const out = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return {
    body: out.Body as Readable,
    contentType: out.ContentType,
  };
}

/**
 * Delete an object. Called when a study is removed so its DICOM files don't
 * linger in the bucket as orphaned PHI (nLPD/GDPR right-to-erasure). Idempotent
 * on S3 — deleting a missing key is a no-op. A falsy key is skipped entirely.
 */
export async function storageDelete(relKey: string): Promise<void> {
  if (!relKey) return;
  const { client, bucket } = getS3();
  const key = normalizeKey(relKey);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
