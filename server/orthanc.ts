/**
 * Orthanc PACS Proxy Service
 * Provides DICOMweb API (WADO-RS, STOW-RS, QIDO-RS) and DICOM networking (C-FIND, C-MOVE, C-STORE)
 * via an external Orthanc server.
 */
import { ENV } from "./_core/env";

interface OrthancConfig {
  url: string;
  username: string;
  password: string;
}

/**
 * Validate a DICOM AE Title before interpolating it into an Orthanc REST URL.
 * Defense-in-depth against path traversal / SSRF: callers are also validated
 * at the tRPC input layer, but these functions are exported and could be
 * reached from elsewhere. Returns a URL-encoded, safe segment.
 */
function safeAeTitle(aet: string): string {
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(aet)) {
    throw new Error("Invalid AE Title");
  }
  return encodeURIComponent(aet);
}

function getOrthancConfig(): OrthancConfig {
  return {
    url: ENV.orthancUrl,
    username: ENV.orthancUser,
    password: ENV.orthancPassword,
  };
}

function getAuthHeader(): string {
  const { username, password } = getOrthancConfig();
  if (!username) return "";
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

export async function orthancFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const config = getOrthancConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  const auth = getAuthHeader();
  if (auth) {
    headers["Authorization"] = auth;
  }

  const url = `${config.url}${path}`;
  return fetch(url, { ...options, headers });
}

/**
 * Check if Orthanc server is reachable
 */
export async function checkOrthancConnection(): Promise<{
  connected: boolean;
  version?: string;
  error?: string;
}> {
  try {
    const res = await orthancFetch("/system");
    if (res.ok) {
      const data = await res.json();
      return { connected: true, version: data.Version };
    }
    return { connected: false, error: `HTTP ${res.status}` };
  } catch (err: any) {
    return { connected: false, error: err.message || "Connection failed" };
  }
}

/**
 * QIDO-RS: Query for studies
 */
export async function qidoSearchStudies(params: {
  patientName?: string;
  patientId?: string;
  studyDate?: string;
  modality?: string;
  accessionNumber?: string;
}): Promise<any[]> {
  const queryParams = new URLSearchParams();
  if (params.patientName) queryParams.set("PatientName", params.patientName);
  if (params.patientId) queryParams.set("PatientID", params.patientId);
  if (params.studyDate) queryParams.set("StudyDate", params.studyDate);
  if (params.modality) queryParams.set("ModalitiesInStudy", params.modality);
  if (params.accessionNumber)
    queryParams.set("AccessionNumber", params.accessionNumber);

  const res = await orthancFetch(
    `/dicom-web/studies?${queryParams.toString()}`,
    {
      headers: { Accept: "application/dicom+json" },
    }
  );

  if (!res.ok) {
    throw new Error(`QIDO-RS query failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * QIDO-RS: Query for series within a study
 */
export async function qidoSearchSeries(
  studyInstanceUID: string
): Promise<any[]> {
  const res = await orthancFetch(
    `/dicom-web/studies/${studyInstanceUID}/series`,
    {
      headers: { Accept: "application/dicom+json" },
    }
  );

  if (!res.ok) {
    throw new Error(`QIDO-RS series query failed: ${res.status}`);
  }

  return res.json();
}

/**
 * WADO-RS: Retrieve study metadata
 */
export async function wadoGetStudyMetadata(
  studyInstanceUID: string
): Promise<any[]> {
  const res = await orthancFetch(
    `/dicom-web/studies/${studyInstanceUID}/metadata`,
    {
      headers: { Accept: "application/dicom+json" },
    }
  );

  if (!res.ok) {
    throw new Error(`WADO-RS metadata failed: ${res.status}`);
  }

  return res.json();
}

/**
 * WADO-RS: Retrieve instance (DICOM file)
 */
export async function wadoGetInstance(
  studyInstanceUID: string,
  seriesInstanceUID: string,
  sopInstanceUID: string
): Promise<ArrayBuffer> {
  const res = await orthancFetch(
    `/dicom-web/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}`,
    { headers: { Accept: "application/dicom" } }
  );

  if (!res.ok) {
    throw new Error(`WADO-RS instance retrieval failed: ${res.status}`);
  }

  return res.arrayBuffer();
}

/**
 * STOW-RS: Store DICOM instances
 */
export async function stowStore(
  studyInstanceUID: string,
  dicomBuffer: Buffer
): Promise<any> {
  const boundary = "----DicomBoundary" + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`),
    dicomBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await orthancFetch(`/dicom-web/studies/${studyInstanceUID}`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`STOW-RS store failed: ${res.status}`);
  }

  return res.json();
}

/**
 * C-FIND via Orthanc REST API (modality worklist query)
 */
