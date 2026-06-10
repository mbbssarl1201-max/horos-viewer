import { describe, expect, it, vi, beforeEach } from "vitest";

// Capture what the S3 client is asked to do without touching a real bucket.
const sendMock = vi.fn();
vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = sendMock;
  }
  class PutObjectCommand {
    constructor(public input: unknown) {}
  }
  class GetObjectCommand {
    constructor(public input: unknown) {}
  }
  class DeleteObjectCommand {
    constructor(public input: unknown) {}
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));

// storage.ts snapshots S3 config from process.env (via _core/env) at import,
// so the credentials must exist before the dynamic import below.
process.env.S3_ENDPOINT = "http://minio:9000";
process.env.S3_ACCESS_KEY = "test-access";
process.env.S3_SECRET_KEY = "test-secret";
process.env.S3_BUCKET = "horos-dicom";

const { storageDelete } = await import("./storage");
const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");

describe("storageDelete", () => {
  beforeEach(() => sendMock.mockReset());

  it("issues a DeleteObjectCommand for the normalized key on the configured bucket", async () => {
    await storageDelete("/dicom/3/3/3/scan_abcd1234.dcm");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({
      Bucket: "horos-dicom",
      Key: "dicom/3/3/3/scan_abcd1234.dcm", // leading slash stripped
    });
  });

  it("is a no-op for an empty key (nothing to delete)", async () => {
    await storageDelete("");
    expect(sendMock).not.toHaveBeenCalled();
  });
});

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
