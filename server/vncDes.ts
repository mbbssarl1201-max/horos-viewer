// server/vncDes.ts
//
// DES-ECB (chiffrement seul) en pur TypeScript, pour la SEULE réponse au
// challenge d'auth VNC (RFC 6143 §7.2.2). Node ≥17 (OpenSSL 3) a relégué DES
// au « legacy provider » : createCipheriv("des-ecb", …) lève
// ERR_OSSL_EVP_UNSUPPORTED. Réactiver ce provider par flag global rouvrirait
// des algorithmes faibles pour tout le process — inacceptable ici ; on
// implémente donc localement. ⚠️ Ce DES n'est PAS une protection
// cryptographique (mot de passe VNC ≤ 8 caractères, protocole hérité) : c'est
// uniquement le rituel imposé par RFB. La vraie protection du flux est le
// TLS + l'auth session en amont (cockpit.routes.ts).
//
// Implémentation par tables FIPS 46-3, validée par le vecteur de test
// historique FIPS 81 (clé 0123456789ABCDEF, « Now is t » → 3FA40E8A984D4815)
// dans vncDes.test.ts, et en conditions réelles contre le serveur VNC Selenium.

/* eslint-disable no-bitwise */

// Tables FIPS 46-3 (indices 1-based d'origine).
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46,
  38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17,
  9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63,
  55, 47, 39, 31, 23, 15, 7,
];
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46,
  14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20,
  60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33,
  1, 41, 9, 49, 17, 57, 25,
];
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15,
  16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28,
  29, 28, 29, 30, 31, 32, 1,
];
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14,
  32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43,
  35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54,
  46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7,
  27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39,
  56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SBOX = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2,
    13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9,
    7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2,
    8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12,
    6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4,
    6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2,
    12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6,
    15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1,
    3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4,
    7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9,
    12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7,
    12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4,
    10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9,
    1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6,
    8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10,
    3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10,
    13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

// bits[] = tableau de 0/1, index 0 = bit le plus significatif du buffer.
function toBits(buf: Buffer, n: number): number[] {
  const bits = new Array<number>(n);
  for (let i = 0; i < n; i++)
    bits[i] = (buf[i >> 3]! >> (7 - (i & 7))) & 1;
  return bits;
}
function fromBits(bits: number[]): Buffer {
  const out = Buffer.alloc(bits.length >> 3);
  for (let i = 0; i < bits.length; i++)
    if (bits[i]) out[i >> 3] = out[i >> 3]! | (1 << (7 - (i & 7)));
  return out;
}
function permute(bits: number[], table: number[]): number[] {
  const out = new Array<number>(table.length);
  for (let i = 0; i < table.length; i++) out[i] = bits[table[i]! - 1]!;
  return out;
}

function keySchedule(key: Buffer): number[][] {
  let cd = permute(toBits(key, 64), PC1); // 56 bits
  const subkeys: number[][] = [];
  for (const s of SHIFTS) {
    const c = cd.slice(0, 28), d = cd.slice(28);
    cd = [...c.slice(s), ...c.slice(0, s), ...d.slice(s), ...d.slice(0, s)];
    subkeys.push(permute(cd, PC2)); // 48 bits
  }
  return subkeys;
}

function feistel(r: number[], subkey: number[]): number[] {
  const x = permute(r, E).map((b, i) => b ^ subkey[i]!);
  const out: number[] = [];
  for (let s = 0; s < 8; s++) {
    const o = s * 6;
    const row = (x[o]! << 1) | x[o + 5]!;
    const col =
      (x[o + 1]! << 3) | (x[o + 2]! << 2) | (x[o + 3]! << 1) | x[o + 4]!;
    const v = SBOX[s]![row * 16 + col]!;
    out.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
  }
  return permute(out, P);
}

/** Chiffre UN bloc de 8 octets en DES-ECB (chiffrement seulement). */
export function desEncryptBlock(key: Buffer, block: Buffer): Buffer {
  if (key.length !== 8 || block.length !== 8)
    throw new Error("DES : clé et bloc doivent faire 8 octets");
  const subkeys = keySchedule(key);
  const bits = permute(toBits(block, 64), IP);
  let l = bits.slice(0, 32), r = bits.slice(32);
  for (let round = 0; round < 16; round++) {
    const f = feistel(r, subkeys[round]!);
    const newR = l.map((b, i) => b ^ f[i]!);
    l = r;
    r = newR;
  }
  return fromBits(permute([...r, ...l], FP));
}

/**
 * Réponse au challenge d'auth VNC (RFC 6143 §7.2.2) : DES-ECB du challenge de
 * 16 octets avec le mot de passe (≤ 8 car., complété de zéros) comme clé —
 * dont les bits de CHAQUE OCTET sont inversés (particularité historique VNC).
 */
export function vncDESResponse(password: string, challenge: Buffer): Buffer {
  const raw = Buffer.from(password.substring(0, 8).padEnd(8, "\0"), "latin1");
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    let b = raw[i] ?? 0;
    let rev = 0;
    for (let j = 0; j < 8; j++) {
      rev = (rev << 1) | (b & 1);
      b >>= 1;
    }
    key[i] = rev;
  }
  if (challenge.length !== 16)
    throw new Error("Challenge VNC : 16 octets attendus");
  return Buffer.concat([
    desEncryptBlock(key, challenge.subarray(0, 8)),
    desEncryptBlock(key, challenge.subarray(8, 16)),
  ]);
}
