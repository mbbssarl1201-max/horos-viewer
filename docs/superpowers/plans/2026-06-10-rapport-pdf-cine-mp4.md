# Compte rendu PDF structuré + ciné MP4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à un médecin d'envoyer à un confrère, par email depuis Horos, un compte rendu radiologique structuré en PDF (en-tête Institut de Champel) accompagné d'un ciné MP4 de toute la série.

**Architecture:** Rendu **côté serveur**. Le client (panneau « Compte rendu » dans le viewer) n'envoie que du texte borné, le W/L, les index de coupes et les PNG d'images clés validés. Le serveur recharge l'étude/série de confiance (DB + MinIO), décode chaque coupe DICOM avec dcmjs, applique le fenêtrage, encode des PNG (pngjs), assemble un MP4 (ffmpeg) et un PDF (jsPDF), puis envoie les deux via l'email existant. Aucune IA dans ce plan.

**Tech Stack:** TypeScript, tRPC v11, dcmjs (déjà présent), pngjs (nouveau), ffmpeg (binaire conteneur), jsPDF (déjà présent), nodemailer/Mailu (déjà câblé), Vitest, React.

**Spec:** `docs/superpowers/specs/2026-06-10-rapport-pdf-cine-mp4-design.md`

---

## File Structure

- **Create** `server/report/dicomRaster.ts` — DICOM (buffer) → PNG niveaux de gris avec W/L. Une responsabilité : pixel → image.
- **Create** `server/report/dicomRaster.test.ts` — tests rastérisation (DICOM synthétique zéro-PHI).
- **Create** `server/report/champelHeader.ts` — constantes en-tête Institut de Champel + blason en base64.
- **Create** `server/report/reportPdf.ts` — assemblage du PDF structuré (jsPDF).
- **Create** `server/report/reportPdf.test.ts` — tests PDF.
- **Create** `server/report/cineVideo.ts` — frames PNG → MP4 (ffmpeg).
- **Create** `server/report/cineVideo.test.ts` — tests MP4 (skip si ffmpeg absent).
- **Modify** `server/storage.ts` — ajouter `storageGetBuffer(relKey)` (stream → Buffer).
- **Modify** `server/routers.ts` — ajouter la mutation `email.sendStudyReport`.
- **Create** `server/sendStudyReport.test.ts` — tests de la mutation (autorisation, rate-limit, fail-closed).
- **Create** `client/src/components/ReportPanel.tsx` — UI de composition du compte rendu.
- **Modify** `client/src/pages/Viewer.tsx` — bouton « Compte rendu » + capture d'image clé.
- **Modify** `Dockerfile` — `apk add --no-cache ffmpeg` (stage production).
- **Modify** `package.json` — dépendance `pngjs` + `@types/pngjs`.
- **Create** `client/public/blason-champel.png` — copie du blason (asset marque).

---

## Task 1: Dépendances & Docker (ffmpeg, pngjs, blason)

**Files:**

- Modify: `package.json`
- Modify: `Dockerfile`
- Create: `client/public/blason-champel.png`

- [ ] **Step 1: Installer pngjs**

Run:

```bash
pnpm add pngjs && pnpm add -D @types/pngjs
```

- [ ] **Step 2: Copier le blason Champel dans les assets du repo**

Run:

```bash
cp ~/institut-champel/client/public/blason.png client/public/blason-champel.png
ls -la client/public/blason-champel.png
```

Expected: le fichier existe (> 0 octet).

- [ ] **Step 3: Ajouter ffmpeg à l'image de production**

Dans `Dockerfile`, au stage `production` (après `FROM node:22-alpine AS production`), ajouter une ligne :

```dockerfile
# ffmpeg : assemblage du ciné MP4 de la série (compte rendu confrère).
RUN apk add --no-cache ffmpeg
```

- [ ] **Step 4: Vérifier que le build local passe encore**

Run: `pnpm check && pnpm build`
Expected: tsc sans erreur, build OK.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml Dockerfile client/public/blason-champel.png
git commit -m "build(report): ajoute pngjs + ffmpeg (image) + blason Champel"
```

---

## Task 2: Helper `storageGetBuffer`

**Files:**

- Modify: `server/storage.ts`
- Test: `server/storage.test.ts` (fichier existant — on ajoute un test)

- [ ] **Step 1: Écrire le test (échoue)**

Dans `server/storage.test.ts`, ajouter :

```ts
import { describe, it, expect, vi } from "vitest";

describe("storageGetBuffer", () => {
  it("concatène un stream en Buffer", async () => {
    vi.resetModules();
    const { Readable } = await import("stream");
    vi.doMock("@aws-sdk/client-s3", () => ({
      S3Client: class {
        send() {
          return Promise.resolve({
            Body: Readable.from([Buffer.from("AB"), Buffer.from("CD")]),
          });
        }
      },
      GetObjectCommand: class {},
      PutObjectCommand: class {},
      DeleteObjectCommand: class {},
    }));
    process.env.S3_ENDPOINT = "http://minio:9000";
    process.env.S3_BUCKET = "horos-dicom";
    process.env.S3_ACCESS_KEY = "k";
    process.env.S3_SECRET_KEY = "s";
    const { storageGetBuffer } = await import("./storage");
    const buf = await storageGetBuffer("dicom/x.dcm");
    expect(buf.toString()).toBe("ABCD");
  });
});
```

- [ ] **Step 2: Lancer le test (échoue)**

Run: `pnpm vitest run server/storage.test.ts -t "storageGetBuffer"`
Expected: FAIL — `storageGetBuffer` n'est pas exporté.

- [ ] **Step 3: Implémenter le helper**

Dans `server/storage.ts`, après `storageGetObject`, ajouter :

```ts
/**
 * Récupère un objet en Buffer complet (usage serveur interne : rastérisation
 * DICOM pour le compte rendu). Lit le stream renvoyé par storageGetObject.
 */
