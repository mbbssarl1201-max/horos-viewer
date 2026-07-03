// server/importToken.ts
//
// Jeton de service pour la passerelle DICOM du cabinet (Institut de Champel).
// Né de la panne du 2026-07-03 : la passerelle s'authentifiait par cookie de
// session (7 jours) SANS logique de reconnexion → à l'expiration, ~3 req/s en
// 401 et plus aucun examen importé. Un jeton statique longue durée, limité à
// la seule procédure dicom.import, supprime cette dépendance au cookie.
//
// Sécurité :
// - Inactif tant que DICOM_IMPORT_TOKEN n'est pas défini avec ≥ 32 caractères
//   (pas de surface d'attaque par défaut) ;
// - Comparaison en temps constant (timingSafeEqual) ;
// - Portée STRICTEMENT dicom.import (écriture d'imagerie) — aucune lecture PHI.
import { timingSafeEqual } from "crypto";

export function isValidImportToken(
  authorization: string | string[] | undefined | null
): boolean {
  const expected = process.env.DICOM_IMPORT_TOKEN ?? "";
  if (expected.length < 32) return false;
  if (typeof authorization !== "string") return false;
  if (!authorization.startsWith("Bearer ")) return false;
  const presented = Buffer.from(authorization.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  if (presented.length !== wanted.length) return false;
  return timingSafeEqual(presented, wanted);
}
