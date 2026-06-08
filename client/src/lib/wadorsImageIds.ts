export interface InstanceMetadata {
  [tag: string]: { Value?: unknown[] } | undefined;
}

export interface WadorsContext {
  root: string; // ex. "/api/dicomweb"
  studyUid: string;
  seriesUid: string;
}

const SOP_INSTANCE_UID = "00080018";
const NUMBER_OF_FRAMES = "00280008";

/** Construit la liste des imageIds wadors (un par frame) depuis la metadata WADO-RS. */
export function deriveWadorsImageIds(
  metadata: InstanceMetadata[],
  { root, studyUid, seriesUid }: WadorsContext
): string[] {
  const ids: string[] = [];
  for (const inst of metadata) {
    const sop = inst?.[SOP_INSTANCE_UID]?.Value?.[0] as string | undefined;
    if (!sop) continue;
    const frames = Number(inst?.[NUMBER_OF_FRAMES]?.Value?.[0] ?? 1) || 1;
    for (let f = 1; f <= frames; f++) {
      ids.push(
        `wadors:${root}/studies/${studyUid}/series/${seriesUid}/instances/${sop}/frames/${f}`
      );
    }
  }
  return ids;
}
