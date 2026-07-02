import crypto from "node:crypto";
import { ENV } from "./env";

/**
 * Chiffrement applicatif au repos des identités patient (nLPD / secret médical).
 *
 * Deux modes :
 *  - `encryptField`         : IV aléatoire — champs d'AFFICHAGE uniquement
 *                             (nom, date de naissance, sexe).
 *  - `encryptDeterministic` : IV dérivé du clair (HMAC) → même clair ⇒ même
 *                             chiffré. Permet l'égalité en base (dédup du
 *                             `patientId` DICOM) tout en restant chiffré.
 *
 * Sûreté GCM : l'IV déterministe n'est réutilisé que pour un clair IDENTIQUE
 * (construction de type SIV) ⇒ pas de réutilisation (key, IV) sur des clairs
 * différents. Sans `ENCRYPTION_KEY`, les fonctions sont fail-open (renvoient le
 * clair) pour permettre une migration progressive et un démarrage sans clé.
 */

const ALGO = "aes-256-gcm";
const RAND_PREFIX = "v1:"; // IV aléatoire
const DET_PREFIX = "d1:"; // IV déterministe (égalité possible)
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer | null {
  const raw = ENV.encryptionKey;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY invalide : 32 octets attendus (base64 de 32 octets)"
    );
  }
  return key;
}

export function isEncryptionEnabled(): boolean {
  return getKey() !== null;
}

function pack(prefix: string, iv: Buffer, tag: Buffer, ct: Buffer): string {
  return prefix + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function encryptField(
  plaintext: string | null | undefined
): string | null {
  if (plaintext == null) return null;
  const key = getKey();
  if (!key) return plaintext; // fail-open : pas de clé configurée
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return pack(RAND_PREFIX, iv, cipher.getAuthTag(), ct);
}

export function encryptDeterministic(
  plaintext: string | null | undefined
): string | null {
  if (plaintext == null) return null;
  const key = getKey();
  if (!key) return plaintext;
  const iv = crypto
    .createHmac("sha256", key)
    .update("iv:" + plaintext)
    .digest()
    .subarray(0, IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return pack(DET_PREFIX, iv, cipher.getAuthTag(), ct);
}

/**
 * Déchiffre un champ chiffré (`v1:`/`d1:`). Renvoie le clair tel quel s'il n'a
 * pas de préfixe connu (donnée non migrée / fail-open) ou si la clé est absente.
 */
export function decryptField(value: string | null | undefined): string | null {
  if (value == null) return null;
  const prefix = value.slice(0, 3);
  if (prefix !== RAND_PREFIX && prefix !== DET_PREFIX) return value; // clair
  const key = getKey();
  if (!key) return value; // pas de clé : on ne peut pas déchiffrer
  const raw = Buffer.from(value.slice(3), "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8"
  );
}
