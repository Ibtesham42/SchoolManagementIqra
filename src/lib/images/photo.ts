import { ValidationError } from "@/lib/errors";

/**
 * Server-side student photo processing with sharp 0.35.5 (owner decision D7). Every photo is decoded and
 * RE-ENCODED: only fresh pixels are stored, so EXIF (incl. GPS location), XMP, IPTC, ICC profiles,
 * comments and anything appended to the file are dropped. Orientation is applied first (phone photos
 * stay upright), then a centre square crop to 600×600 JPEG.
 *
 * Fail closed: if sharp can't be loaded or the image can't be decoded, a ValidationError is thrown and the
 * caller stores NOTHING — an unprocessed photo is never kept.
 *
 * Runs OUTSIDE database transactions (CPU work; backend rule). Inputs are JPEG/PNG already accepted by
 * magic-byte detection; decoding limits bound memory on a small server.
 */
export const PHOTO_SIZE = 600;
/** ~36 megapixels (e.g. 6000×6000): enough for any phone camera, bounded decode memory. */
export const PHOTO_MAX_INPUT_PIXELS = 36_000_000;
const PHOTO_QUALITY = 85;

export interface ProcessedPhoto {
  bytes: Buffer;
  width: number;
  height: number;
  mimeType: "image/jpeg";
}

/** The sharp function itself (the package is CommonJS: its namespace exposes it as `default`). */
type SharpModule = typeof import("sharp") extends { default: infer D } ? D : typeof import("sharp");
let sharpPromise: Promise<SharpModule> | null = null;

/** Loaded lazily so a missing/broken native binary fails the photo upload, not the whole app. */
async function loadSharp(): Promise<SharpModule> {
  sharpPromise ??= import("sharp").then((m) => {
    const sharp = (m as unknown as { default?: SharpModule }).default ?? (m as unknown as SharpModule);
    sharp.concurrency(1); // one libvips thread per operation: predictable memory on small hosts
    sharp.cache(false); // no decoded-image cache between requests
    return sharp;
  });
  try {
    return await sharpPromise;
  } catch {
    sharpPromise = null;
    throw new ValidationError("Photo processing is unavailable on this server, so the photo was not saved.", [{ path: "file", message: "Photo processing unavailable." }]);
  }
}

export async function processStudentPhoto(input: Uint8Array): Promise<ProcessedPhoto> {
  const sharp = await loadSharp();
  try {
    const image = sharp(input, { limitInputPixels: PHOTO_MAX_INPUT_PIXELS, failOn: "error", sequentialRead: true });
    const meta = await image.metadata();
    if (meta.format !== "jpeg" && meta.format !== "png") throw new Error("unsupported format");
    const { data, info } = await image
      .rotate() // apply EXIF orientation before the metadata is discarded
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: "cover", position: "centre" })
      .flatten({ background: "#ffffff" }) // transparent PNGs → white, JPEG has no alpha
      .jpeg({ quality: PHOTO_QUALITY, mozjpeg: true, chromaSubsampling: "4:2:0" })
      .toBuffer({ resolveWithObject: true }); // no .withMetadata()/.keepMetadata(): all metadata dropped
    return { bytes: data, width: info.width, height: info.height, mimeType: "image/jpeg" };
  } catch {
    throw new ValidationError("This photo couldn't be processed. Use a clear JPEG or PNG image.", [{ path: "file", message: "Unreadable or too large image." }]);
  }
}

/**
 * KI-068 (owner decision 2026-11-18): document images (JPEG/PNG uploaded as a document, not as the photo) are
 * re-saved WITHOUT metadata — EXIF (incl. GPS location of a phone scan), XMP, IPTC, comments and appended data
 * are dropped. Same pixels and resolution (no resize, no crop); orientation applied so scans stay upright; same
 * format (JPEG stays JPEG at high quality, PNG stays lossless PNG). Fail closed like photos: if the image can't be
 * decoded, nothing is stored.
 */
export async function stripDocumentImageMetadata(input: Uint8Array, format: "image/jpeg" | "image/png"): Promise<Buffer> {
  const sharp = await loadSharp();
  try {
    const image = sharp(input, { limitInputPixels: PHOTO_MAX_INPUT_PIXELS, failOn: "error", sequentialRead: true }).rotate();
    return format === "image/jpeg" ? await image.jpeg({ quality: 92, mozjpeg: true }).toBuffer() : await image.png({ compressionLevel: 9 }).toBuffer();
  } catch {
    throw new ValidationError("This image couldn't be processed. Use a clear JPEG or PNG, or a PDF.", [{ path: "file", message: "Unreadable or too large image." }]);
  }
}
