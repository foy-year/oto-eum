/**
 * Blob storage for uploaded media. LocalDiskStorage works on any VPS / Docker
 * volume; an S3/R2 implementation can be added behind the same interface.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class TooLargeError extends Error {}

export interface StoredBlob {
  size: number;
  sha256: string;
  /** First bytes, for content sniffing. */
  head: Uint8Array;
}

export interface BlobStorage {
  put(key: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<StoredBlob>;
  /** Web stream of [start, end] inclusive (or the whole file). */
  get(key: string, range?: { start: number; end: number }): ReadableStream<Uint8Array>;
  size(key: string): Promise<number>;
  delete(key: string): Promise<void>;
}

export class LocalDiskStorage implements BlobStorage {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'blobs');
  }

  private path(key: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('bad key');
    return join(this.dir, key.slice(0, 2), key);
  }

  async put(key: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<StoredBlob> {
    const final = this.path(key);
    await mkdir(join(this.dir, key.slice(0, 2)), { recursive: true });
    const tmp = `${final}.${randomBytes(4).toString('hex')}.part`;
    const hash = createHash('sha256');
    let size = 0;
    const headChunks: Buffer[] = [];
    let headLen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new TooLargeError(`File exceeds ${Math.round(maxBytes / 1048576)} MB`));
        if (headLen < 64) {
          headChunks.push(chunk.subarray(0, 64 - headLen));
          headLen += Math.min(chunk.length, 64 - headLen);
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body as never), meter, createWriteStream(tmp));
      await rename(tmp, final);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return { size, sha256: hash.digest('hex'), head: new Uint8Array(Buffer.concat(headChunks)) };
  }

  get(key: string, range?: { start: number; end: number }) {
    return Readable.toWeb(createReadStream(this.path(key), range)) as ReadableStream<Uint8Array>;
  }

  async size(key: string) {
    return (await stat(this.path(key))).size;
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}