export async function storageGetBuffer(relKey: string): Promise<Buffer> {
  const { body } = await storageGetObject(relKey);
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
```

- [ ] **Step 4: Lancer le test (passe)**

Run: `pnpm vitest run server/storage.test.ts -t "storageGetBuffer"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/storage.ts server/storage.test.ts
git commit -m "feat(storage): storageGetBuffer (stream -> Buffer)"
```

---

## Task 3: Rastérisation DICOM (W/L → PNG)

**Files:**

- Create: `server/report/dicomRaster.ts`
- Test: `server/report/dicomRaster.test.ts`

- [ ] **Step 1: Écrire le test (échoue)**

`server/report/dicomRaster.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import dcmjs from "dcmjs";
import { PNG } from "pngjs";
import { renderDicomFrame } from "./dicomRaster";

// Construit un DICOM minimal uncompressed 2x2, 16-bit, MONOCHROME2,
// slope=1 intercept=0, pixels 0 / 1000 / 2000 / 4000.
function makeSyntheticDicom(photometric = "MONOCHROME2"): Buffer {
  const { DicomMetaDictionary, DicomDict } = dcmjs.data;
  const px = new Int16Array([0, 1000, 2000, 4000]);
  const dataset: any = {
    Rows: 2,
    Columns: 2,
    BitsAllocated: 16,
    BitsStored: 16,
    HighBit: 15,
    PixelRepresentation: 0,
    SamplesPerPixel: 1,
    PhotometricInterpretation: photometric,
    RescaleSlope: 1,
    RescaleIntercept: 0,
    PixelData: [px.buffer],
  };
  const denat = DicomMetaDictionary.denaturalizeDataset(dataset);
  const dict = new DicomDict({
    TransferSyntaxUID: "1.2.840.10008.1.2.1", // Explicit VR LE
    MediaStorageSOPClassUID: "1.2.840.10008.5.1.4.1.1.2",
    MediaStorageSOPInstanceUID: "1.2.3.4",
  });
  dict.dict = denat;
  return Buffer.from(dict.write());
}

describe("renderDicomFrame", () => {
  it("mappe le fenêtrage : WC/WW couvrant 0..4000 -> extrêmes 0 et 255", () => {
    const dcm = makeSyntheticDicom();
    // window [0,4000] => center 2000, width 4000
    const { png, rows, cols } = renderDicomFrame(dcm, {
      windowCenter: 2000,
      windowWidth: 4000,
    });
    expect(rows).toBe(2);
    expect(cols).toBe(2);
    const img = PNG.sync.read(png);
    // pixel 0 -> 0 ; pixel 4000 -> 255
    expect(img.data[0]).toBe(0); // R du pixel (0,0) = valeur 0
    const last = (2 * 2 - 1) * 4;
    expect(img.data[last]).toBe(255); // R du pixel (1,1) = valeur 4000
  });

  it("MONOCHROME1 inverse l'échelle", () => {
    const dcm = makeSyntheticDicom("MONOCHROME1");
    const { png } = renderDicomFrame(dcm, {
      windowCenter: 2000,
      windowWidth: 4000,
    });
    const img = PNG.sync.read(png);
    expect(img.data[0]).toBe(255); // valeur 0 -> 255 (inversé)
  });

  it("refuse un transfer syntax compressé (fail-closed)", () => {
    // 1.2.840.10008.1.2.4.90 = JPEG2000 lossless
    const { DicomDict, DicomMetaDictionary } = dcmjs.data;
    const dict = new DicomDict({
      TransferSyntaxUID: "1.2.840.10008.1.2.4.90",
      MediaStorageSOPClassUID: "1.2.840.10008.5.1.4.1.1.2",
      MediaStorageSOPInstanceUID: "1.2.3.4",
    });
    dict.dict = DicomMetaDictionary.denaturalizeDataset({
      Rows: 2,
      Columns: 2,
      BitsAllocated: 16,
      PixelRepresentation: 0,
      PhotometricInterpretation: "MONOCHROME2",
      PixelData: [new Int16Array([0, 0, 0, 0]).buffer],
    });
    const dcm = Buffer.from(dict.write());
    expect(() =>
      renderDicomFrame(dcm, { windowCenter: 0, windowWidth: 1 })
    ).toThrow(/compress/i);
  });
});
```

- [ ] **Step 2: Lancer le test (échoue)**

Run: `pnpm vitest run server/report/dicomRaster.test.ts`
Expected: FAIL — module `./dicomRaster` inexistant.

> Note : si `vitest.config.ts` ne couvre pas `server/report/`, l'ajouter au glob `include` (cf. extension déjà faite pour `client/src/lib`).

- [ ] **Step 3: Implémenter la rastérisation**

`server/report/dicomRaster.ts` :

```ts
import dcmjs from "dcmjs";
import { PNG } from "pngjs";

// Transfer syntaxes non compressés supportés en v1.
const UNCOMPRESSED = new Set([
  "1.2.840.10008.1.2", // Implicit VR LE
  "1.2.840.10008.1.2.1", // Explicit VR LE
  "1.2.840.10008.1.2.2", // Explicit VR BE (rare)
]);

export interface Windowing {
  windowCenter: number;
  windowWidth: number;
}

export interface RenderedFrame {
  png: Buffer;
  rows: number;
  cols: number;
}

/**
 * Décode une coupe DICOM NON COMPRESSÉE et la rend en PNG niveaux de gris
 * (RGBA, gris dupliqué) après application du rescale (slope/intercept) et du
 * fenêtrage W/L. MONOCHROME1 est inversé. Fail-closed si transfer syntax
 * compressé (JPEG/JPEG2000/RLE) — non géré en v1 (cf. spec, dcmtk = évolution).
 */
export function renderDicomFrame(
  dicomBuffer: Buffer,
  win: Windowing
): RenderedFrame {
  const arrayBuffer = dicomBuffer.buffer.slice(
    dicomBuffer.byteOffset,
    dicomBuffer.byteOffset + dicomBuffer.byteLength
  );
  const dicomDict = dcmjs.data.DicomMessage.readFile(arrayBuffer, {
    ignoreErrors: false,
  });
  const ts: string = dicomDict.meta?.["00020010"]?.Value?.[0] ?? "";
  if (ts && !UNCOMPRESSED.has(ts)) {
    throw new Error(`Transfer syntax compressé non supporté en v1 : ${ts}`);
  }
  const ds: any = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dicomDict.dict
  );

  const rows: number = ds.Rows;
  const cols: number = ds.Columns;
  const bits: number = ds.BitsAllocated ?? 16;
  const signed: boolean = (ds.PixelRepresentation ?? 0) === 1;
  const slope: number = Number(ds.RescaleSlope ?? 1) || 1;
  const intercept: number = Number(ds.RescaleIntercept ?? 0) || 0;
  const mono1: boolean = ds.PhotometricInterpretation === "MONOCHROME1";

  const pdRaw = Array.isArray(ds.PixelData) ? ds.PixelData[0] : ds.PixelData;
  const pixelBuffer: ArrayBuffer =
    pdRaw instanceof ArrayBuffer ? pdRaw : pdRaw.buffer;

  let samples: ArrayLike<number>;
  if (bits === 16)
    samples = signed
      ? new Int16Array(pixelBuffer)
      : new Uint16Array(pixelBuffer);
  else samples = new Uint8Array(pixelBuffer);

  const lower = win.windowCenter - win.windowWidth / 2;
  const span = win.windowWidth <= 0 ? 1 : win.windowWidth;

  const png = new PNG({ width: cols, height: rows });
  for (let i = 0; i < rows * cols; i++) {
    const hu = samples[i] * slope + intercept;
    let g = Math.round(((hu - lower) / span) * 255);
    if (g < 0) g = 0;
    else if (g > 255) g = 255;
    if (mono1) g = 255 - g;
    const o = i * 4;
    png.data[o] = g;
    png.data[o + 1] = g;
    png.data[o + 2] = g;
    png.data[o + 3] = 255;
  }
  return { png: PNG.sync.write(png), rows, cols };
}
```

- [ ] **Step 4: Lancer les tests (passent)**

Run: `pnpm vitest run server/report/dicomRaster.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/report/dicomRaster.ts server/report/dicomRaster.test.ts vitest.config.ts
git commit -m "feat(report): rastérisation DICOM non compressée -> PNG (W/L, MONOCHROME1, fail-closed compressé)"
```

---

## Task 4: En-tête Institut de Champel

**Files:**

- Create: `server/report/champelHeader.ts`

- [ ] **Step 1: Implémenter la constante d'en-tête (pas de test — données statiques)**

`server/report/champelHeader.ts` :

```ts
import { readFileSync } from "fs";
import { join } from "path";