export async function cFind(params: {
  aet: string;
  level: "Study" | "Series" | "Instance";
  query: Record<string, string>;
}): Promise<any[]> {
  // Use Orthanc's REST API to perform C-FIND
  const res = await orthancFetch(
    `/modalities/${safeAeTitle(params.aet)}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        Level: params.level,
        Query: params.query,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`C-FIND failed: ${res.status} ${res.statusText}`);
  }

  const queryResult = await res.json();
  const queryId = queryResult.ID;

  // Get answers
  const answersRes = await orthancFetch(`/queries/${queryId}/answers`);
  if (!answersRes.ok) {
    throw new Error(`C-FIND answers retrieval failed: ${answersRes.status}`);
  }

  const answerIds = await answersRes.json();
  const results: any[] = [];

  for (const answerId of answerIds) {
    const answerRes = await orthancFetch(
      `/queries/${queryId}/answers/${answerId}/content`
    );
    if (answerRes.ok) {
      results.push(await answerRes.json());
    }
  }

  return results;
}

/**
 * C-MOVE via Orthanc REST API (retrieve study to local AET)
 */
export async function cMove(params: {
  sourceAet: string;
  targetAet: string;
  studyInstanceUID: string;
}): Promise<{ success: boolean; message: string }> {
  // First query to find the study
  const queryRes = await orthancFetch(
    `/modalities/${safeAeTitle(params.sourceAet)}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        Level: "Study",
        Query: { StudyInstanceUID: params.studyInstanceUID },
      }),
    }
  );

  if (!queryRes.ok) {
    return { success: false, message: `Query failed: ${queryRes.status}` };
  }

  const queryResult = await queryRes.json();
  const queryId = queryResult.ID;

  // Retrieve all answers
  const retrieveRes = await orthancFetch(`/queries/${queryId}/retrieve`, {
    method: "POST",
    body: JSON.stringify({ TargetAet: params.targetAet }),
  });

  if (!retrieveRes.ok) {
    return { success: false, message: `C-MOVE failed: ${retrieveRes.status}` };
  }

  return { success: true, message: "Study retrieved successfully" };
}

/**
 * C-STORE: Send DICOM to remote modality
 */
export async function cStore(params: {
  targetAet: string;
  orthancId: string;
}): Promise<{ success: boolean; message: string }> {
  const res = await orthancFetch(
    `/modalities/${safeAeTitle(params.targetAet)}/store`,
    {
      method: "POST",
      body: JSON.stringify({ Resources: [params.orthancId] }),
    }
  );

  if (!res.ok) {
    return { success: false, message: `C-STORE failed: ${res.status}` };
  }

  return { success: true, message: "Instance stored successfully" };
}

/**
 * Resolve a StudyInstanceUID to Orthanc's internal resource ID.
 * Returns null when the study is unknown to Orthanc.
 */
export async function lookupStudyOrthancId(
  studyInstanceUID: string
): Promise<string | null> {
  const res = await orthancFetch("/tools/lookup", {
    method: "POST",
    body: studyInstanceUID,
  });
  if (!res.ok) return null;
  const results: Array<{ Type: string; ID: string }> = await res.json();
  const study = results.find(r => r.Type === "Study");
  return study?.ID ?? null;
}

/**
 * C-STORE a whole study (by StudyInstanceUID) to a remote modality.
 * Resolves the Orthanc resource ID first, then stores.
 */
export async function cStoreStudy(params: {
  targetAet: string;
  studyInstanceUID: string;
}): Promise<{ success: boolean; message: string }> {
  const orthancId = await lookupStudyOrthancId(params.studyInstanceUID);
  if (!orthancId) {
    return { success: false, message: "Study not found on Orthanc" };
  }
  return cStore({ targetAet: params.targetAet, orthancId });
}

/**
 * Modality Worklist (MWL) query via Orthanc's REST API.
 *
 * Orthanc forwards a C-FIND to a remote MWL SCP through
 * `POST /modalities/{id}/find-worklist` (available when the queried modality is
 * configured and Orthanc supports worklist relaying). The body is an
 * `{ Query: {...} }` of DICOM tags at the worklist level; the response is an
 * array of DICOM-JSON answers.
 *
 * FAIL-SOFT by contract: a demo PACS often has NO worklist configured. Any
 * non-OK status or transport error resolves to `{ available: false, ... }`
 * rather than throwing, so the UI can show "Worklist indisponible" without the
 * viewer breaking. Reuses safeAeTitle to block path traversal / SSRF.
 */
export async function findWorklist(params: {
  aet: string;
  query?: Record<string, string>;
}): Promise<{
  available: boolean;
  answers: any[];
  error?: string;
}> {
  // Scheduled Procedure Step Sequence (0040,0100) carries the per-step fields
  // (modality, scheduled date/time, description). We send it as an empty SQ to
  // request those tags back, alongside top-level patient/accession matchers.
  const query: Record<string, unknown> = {
    PatientName: "",
    PatientID: "",
    AccessionNumber: "",
    "0040,0100": [
      {
        Modality: "",
        ScheduledProcedureStepStartDate: "",
        ScheduledProcedureStepStartTime: "",
        ScheduledProcedureStepDescription: "",
        ScheduledStationAETitle: "",
      },
    ],
    ...(params.query ?? {}),
  };

  try {
    const res = await orthancFetch(
      `/modalities/${safeAeTitle(params.aet)}/find-worklist`,
      {
        method: "POST",
        body: JSON.stringify({ Query: query, Short: false }),
      }
    );
    if (!res.ok) {
      // 404 typically means the worklist endpoint / modality isn't configured.
      return {
        available: false,
        answers: [],
        error: `HTTP ${res.status}`,
      };
    }
    const answers = await res.json();
    return { available: true, answers: Array.isArray(answers) ? answers : [] };
  } catch (err: any) {
    return {
      available: false,
      answers: [],
      error: err?.message || "Worklist query failed",
    };
  }
}

/**
 * List configured modalities in Orthanc
 */
export async function listModalities(): Promise<string[]> {
  const res = await orthancFetch("/modalities");
  if (!res.ok) return [];
  return res.json();
}
