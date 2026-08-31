import { Injectable, Logger } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStaticPath from 'ffmpeg-static';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

if (ffmpegStaticPath) {
  ffmpeg.setFfmpegPath(ffmpegStaticPath);
}

export interface VideoFrame {
  buffer: Buffer;
  atSeconds: number;
}

export interface VideoProcessingResult {
  durationSeconds: number | null;
  frames: VideoFrame[];
  audioBuffer: Buffer | null;
  skippedTooLong: boolean;
}

const FRAME_COUNT = 3;
const FALLBACK_TIMESTAMPS = [0, 2, 4];

/**
 * Extracts representative frames (for vision analysis) and the audio track (for transcription)
 * from an inbound video, using the bundled `ffmpeg-static` binary via `fluent-ffmpeg`.
 * Deliberately avoids requiring a separate `ffprobe` binary: duration is read from ffmpeg's own
 * stderr `codecData` banner emitted during the first frame extraction.
 */
@Injectable()
export class WhatsAppVideoProcessingService {
  private readonly logger = new Logger(WhatsAppVideoProcessingService.name);

  async process(videoBuffer: Buffer, maxDurationSeconds: number): Promise<VideoProcessingResult> {
    const workDir = await mkdtemp(join(tmpdir(), 'wa-video-'));
    const inputPath = join(workDir, 'input');
    try {
      await writeFile(inputPath, videoBuffer);

      const { duration, hasAudio } = await this.probeViaCodecData(inputPath, workDir);

      if (duration != null && duration > maxDurationSeconds) {
        this.logger.warn(`Video duration ${duration}s exceeds max ${maxDurationSeconds}s — skipping frame/audio extraction`);
        return {
          durationSeconds: this.roundDuration(duration),
          frames: [],
          audioBuffer: null,
          skippedTooLong: true,
        };
      }

      // Keep the unrounded `duration` for frame-timestamp math (buildTimestamps) — only the
      // value returned for persistence needs rounding (`durationSeconds` is a Postgres int column;
      // fractional seconds like "2.8" from ffmpeg's HH:MM:SS.ms banner fail the write outright).
      const timestamps = this.buildTimestamps(duration);
      const frames = await this.extractFrames(inputPath, workDir, timestamps);
      const audioBuffer = hasAudio ? await this.extractAudio(inputPath, workDir) : null;

      return {
        durationSeconds: this.roundDuration(duration),
        frames,
        audioBuffer,
        skippedTooLong: false,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private roundDuration(duration: number | null): number | null {
    return duration != null ? Math.round(duration) : null;
  }

  private buildTimestamps(duration: number | null): number[] {
    if (!duration || duration <= 0) {
      return FALLBACK_TIMESTAMPS;
    }
    const step = duration / (FRAME_COUNT + 1);
    return Array.from({ length: FRAME_COUNT }, (_, i) => Math.min(duration - 0.1, step * (i + 1)));
  }

  private probeViaCodecData(
    inputPath: string,
    workDir: string,
  ): Promise<{ duration: number | null; hasAudio: boolean }> {
    return new Promise(resolve => {
      let duration: number | null = null;
      let hasAudio = false;
      let settled = false;

      const finish = () => {
        if (!settled) {
          settled = true;
          resolve({ duration, hasAudio });
        }
      };

      ffmpeg(inputPath)
        .on('codecData', data => {
          hasAudio = Boolean(data.audio && data.audio !== 'none');
          duration = this.parseDuration(data.duration);
        })
        .on('end', finish)
        .on('error', err => {
          this.logger.debug(`Video probe frame extraction error (non-fatal): ${err.message}`);
          finish();
        })
        // Numeric timestamps (not percentages) skip fluent-ffmpeg's internal ffprobe call —
        // duration/audio come from the `codecData` event parsed off ffmpeg's own stderr banner.
        .screenshots({ timestamps: [0], filename: 'probe.jpg', folder: workDir });
    });
  }

  private parseDuration(raw: string | undefined): number | null {
    if (!raw) {
      return null;
    }
    const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(raw.trim());
    if (!match) {
      return null;
    }
    const [, h, m, s] = match;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }

  private async extractFrames(
    inputPath: string,
    workDir: string,
    timestamps: number[],
  ): Promise<VideoFrame[]> {
    const frames: VideoFrame[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const outPath = join(workDir, `frame-${i}.jpg`);
      try {
        await this.extractSingleFrame(inputPath, outPath, ts);
        frames.push({ buffer: await readFile(outPath), atSeconds: ts });
      } catch (err) {
        this.logger.debug(`Skipping frame at ${ts}s: ${(err as Error).message}`);
      }
    }
    return frames;
  }

  private extractSingleFrame(inputPath: string, outPath: string, atSeconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .seekInput(Math.max(0, atSeconds))
        .frames(1)
        .output(outPath)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });
  }

  private async extractAudio(inputPath: string, workDir: string): Promise<Buffer | null> {
    const outPath = join(workDir, 'audio.mp3');
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .noVideo()
          .audioCodec('libmp3lame')
          .output(outPath)
          .on('end', () => resolve())
          .on('error', reject)
          .run();
      });
      return await readFile(outPath);
    } catch (err) {
      this.logger.debug(`No audio track extracted from video: ${(err as Error).message}`);
      return null;
    }
  }
}