/** Coordonnées officielles du cabinet (en-tête fixe du compte rendu). */
export const CHAMPEL_HEADER = {
  name: "Institut de Champel",
  address: "2 rue Firmin Massot",
  city: "1206 Genève",
  phone: "+41 22 347 29 30",
  email: "contact@medecin-champel.ch",
  motto: "Ne cesseris umquam",
};

/**
 * Blason en data-URL PNG pour jsPDF.addImage. L'asset est copié dans
 * client/public/blason-champel.png (Task 1) et embarqué au build serveur via
 * une lecture au démarrage. Chemin résolu relativement au cwd du conteneur
 * (dist/) ; on tente plusieurs emplacements et on renvoie null si introuvable
 * (le PDF se génère alors sans blason, en-tête texte uniquement).
 */
export function getChampelBlasonDataUrl(): string | null {
  const candidates = [
    join(process.cwd(), "dist/public/blason-champel.png"),
    join(process.cwd(), "client/public/blason-champel.png"),
    join(process.cwd(), "public/blason-champel.png"),
  ];
  for (const p of candidates) {
    try {
      const buf = readFileSync(p);
      return `data:image/png;base64,${buf.toString("base64")}`;
    } catch {
      /* essaie le suivant */
    }
  }
  return null;
}
```

- [ ] **Step 2: Vérifier la compilation**

Run: `pnpm check`
Expected: tsc sans erreur.

- [ ] **Step 3: Commit**

```bash
git add server/report/champelHeader.ts
git commit -m "feat(report): en-tête Institut de Champel (coordonnées + blason)"
```

---

## Task 5: Assemblage du PDF structuré

**Files:**

- Create: `server/report/reportPdf.ts`
- Test: `server/report/reportPdf.test.ts`

- [ ] **Step 1: Écrire le test (échoue)**

`server/report/reportPdf.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { buildReportPdf } from "./reportPdf";

const study = {
  id: 1,
  patientName: "TEST^PATIENT",
  birthDate: "19800101",
  patientId: "X1",
  studyDate: "20260324",
  modality: "CT",
  studyDescription: "Cheville",
  institution: "ignored",
} as any;

