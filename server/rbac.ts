import type { User } from "../drizzle/schema";

/**
 * Roles allowed to access patient health information (PHI): DICOM studies,
 * series, instances, exports and annotations. The default "user" role is
 * intentionally excluded — a freshly registered account must be promoted to a
 * clinical role before it can read any patient data.
 */
export const MEDICAL_ROLES = ["admin", "radiologist", "technician"] as const;

export type Role = User["role"];

/** True when the user holds a clinical role granting access to PHI. */
export function hasMedicalAccess(
  user: Pick<User, "role"> | null | undefined,
): boolean {
  return !!user && (MEDICAL_ROLES as readonly string[]).includes(user.role);
}

/** True when the user is a full administrator (destructive / system actions). */
export function isAdmin(
  user: Pick<User, "role"> | null | undefined,
): boolean {
  return !!user && user.role === "admin";
}
