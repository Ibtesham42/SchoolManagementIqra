import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { stripDocumentImageMetadata } from "@/lib/images/photo";

/** KI-068 (owner decision 2026-11-18): document images lose all metadata but keep size, resolution and format. */
describe("stripDocumentImageMetadata", () => {
  it("JPEG: EXIF removed, same dimensions, still JPEG", async () => {
    const withExif = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#ffffff" } })
      .jpeg()
      .withExif({ IFD0: { Make: "SyntheticCam", Model: "Scan-1", ImageDescription: "synthetic location note" } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const out = await stripDocumentImageMetadata(withExif, "image/jpeg");
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 320, height: 200 });
    expect(meta.exif).toBeUndefined();
    expect(out.includes(Buffer.from("SyntheticCam"))).toBe(false);
  });

  it("PNG stays lossless PNG at the same size; text chunks are not kept", async () => {
    const png = await sharp({ create: { width: 50, height: 80, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
      .png()
      .withMetadata({ exif: { IFD0: { Copyright: "synthetic owner" } } })
      .toBuffer();
    const out = await stripDocumentImageMetadata(png, "image/png");
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: "png", width: 50, height: 80 });
    expect(meta.exif).toBeUndefined();
    expect(out.includes(Buffer.from("synthetic owner"))).toBe(false);
  });

  it("an undecodable image is refused (nothing stored)", async () => {
    await expect(stripDocumentImageMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]), "image/jpeg")).rejects.toBeInstanceOf(ValidationError);
  });
});