describe("buildReportPdf", () => {
  it("produit un PDF valide commençant par %PDF", () => {
    const pdf = buildReportPdf({
      study,
      report: {
        indication: "Douleur",
        technique: "CT 0.5mm",
        resultats: "RAS",
        conclusion: "Normal",
      },
      signature: "Dr Test",
      keyImages: [],
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(800);
  });

  it("n'échoue pas avec une image clé PNG", () => {
    // 1x1 PNG transparent
    const onePx =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const pdf = buildReportPdf({
      study,
      report: { indication: "", technique: "", resultats: "", conclusion: "" },
      signature: "Dr Test",
      keyImages: [
        { pngBase64: onePx, sliceIndex: 5, measurements: "Length 12mm" },
      ],
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
```

- [ ] **Step 2: Lancer le test (échoue)**

Run: `pnpm vitest run server/report/reportPdf.test.ts`
Expected: FAIL — module inexistant.

- [ ] **Step 3: Implémenter le PDF**

`server/report/reportPdf.ts` :

```ts
import { jsPDF } from "jspdf";
import { CHAMPEL_HEADER, getChampelBlasonDataUrl } from "./champelHeader";

export interface ReportSections {
  indication: string;
  technique: string;
  resultats: string;
  conclusion: string;
}

export interface KeyImage {
  pngBase64: string;
  sliceIndex: number;
  measurements?: string;
}

export interface ReportPdfInput {
  study: {
    id: number;
    patientName?: string | null;
    birthDate?: string | null;
    patientId?: string | null;
    studyDate?: string | null;
    modality?: string | null;
    studyDescription?: string | null;
  };
  report: ReportSections;
  signature: string;
  keyImages: KeyImage[];
}

const MARGIN = 14;

export function buildReportPdf(input: ReportPdfInput): Buffer {
  const doc = new jsPDF();
  const W = doc.internal.pageSize.getWidth();
  let y = 14;

  // ── En-tête Institut de Champel ─────────────────────────────────────────
  const blason = getChampelBlasonDataUrl();
  if (blason) {
    try {
      doc.addImage(blason, "PNG", MARGIN, 10, 18, 18);
    } catch {
      /* ignore */
    }
  }
  doc.setFontSize(15);
  doc.text(CHAMPEL_HEADER.name, blason ? MARGIN + 22 : MARGIN, y + 2);
  doc.setFontSize(9);
  doc.text(
    `${CHAMPEL_HEADER.address} • ${CHAMPEL_HEADER.city}  —  ${CHAMPEL_HEADER.phone}  —  ${CHAMPEL_HEADER.email}`,
    blason ? MARGIN + 22 : MARGIN,
    y + 8
  );
  y = 34;
  doc.setDrawColor(180);
  doc.line(MARGIN, y, W - MARGIN, y);
  y += 8;

  // ── Identité patient / étude (auto) ─────────────────────────────────────
  doc.setFontSize(13);
  doc.text("Compte rendu d'imagerie", MARGIN, y);
  y += 8;
  doc.setFontSize(10);
  [
    `Patient : ${input.study.patientName || "—"}`,
    `Né(e) le : ${input.study.birthDate || "—"}    ID : ${input.study.patientId || "—"}`,
    `Date d'étude : ${input.study.studyDate || "—"}    Modalité : ${input.study.modality || "—"}`,
    `Examen : ${input.study.studyDescription || "—"}`,
  ].forEach(line => {
    doc.text(line, MARGIN, y);
    y += 6;
  });
  y += 4;

  // ── Sections structurées ────────────────────────────────────────────────
  const section = (title: string, body: string) => {
    if (y > 270) {
      doc.addPage();
      y = 16;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(title, MARGIN, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(body || "—", W - 2 * MARGIN);
    for (const l of lines) {
      if (y > 285) {
        doc.addPage();
        y = 16;
      }
      doc.text(l, MARGIN, y);
      y += 5;
    }
    y += 4;
  };
  section("Indication", input.report.indication);
  section("Technique", input.report.technique);
  section("Résultats", input.report.resultats);
  section("Conclusion", input.report.conclusion);

  // ── Images clés ─────────────────────────────────────────────────────────
  for (const img of input.keyImages) {
    doc.addPage();
    let iy = 16;
    doc.setFontSize(10);
    doc.text(`Image clé — coupe ${img.sliceIndex + 1}`, MARGIN, iy);
    iy += 6;
    try {
      doc.addImage(
        `data:image/png;base64,${img.pngBase64}`,
        "PNG",
        MARGIN,
        iy,
        W - 2 * MARGIN,
        160
      );
      iy += 166;
    } catch {
      /* image illisible : on saute */
    }
    if (img.measurements) {
      doc.text(
        doc.splitTextToSize(`Mesures : ${img.measurements}`, W - 2 * MARGIN),
        MARGIN,
        iy
      );
    }
  }

  // ── Signature ───────────────────────────────────────────────────────────
  if (y > 265) {
    doc.addPage();
    y = 16;
  }
  y += 8;
  doc.setDrawColor(180);
  doc.line(MARGIN, y, MARGIN + 70, y);
  y += 5;
  doc.setFontSize(10);
  doc.text(`Dr ${input.signature}`, MARGIN, y);
  doc.setFontSize(8);
  doc.setTextColor(130);
  doc.text(CHAMPEL_HEADER.motto, W - MARGIN, y, { align: "right" });

  return Buffer.from(doc.output("arraybuffer"));
}
```

- [ ] **Step 4: Lancer les tests (passent)**

Run: `pnpm vitest run server/report/reportPdf.test.ts`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/report/reportPdf.ts server/report/reportPdf.test.ts
git commit -m "feat(report): PDF structuré (en-tête Champel, sections, images clés, signature)"
```

---

## Task 6: Ciné MP4 (ffmpeg)

**Files:**

- Create: `server/report/cineVideo.ts`
- Test: `server/report/cineVideo.test.ts`

- [ ] **Step 1: Écrire le test (échoue ; skip si ffmpeg absent)**

`server/report/cineVideo.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { PNG } from "pngjs";
import { buildCineMp4, ffmpegAvailable } from "./cineVideo";

function grayFrame(v: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < 16 * 16; i++) {
    const o = i * 4;
    png.data[o] = png.data[o + 1] = png.data[o + 2] = v;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("buildCineMp4", () => {
  it("produit un MP4 non vide", async () => {
    expect(ffmpegAvailable()).toBe(true);
    const frames = [grayFrame(0), grayFrame(128), grayFrame(255)];
    const mp4 = await buildCineMp4(frames, { fps: 12 });
    expect(mp4.length).toBeGreaterThan(200);
    // Boîte ftyp d'un MP4 (octets 4..8 = "ftyp")
    expect(mp4.subarray(4, 8).toString()).toBe("ftyp");
  });
});
```

- [ ] **Step 2: Lancer le test (échoue ou skip)**

Run: `pnpm vitest run server/report/cineVideo.test.ts`
Expected: FAIL (module inexistant) si ffmpeg présent, sinon SKIP.

- [ ] **Step 3: Implémenter le ciné**

`server/report/cineVideo.ts` :

```ts
import { execFile, execFileSync } from "child_process";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface CineOptions {
  fps: number;
}

/**
 * Assemble une suite de frames PNG en MP4 H.264 (yuv420p, compat large).
 * Écrit les frames dans un dossier temporaire ÉPHÉMÈRE supprimé en fin
 * (les frames contiennent de la PHI — jamais persistées hors temp).
 */
export async function buildCineMp4(
  frames: Buffer[],
  opts: CineOptions
): Promise<Buffer> {
  if (frames.length < 2)
    throw new Error("Au moins 2 frames requises pour un ciné");
  const dir = await mkdtemp(join(tmpdir(), "horos-cine-"));
  try {
    await Promise.all(
      frames.map((f, i) =>
        writeFile(join(dir, `frame-${String(i + 1).padStart(5, "0")}.png`), f)
      )
    );
    const out = join(dir, "cine.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-framerate",
      String(opts.fps),
      "-i",
      join(dir, "frame-%05d.png"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      // dimensions paires obligatoires pour yuv420p
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-movflags",
      "+faststart",
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Lancer le test (passe ou skip)**

Run: `pnpm vitest run server/report/cineVideo.test.ts`
Expected: PASS si ffmpeg présent localement, sinon SKIP propre.

- [ ] **Step 5: Commit**

```bash
git add server/report/cineVideo.ts server/report/cineVideo.test.ts
git commit -m "feat(report): ciné MP4 via ffmpeg (frames PNG -> H.264, temp éphémère)"
```

---

## Task 7: Mutation `email.sendStudyReport`

**Files:**

- Modify: `server/routers.ts` (routeur `email`, après `sendReport`)
- Test: `server/sendStudyReport.test.ts`

- [ ] **Step 1: Écrire le test (échoue)**

`server/sendStudyReport.test.ts` (mock des dépendances lourdes ; on teste la logique d'orchestration : autorisation, rate-limit, fail-closed). Adapter le harness aux mocks existants du repo (cf. `server/routers.test.ts`).

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks
const mocks = {
  getStudyById: vi.fn(),
  listSeriesByStudy: vi.fn(),
  listInstancesBySeries: vi.fn(),
  countRecentAccess: vi.fn(),
  recordAccess: vi.fn(),
  storageGetBuffer: vi.fn(),
  sendEmail: vi.fn(),
  renderDicomFrame: vi.fn(),
  buildCineMp4: vi.fn(),
  ffmpegAvailable: vi.fn(),
  buildReportPdf: vi.fn(),
};

vi.mock("./db", () => mocks);
vi.mock("./storage", () => ({
  storageGetBuffer: (...a: any) => mocks.storageGetBuffer(...a),
}));
vi.mock("./email", () => ({ sendEmail: (...a: any) => mocks.sendEmail(...a) }));
vi.mock("./report/dicomRaster", () => ({
  renderDicomFrame: (...a: any) => mocks.renderDicomFrame(...a),
}));
vi.mock("./report/cineVideo", () => ({
  buildCineMp4: (...a: any) => mocks.buildCineMp4(...a),
  ffmpegAvailable: (...a: any) => mocks.ffmpegAvailable(...a),
}));
vi.mock("./report/reportPdf", () => ({
  buildReportPdf: (...a: any) => mocks.buildReportPdf(...a),
}));

import { sendStudyReportImpl } from "./report/sendStudyReport";

const baseInput = {
  to: "confrere@example.ch",
  studyId: 1,
  seriesId: 1,
  report: { indication: "i", technique: "t", resultats: "r", conclusion: "c" },
  signature: "Test",
  windowCenter: 40,
  windowWidth: 400,
  keyImages: [],
  includeVideo: false,
  message: undefined,
};
const ctx = { user: { id: 7 }, req: { ip: "1.2.3.4" } } as any;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.countRecentAccess.mockResolvedValue(0);
  mocks.getStudyById.mockResolvedValue({ id: 1, patientName: "P" });
  mocks.listSeriesByStudy.mockResolvedValue([
    { id: 1, seriesInstanceUid: "1.2" },
  ]);
  mocks.listInstancesBySeries.mockResolvedValue([
    { storageKey: "a", instanceNumber: 1 },
    { storageKey: "b", instanceNumber: 2 },
  ]);
  mocks.buildReportPdf.mockReturnValue(Buffer.from("%PDF-1"));
  mocks.sendEmail.mockResolvedValue({ success: true });
});

describe("sendStudyReportImpl", () => {
  it("refuse au-delà du rate-limit (20/h)", async () => {
    mocks.countRecentAccess.mockResolvedValue(20);
    await expect(sendStudyReportImpl(baseInput, ctx)).rejects.toThrow(
      /limite|too many/i
    );
  });

  it("404 si l'étude n'existe pas", async () => {
    mocks.getStudyById.mockResolvedValue(undefined);
    await expect(sendStudyReportImpl(baseInput, ctx)).rejects.toThrow(
      /not found|introuvable/i
    );
  });

  it("400 si la série n'appartient pas à l'étude", async () => {
    mocks.listSeriesByStudy.mockResolvedValue([
      { id: 99, seriesInstanceUid: "x" },
    ]);
    await expect(sendStudyReportImpl(baseInput, ctx)).rejects.toThrow(
      /série|series/i
    );
  });

  it("PDF seul quand includeVideo=false : pas d'appel ciné, audit + email", async () => {
    const res = await sendStudyReportImpl(baseInput, ctx);
    expect(mocks.buildCineMp4).not.toHaveBeenCalled();
    expect(mocks.buildReportPdf).toHaveBeenCalled();
    expect(mocks.recordAccess).toHaveBeenCalled();
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(res.success).toBe(true);
  });

  it("fail-closed : si le rendu d'une frame échoue, pas d'email", async () => {
    mocks.ffmpegAvailable.mockReturnValue(true);
    mocks.renderDicomFrame.mockImplementation(() => {
      throw new Error("decode boom");
    });
    await expect(
      sendStudyReportImpl({ ...baseInput, includeVideo: true }, ctx)
    ).rejects.toThrow();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Lancer le test (échoue)**

Run: `pnpm vitest run server/sendStudyReport.test.ts`
Expected: FAIL — `./report/sendStudyReport` inexistant.

- [ ] **Step 3: Extraire la logique dans `server/report/sendStudyReport.ts`**

On met l'orchestration dans un module testable (la mutation tRPC ne fera que l'appeler).
`server/report/sendStudyReport.ts` :

```ts
import { TRPCError } from "@trpc/server";
import {
  getStudyById,
  listSeriesByStudy,
  listInstancesBySeries,
  countRecentAccess,
  recordAccess,
} from "../db";
import { storageGetBuffer } from "../storage";
import { sendEmail } from "../email";
import { renderDicomFrame } from "./dicomRaster";
import { buildCineMp4, ffmpegAvailable } from "./cineVideo";
import { buildReportPdf } from "./reportPdf";

const MAX_VIDEO_FRAMES = 400; // au-delà : sous-échantillonnage régulier
const CINE_FPS = 12;

export interface SendStudyReportInput {
  to: string;
  studyId: number;
  seriesId: number;
  report: {
    indication: string;
    technique: string;
    resultats: string;
    conclusion: string;
  };
  signature: string;
  windowCenter: number;
  windowWidth: number;
  keyImages: Array<{
    pngBase64: string;
    sliceIndex: number;
    measurements?: string;
  }>;
  includeVideo: boolean;
  message?: string;
}

function assertPng(b64: string) {
  const png = Buffer.from(b64, "base64");
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(sig)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Image clé : PNG attendu",
    });
  }
}

function subsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

export async function sendStudyReportImpl(
  input: SendStudyReportInput,
  ctx: { user: { id: number }; req?: { ip?: string } }
) {
  // Rate-limit (réutilise le compteur d'accès, 20/h).
  const recent = await countRecentAccess(ctx.user.id, "study.email.report", 60);
  if (recent >= 20) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Limite d'envois atteinte, réessayez plus tard.",
    });
  }

  const study = await getStudyById(input.studyId);
  if (!study)
    throw new TRPCError({ code: "NOT_FOUND", message: "Étude introuvable" });

  const series = await listSeriesByStudy(input.studyId);
  if (!series.some((s: any) => s.id === input.seriesId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Série inconnue pour cette étude",
    });
  }

  input.keyImages.forEach(k => assertPng(k.pngBase64));

  // PDF (toujours).
  const pdf = buildReportPdf({
    study,
    report: input.report,
    signature: input.signature,
    keyImages: input.keyImages,
  });

  const attachments: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }> = [
    {
      filename: `compte-rendu-${study.id}.pdf`,
      content: pdf,
      contentType: "application/pdf",
    },
  ];

  // Ciné MP4 (optionnel, fail-closed).
  if (input.includeVideo) {
    if (!ffmpegAvailable()) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Génération vidéo indisponible (ffmpeg)",
      });
    }
    const instances = (await listInstancesBySeries(input.seriesId))
      .slice()
      .sort(
        (a: any, b: any) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0)
      );
    if (instances.length >= 2) {
      const chosen = subsample(instances, MAX_VIDEO_FRAMES);
      const frames: Buffer[] = [];
      for (const inst of chosen) {
        const dicom = await storageGetBuffer(inst.storageKey);
        const { png } = renderDicomFrame(dicom, {
          windowCenter: input.windowCenter,
          windowWidth: input.windowWidth,
        });
        frames.push(png);
      }
      const mp4 = await buildCineMp4(frames, { fps: CINE_FPS });
      attachments.push({
        filename: `serie-cine-${study.id}.mp4`,
        content: mp4,
        contentType: "video/mp4",
      });
    }
  }

  const subjectName = study.patientName ? ` — ${study.patientName}` : "";
  const safeMsg = (input.message ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const result = await sendEmail({
    to: input.to,
    subject: `Compte rendu d'imagerie${subjectName}`,
    html:
      `<div style="font-family:sans-serif;max-width:600px">` +
      `<p>Bonjour,</p>` +
      `<p>Veuillez trouver ci-joint le compte rendu d'imagerie (PDF)` +
      (input.includeVideo ? ` et le ciné de la série (MP4)` : ``) +
      `.</p>` +
      (safeMsg ? `<p>${safeMsg}</p>` : "") +
      `<p style="color:#888;font-size:12px">Document médical confidentiel — destiné au seul destinataire.</p>` +
      `</div>`,
    attachments,
  });

  await recordAccess({
    userId: ctx.user.id,
    action: "study.email.report",
    studyId: study.id,
    detail: input.to,
    ipAddress: ctx.req?.ip ?? null,
  });

  if (!result.success) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: result.error || "Échec d'envoi de l'email",
    });
  }
  return { success: true };
}
```

> Note ordre : l'audit `recordAccess` est appelé après l'envoi comme dans `sendReport` existant. Pour le test « fail-closed », l'exception du rendu survient AVANT `sendEmail` → l'email n'est pas envoyé (comportement vérifié).

- [ ] **Step 4: Brancher la mutation tRPC dans `server/routers.ts`**

Dans le routeur `email: router({ ... })`, après `sendReport`, ajouter :

```ts
    sendStudyReport: medicalProcedure
      .input(z.object({
        to: z.string().email(),
        studyId: z.number(),
        seriesId: z.number(),
        report: z.object({
          indication: z.string().max(5000),
          technique: z.string().max(5000),
          resultats: z.string().max(20000),
          conclusion: z.string().max(5000),
        }),
        signature: z.string().min(1).max(120),
        windowCenter: z.number().finite(),
        windowWidth: z.number().finite(),
        keyImages: z.array(z.object({
          pngBase64: z.string().min(1).max(10_000_000),
          sliceIndex: z.number().int().min(0),
          measurements: z.string().max(500).optional(),
        })).max(20),
        includeVideo: z.boolean(),
        message: z.string().max(500).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { sendStudyReportImpl } = await import("./report/sendStudyReport");
        return sendStudyReportImpl(input, ctx as any);
      }),
```

- [ ] **Step 5: Lancer les tests (passent)**

Run: `pnpm vitest run server/sendStudyReport.test.ts`
Expected: 5 PASS.

- [ ] **Step 6: tsc + suite complète**

Run: `pnpm check && pnpm test`
Expected: tsc 0 erreur ; toute la suite verte (les nouveaux tests inclus, cineVideo skip si pas de ffmpeg local).

- [ ] **Step 7: Commit**

```bash
git add server/report/sendStudyReport.ts server/sendStudyReport.test.ts server/routers.ts
git commit -m "feat(report): mutation email.sendStudyReport (PDF + ciné MP4, RBAC, rate-limit, fail-closed, audit)"
```

---

## Task 8: Panneau « Compte rendu » (client)

**Files:**

- Create: `client/src/components/ReportPanel.tsx`

- [ ] **Step 1: Implémenter le composant**

`client/src/components/ReportPanel.tsx` (formulaire contrôlé ; reçoit les images clés capturées par le viewer et la fonction d'envoi). Pas de PDF côté client.

```tsx
import { useState } from "react";
import { trpc } from "@/lib/trpc";

export interface ReportKeyImage {
  pngBase64: string;
  sliceIndex: number;
  measurements?: string;
}

interface ReportPanelProps {
  studyId: number;
  seriesId: number;
  windowWidth: number;
  windowCenter: number;
  keyImages: ReportKeyImage[];
  onRemoveKeyImage: (index: number) => void;
  onClose: () => void;
}

export default function ReportPanel({
  studyId,
  seriesId,
  windowWidth,
  windowCenter,
  keyImages,
  onRemoveKeyImage,
  onClose,
}: ReportPanelProps) {
  const [to, setTo] = useState("");
  const [signature, setSignature] = useState("");
  const [indication, setIndication] = useState("");
  const [technique, setTechnique] = useState("");
  const [resultats, setResultats] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [includeVideo, setIncludeVideo] = useState(true);
  const [message, setMessage] = useState("");

  const send = trpc.email.sendStudyReport.useMutation();

  const submit = async () => {
    await send.mutateAsync({
      to,
      studyId,
      seriesId,
      report: { indication, technique, resultats, conclusion },
      signature,
      windowWidth,
      windowCenter,
      keyImages,
      includeVideo,
      message: message || undefined,
    });
  };

  const field =
    "w-full rounded bg-muted/40 border border-border px-2 py-1 text-sm";
  return (
    <div className="absolute right-0 top-0 z-30 h-full w-[360px] bg-background border-l border-border p-4 overflow-y-auto space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm">Compte rendu</h3>
        <button onClick={onClose} className="text-xs text-muted-foreground">
          Fermer
        </button>
      </div>

      <input
        className={field}
        placeholder="Email du confrère"
        value={to}
        onChange={e => setTo(e.target.value)}
      />
      <textarea
        className={field}
        rows={2}
        placeholder="Indication"
        value={indication}
        onChange={e => setIndication(e.target.value)}
      />
      <textarea
        className={field}
        rows={2}
        placeholder="Technique"
        value={technique}
        onChange={e => setTechnique(e.target.value)}
      />
      <textarea
        className={field}
        rows={5}
        placeholder="Résultats"
        value={resultats}
        onChange={e => setResultats(e.target.value)}
      />
      <textarea
        className={field}
        rows={2}
        placeholder="Conclusion"
        value={conclusion}
        onChange={e => setConclusion(e.target.value)}
      />

      <div>
        <div className="text-xs font-medium mb-1">
          Images clés ({keyImages.length})
        </div>
        <div className="flex flex-wrap gap-2">
          {keyImages.map((k, i) => (
            <div key={i} className="relative">
              <img
                src={`data:image/png;base64,${k.pngBase64}`}
                className="w-16 h-16 object-cover rounded border border-border"
                alt={`coupe ${k.sliceIndex + 1}`}
              />
              <button
                onClick={() => onRemoveKeyImage(i)}
                className="absolute -top-1 -right-1 bg-destructive text-white rounded-full w-4 h-4 text-[10px] leading-none"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          Utilisez « Ajouter l'image » dans la barre d'outils pour capturer la
          coupe courante.
        </p>
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={includeVideo}
          onChange={e => setIncludeVideo(e.target.checked)}
        />
        Inclure le ciné MP4 de toute la série
      </label>

      <input
        className={field}
        placeholder="Signature (nom du médecin)"
        value={signature}
        onChange={e => setSignature(e.target.value)}
      />
      <textarea
        className={field}
        rows={2}
        placeholder="Message (optionnel)"
        value={message}
        onChange={e => setMessage(e.target.value)}
      />

      <button
        onClick={submit}
        disabled={send.isPending || !to || !signature}
        className="w-full rounded bg-primary text-primary-foreground py-2 text-sm font-medium disabled:opacity-50"
      >
        {send.isPending ? "Génération et envoi…" : "Envoyer au confrère"}
      </button>
      {send.isError && (
        <p className="text-xs text-destructive">{send.error.message}</p>
      )}
      {send.isSuccess && (
        <p className="text-xs text-green-500">Compte rendu envoyé.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Vérifier la compilation**

Run: `pnpm check`
Expected: tsc sans erreur (le routeur `email.sendStudyReport` doit être typé côté serveur — Task 7 faite).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ReportPanel.tsx
git commit -m "feat(report): panneau client de composition du compte rendu"
```

---

## Task 9: Intégration viewer (bouton + capture d'image clé)

**Files:**

- Modify: `client/src/pages/Viewer.tsx`

- [ ] **Step 1: Ajouter l'état + la capture + le bouton + le panneau**

Dans `client/src/pages/Viewer.tsx` :

1. Imports en tête :

```tsx
import ReportPanel, { type ReportKeyImage } from "@/components/ReportPanel";
import { FileText } from "lucide-react"; // icône bouton (ajuster si déjà importée)
```

2. État (près des autres `useState`) :

```tsx
const [reportOpen, setReportOpen] = useState(false);
const [reportKeyImages, setReportKeyImages] = useState<ReportKeyImage[]>([]);
```

3. Capture de la coupe courante depuis le canvas du viewer (réutilise la même source que le bouton « Capture » PNG existant — repérer dans ce fichier comment Capture obtient le `canvas`/dataURL et factoriser une fonction `captureCurrentPng(): string | null` qui renvoie le base64 sans préfixe). Puis :

```tsx
const addKeyImage = () => {
  const b64 = captureCurrentPng();
  if (!b64) return;
  setReportKeyImages(prev => [
    ...prev,
    { pngBase64: b64, sliceIndex: currentSlice },
  ]);
};
```

4. Boutons dans la barre d'outils (à côté d'« Email ») :

```tsx
<button onClick={addKeyImage} className="toolbar-btn" title="Ajouter la coupe courante au compte rendu">
  <FileText className="w-4 h-4" /><span>Ajouter l'image</span>
</button>
<button onClick={() => setReportOpen(true)} className="toolbar-btn" title="Composer un compte rendu">
  <FileText className="w-4 h-4" /><span>Compte rendu</span>
</button>
```

> Reprendre les classes/markup exacts d'un bouton voisin (ex. « Email ») pour rester cohérent ; `toolbar-btn` est un placeholder à remplacer par les classes réelles utilisées dans ce fichier.

5. Le panneau (dans le conteneur du viewer, après `</div>` de la zone d'affichage) :

```tsx
{
  reportOpen && study && (
    <ReportPanel
      studyId={study.id}
      seriesId={selectedSeries!}
      windowWidth={windowWidth}
      windowCenter={windowCenter}
      keyImages={reportKeyImages}
      onRemoveKeyImage={i =>
        setReportKeyImages(p => p.filter((_, idx) => idx !== i))
      }
      onClose={() => setReportOpen(false)}
    />
  );
}
```

- [ ] **Step 2: Vérifier compilation + build**

Run: `pnpm check && pnpm build`
Expected: tsc 0 erreur, build OK.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Viewer.tsx
git commit -m "feat(report): bouton Compte rendu + capture d'images clés dans le viewer"
```

---

## Task 10: Build image, déploiement, vérification live

**Files:** aucun (ops)

- [ ] **Step 1: Pousser la branche + PR vers self-host**

```bash
git push -u origin feat/rapport-pdf-cine
gh pr create --repo mbbssarl1201-max/horos-viewer --base self-host --head feat/rapport-pdf-cine \
  --title "feat(report): compte rendu PDF structuré + ciné MP4 (envoi confrère)" --fill
```

- [ ] **Step 2: Merger → CI construit l'image (Dockerfile avec ffmpeg)**

```bash
gh pr merge feat/rapport-pdf-cine --repo mbbssarl1201-max/horos-viewer --merge
gh run watch "$(gh run list --repo mbbssarl1201-max/horos-viewer --workflow=deploy-image.yml --limit 1 --json databaseId -q '.[0].databaseId')" --repo mbbssarl1201-max/horos-viewer --exit-status
```

- [ ] **Step 3: Redéployer sur le VPS (bump SHA)**

Sur `root@76.13.55.44`, dans `/docker/horos` : remplacer le tag d'image (migrate + app) par le nouveau SHA de `origin/self-host`, `docker compose pull app migrate && docker compose up -d`. Vérifier `docker exec horos-app-1 ffmpeg -version` (ffmpeg présent dans l'image).

- [ ] **Step 4: Vérification live (Playwright headless)**

Login `https://horos.mbbssarl.ch`, ouvrir `/viewer/1`, cliquer « Ajouter l'image » sur 1-2 coupes, ouvrir « Compte rendu », remplir les sections + email de test + signature, cocher le ciné, envoyer. Attendre la fin de génération. Confirmer la réception de l'email avec **2 pièces jointes** (PDF + MP4) dans la boîte de test, et ouvrir le PDF (en-tête Champel + sections + images clés) et le MP4 (ciné lisible).

- [ ] **Step 5: Mémoire**

Mettre à jour la fiche mémoire Horos : feature compte rendu PDF+MP4 livrée et déployée, sous-système A (IA) restant.

---

## Self-review (auteur)

- **Couverture spec** : C (PDF structuré, en-tête Champel, identité auto, 4 sections, images clés+mesures, signature) → Tasks 4,5,8,9 ✓ ; B (ciné MP4 série, W/L serveur) → Tasks 2,3,6,7 ✓ ; envoi email PDF+MP4 → Task 7 ✓ ; RBAC/rate-limit/audit/fail-closed → Task 7 ✓ ; Docker ffmpeg → Task 1 ✓ ; tests → Tasks 2,3,5,6,7 ✓ ; vérif live → Task 10 ✓.
- **Placeholders** : deux marqueurs `toolbar-btn` et `captureCurrentPng` en Task 9 sont explicitement signalés comme « à reprendre du code voisin existant » (l'implémenteur lit le fichier Viewer pour les classes réelles et la capture PNG déjà utilisée par le bouton Capture). Le reste contient du code complet.
- **Cohérence des types** : `renderDicomFrame(buffer, {windowCenter, windowWidth})`, `buildCineMp4(frames, {fps})`, `buildReportPdf({study, report, signature, keyImages})`, `sendStudyReportImpl(input, ctx)` — signatures identiques entre tâches et tests.
- **Hors-périmètre** respecté : pas d'IA, pas de mot de passe, pas de vidéo-dans-PDF, pas d'Orthanc.
