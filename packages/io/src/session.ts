import { z } from "zod";

/**
 * Session schema.
 *
 * A session is one recording plus everything needed to interpret it later. The
 * fields that look like bookkeeping are not: cube orientation and the measured
 * edge length are inputs to every angle the application computes, and a dataset
 * without them cannot be re-analysed once the hardware has moved on.
 */

export const ChannelCalibrationSchema = z.object({
  /** Linear gain correction, 1.0 meaning untouched. */
  gain: z.number().positive().default(1),
  /** Set when a microphone is wired out of phase. */
  invert: z.boolean().default(false),
  /**
   * Per-channel delay in samples. The firmware has no such correction, applying a
   * single global I2S_LSHIFT_LEFT to all six channels, so any residual offset
   * between the I2S pairs has to be measured and carried here.
   */
  delaySamples: z.number().default(0),
  enabled: z.boolean().default(true),
});
export type ChannelCalibration = z.infer<typeof ChannelCalibrationSchema>;

export const CubeGeometrySchema = z.object({
  /** Measured, not nominal. The plan settles on 384 mm as the default. */
  edgeMm: z.number().positive().default(384),
  /** Compass bearing that microphone 1 faces, degrees. */
  micOneBearingDeg: z.number().min(0).max(360).default(0),
  /** Tilt of the cube from vertical, if it was not level. */
  tiltDeg: z.number().default(0),
  channels: z.array(ChannelCalibrationSchema).length(6).optional(),
});
export type CubeGeometry = z.infer<typeof CubeGeometrySchema>;

export const EnvironmentSchema = z.object({
  tempC: z.number().default(15),
  humidityPct: z.number().min(0).max(100).default(60),
  pressurePa: z.number().positive().default(101325),
  windSpeedMps: z.number().min(0).optional(),
  windDirectionDeg: z.number().min(0).max(360).optional(),
  surface: z.string().optional(),
  ambientNote: z.string().optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const AudioFormatSchema = z.object({
  sampleRate: z.number().positive(),
  channels: z.number().int().positive(),
  bitsPerSample: z.number().int().positive(),
  /** As found in the file, so a non-canonical WAV is visible rather than guessed at. */
  encoding: z.enum(["pcm-int", "pcm-float", "unknown"]),
  frames: z.number().int().nonnegative(),
  durationSec: z.number().nonnegative(),
});
export type AudioFormat = z.infer<typeof AudioFormatSchema>;

export const StftSettingsSchema = z.object({
  fftSize: z.number().int().positive().default(4096),
  winLength: z.number().int().positive().optional(),
  hop: z.number().int().positive().default(1024),
  windowKind: z.number().int().min(0).max(4).default(1),
  beta: z.number().default(8.6),
});
export type StftSettings = z.infer<typeof StftSettingsSchema>;

export const BandSchema = z.object({
  id: z.string(),
  label: z.string(),
  loHz: z.number().nonnegative(),
  hiHz: z.number().positive(),
  colour: z.string().default("#1fbfa0"),
});
export type Band = z.infer<typeof BandSchema>;

/** One annotated event. Timestamps are seconds from the start of the recording. */
export const AnnotationSchema = z.object({
  id: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  label: z.string(),
  /** Free-form key/value tail, so conditions can be recorded without a schema change. */
  meta: z.record(z.string(), z.string()).default({}),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

export const DroneSchema = z.object({
  model: z.string().default("DJI Neo 2"),
  blades: z.number().int().positive().default(2),
  rotors: z.number().int().positive().default(4),
  /**
   * Whether the Dronetag Mini was fitted and where. It is 32 g on a 151 g machine,
   * so it shifts hover RPM by around 10 percent; a template built from a recording
   * that had it fitted describes a different aircraft unless the signature is
   * speed invariant.
   */
  ridModuleFitted: z.boolean().default(false),
  ridModuleLocation: z.string().optional(),
  propCondition: z.string().optional(),
});
export type Drone = z.infer<typeof DroneSchema>;

export const SessionSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** Wall-clock time of sample zero, from the TIME SYNC line, if there was one. */
  recordingStartedAt: z.string().optional(),
  notes: z.string().default(""),
  tags: z.array(z.string()).default([]),

  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("file"),
      fileName: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
    }),
    z.object({
      kind: z.literal("live"),
      deviceLabel: z.string(),
      backend: z.enum(["ffmpeg-avfoundation", "getusermedia"]),
    }),
    z.object({
      kind: z.literal("synthetic"),
      seed: z.number().int(),
      /** Kept verbatim so a fixture can be reproduced exactly. */
      params: z.record(z.string(), z.number()),
    }),
  ]),

  format: AudioFormatSchema,
  geometry: CubeGeometrySchema,
  environment: EnvironmentSchema,
  stft: StftSettingsSchema,
  bands: z.array(BandSchema).default([]),
  annotations: z.array(AnnotationSchema).default([]),
  drone: DroneSchema.optional(),

  /** Ground truth file that came with the recording, if any. */
  groundTruthFile: z.string().optional(),

  /** Commit and build identity of the app that produced any stored results. */
  producedBy: z
    .object({
      version: z.string(),
      commit: z.string(),
    })
    .optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export function parseSession(input: unknown): Session {
  return SessionSchema.parse(input);
}

/** Non-throwing variant for files that may predate a schema change. */
export function safeParseSession(input: unknown) {
  return SessionSchema.safeParse(input);
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
