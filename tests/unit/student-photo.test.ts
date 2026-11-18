import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { PHOTO_MAX_INPUT_PIXELS, PHOTO_SIZE, processStudentPhoto } from "@/lib/images/photo";
import { detectFileType } from "@/lib/storage/file-types";

/**
 * D7 — server-side photo re-encoding with the real sharp 0.35.5 (a library, not mocked). Synthetic images
 * only. Proves: metadata (EXIF incl. GPS, XMP, comments) is gone, orientation is applied, appended data is
 * dropped, oversized and non-image inputs are refused (→ the caller stores nothing).
 */
const MARKER = "synthetic-exif-marker-0042";

async function jpegWithMetadata() {
  return sharp({ create: { width: 900, height: 500, channels: 3, background: "#2266aa" } })
    .withExif({ IFD0: { Copyright: MARKER, ImageDescription: MARKER }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "28/1 36/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "77/1 12/1 0/1" } })
    .withXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description>${MARKER}</rdf:Description></rdf:RDF></x:xmpmeta>`)
    .jpeg()
    .toBuffer();
}

/** Minimal PNG whose header claims width × height (no real pixel data needed: sharp checks the header). */
function pngHeaderOnly(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(16))), chunk("IEND", Buffer.alloc(0))]);
}

describe("processStudentPhoto (sharp 0.35.5)", () => {
  it("the input really carries EXIF + GPS + XMP (test precondition)", async () => {
    const input = await jpegWithMetadata();
    const meta = await sharp(input).metadata();
    expect(meta.exif?.length).toBeGreaterThan(0);
    expect(meta.xmp?.length).toBeGreaterThan(0);
    expect(input.includes(Buffer.from(MARKER))).toBe(true);
  });

  it("re-encodes to a 600×600 JPEG with NO metadata (EXIF, GPS, XMP, ICC) and no trace of the marker", async () => {
    const out = await processStudentPhoto(await jpegWithMetadata());
    expect([out.mimeType, out.width, out.height]).toEqual(["image/jpeg", PHOTO_SIZE, PHOTO_SIZE]);
    expect(detectFileType(out.bytes)).toBe("image/jpeg");
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(out.bytes.includes(Buffer.from(MARKER))).toBe(false);
    expect(out.bytes.includes(Buffer.from("GPS"))).toBe(false);
    expect(out.bytes.length).toBeLessThan(200 * 1024);
  });

  it("applies EXIF orientation before discarding it (phone photos stay upright)", async () => {
    // Stored 400×200: left half red, right half blue. Orientation 6 = display rotated 90° clockwise,
    // so the displayed image is portrait with red on TOP and blue at the BOTTOM.
    const halves = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#0000ff" } })
      .composite([{ input: { create: { width: 200, height: 200, channels: 3, background: "#ff0000" } }, left: 0, top: 0 }])
      .jpeg()
      .toBuffer();
    const rotated = await sharp(halves).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect((await sharp(rotated).metadata()).orientation).toBe(6);
    const out = await processStudentPhoto(rotated);
    const { data, info } = await sharp(out.bytes).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    const [rt, , bt] = px(300, 60); // top centre
    const [rb, , bb] = px(300, 540); // bottom centre
    expect(rt).toBeGreaterThan(200);
    expect(bt).toBeLessThan(60); // red on top
    expect(bb).toBeGreaterThan(200);
    expect(rb).toBeLessThan(60); // blue at the bottom
  });

  it("drops anything appended after the image (polyglot / hidden payload)", async () => {
    const payload = Buffer.from(`PK\u0003\u0004<script>alert(1)</script>${MARKER}`);
    const polyglot = Buffer.concat([await jpegWithMetadata(), payload]);
    const out = await processStudentPhoto(polyglot);
    expect(out.bytes.includes(Buffer.from("<script>"))).toBe(false);
    expect(out.bytes.includes(Buffer.from(MARKER))).toBe(false);
  });

  it("flattens transparent PNGs onto white and outputs JPEG", async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out = await processStudentPhoto(png);
    const { data } = await sharp(out.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(Array.from(data.subarray(0, 3)).every((v) => v > 240)).toBe(true);
    expect(detectFileType(out.bytes)).toBe("image/jpeg");
  });

  it("refuses an image whose header claims more than the pixel limit — without decoding it", async () => {
    const side = Math.ceil(Math.sqrt(PHOTO_MAX_INPUT_PIXELS)) + 100;
    await expect(processStudentPhoto(pngHeaderOnly(side, side))).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ["random bytes", Buffer.from("definitely not an image")],
    ["truncated JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
    ["a PDF", Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF")],
  ])("refuses %s with a ValidationError (nothing would be stored)", async (_l, bytes) => {
    await expect(processStudentPhoto(bytes)).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses formats other than JPEG/PNG even if sharp could read them (WebP, GIF)", async () => {
    const webp = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#00ff00" } }).webp().toBuffer();
    const gif = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#00ff00" } }).gif().toBuffer();
    await expect(processStudentPhoto(webp)).rejects.toBeInstanceOf(ValidationError);
    await expect(processStudentPhoto(gif)).rejects.toBeInstanceOf(ValidationError);
  });
});
