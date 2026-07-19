import { z } from 'zod';

// The declarative heart of the plugin seam (PRD 3.2): the compose UI renders
// limits and the validator enforces them FROM THIS DECLARATION. Hardcoding a
// platform limit anywhere outside a provider's capability schema is a
// review-blocking defect.

export const contentTypeSchema = z.enum(['text', 'image', 'video', 'carousel']);
export type ContentType = z.infer<typeof contentTypeSchema>;

const mimeType = z
  .string()
  .regex(/^[a-z]+\/[a-z0-9][a-z0-9+.-]*$/i, 'must be a valid mime type like image/png');

export const rateWindowSchema = z.object({
  windowMs: z.number().int().positive(),
  maxRequests: z.number().int().positive(),
});

export const mediaConstraintsSchema = z.object({
  maxBytes: z.number().int().positive(),
  // Image-only platforms declare null; video constraints arrive with video
  // support.
  maxDurationMs: z.number().int().positive().nullable(),
  // Accepted width/height ratios as [width, height] pairs; empty = any.
  allowedAspectRatios: z.array(z.tuple([z.number().positive(), z.number().positive()])),
});

export const capabilitiesSchema = z.object({
  contentTypes: z.array(contentTypeSchema).nonempty(),
  maxCharacters: z.number().int().positive(),
  maxMediaCount: z.number().int().min(0),
  allowedMimeTypes: z.array(mimeType),
  mediaConstraints: mediaConstraintsSchema,
  rateWindows: z.array(rateWindowSchema),
});

export type Capabilities = z.infer<typeof capabilitiesSchema>;
