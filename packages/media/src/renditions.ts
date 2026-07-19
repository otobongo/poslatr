import sharp from 'sharp';

// Rendition pipeline. v0.1 handles images via sharp; video is defined behind an
// interface with a not-yet-implemented renditioner so the seam is ready without
// pulling ffmpeg in now (PRD ISS-006).

export interface RenditionSpec {
  name: string;
  maxWidth: number;
  maxHeight: number;
  /** Output mime; only image/* supported in v0.1. */
  format: 'image/webp' | 'image/jpeg' | 'image/png';
}

export interface RenditionOutput {
  name: string;
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

export interface Renditioner {
  render(source: Uint8Array, spec: RenditionSpec): Promise<RenditionOutput>;
}

const FORMAT_METHOD = {
  'image/webp': 'webp',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
} as const;

export class ImageRenditioner implements Renditioner {
  async render(source: Uint8Array, spec: RenditionSpec): Promise<RenditionOutput> {
    const method = FORMAT_METHOD[spec.format];
    const pipeline = sharp(source)
      .rotate() // honor EXIF orientation, then strip metadata on output
      .resize({
        width: spec.maxWidth,
        height: spec.maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      });

    const output = await pipeline[method]().toBuffer({ resolveWithObject: true });
    return {
      name: spec.name,
      bytes: new Uint8Array(output.data),
      mime: spec.format,
      width: output.info.width,
      height: output.info.height,
    };
  }
}

export class VideoRenditionerNotImplemented implements Renditioner {
  render(_source: Uint8Array, _spec: RenditionSpec): Promise<RenditionOutput> {
    // The interface is ready; the ffmpeg-backed implementation arrives with
    // video support in a later version (PRD ISS-006: "interface ready").
    return Promise.reject(new Error('video renditions are not supported in v0.1'));
  }
}

export async function probeImage(
  source: Uint8Array,
): Promise<{ width: number; height: number; format: string }> {
  const meta = await sharp(source).metadata();
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    format: meta.format ?? 'unknown',
  };
}
