// dcmjs ships no type declarations. Minimal ambient types for the subset of
// the API we use to anonymize DICOM buffers (see server/routers.ts).
declare module "dcmjs" {
  interface DicomDictInstance {
    dict: Record<string, { vr?: string; Value?: any[] }>;
    meta: Record<string, any>;
    write(): ArrayBuffer;
  }

  interface DicomDictConstructor {
    new (meta?: Record<string, any>): DicomDictInstance;
  }

  const dcmjs: {
    data: {
      DicomMessage: {
        readFile(
          buffer: ArrayBuffer,
          options?: { ignoreErrors?: boolean }
        ): DicomDictInstance;
      };
      DicomDict: DicomDictConstructor;
      DicomMetaDictionary: {
        denaturalizeDataset(dataset: Record<string, any>): Record<string, any>;
        naturalizeDataset(dict: Record<string, any>): Record<string, any>;
      };
    };
    [key: string]: any;
  };

  export default dcmjs;
}
