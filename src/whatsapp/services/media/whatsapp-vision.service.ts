import { Injectable, Logger } from '@nestjs/common';

import { OpenAIClient } from '../../../clients/openai/openai.client';

export interface ImageAnalysis {
  description: string;
  ocrText: string;
  objects: string[];
  entities: string[];
  summary: string;
}

/** Thin, testable wrapper around the vision-capable chat model for image/video-frame understanding. */
@Injectable()
export class WhatsAppVisionService {
  private readonly logger = new Logger(WhatsAppVisionService.name);

  constructor(private readonly openaiClient: OpenAIClient) {}

  async analyzeImage(buffer: Buffer, mimeType: string, caption?: string): Promise<ImageAnalysis> {
    try {
      return await this.openaiClient.analyzeImage(buffer, mimeType, caption);
    } catch (err) {
      this.logger.error(`Vision analysis failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Merge multiple per-frame analyses (from a video) into one scene summary + description. */
  mergeFrameAnalyses(analyses: ImageAnalysis[]): {
    description: string;
    sceneSummary: string;
    objects: string[];
    entities: string[];
  } {
    const description = analyses
      .map((a, i) => `Frame ${i + 1}: ${a.description}`)
      .join('\n');
    const sceneSummary = analyses.map(a => a.summary).filter(Boolean).join(' ');
    const objects = [...new Set(analyses.flatMap(a => a.objects))];
    const entities = [...new Set(analyses.flatMap(a => a.entities))];
    return { description, sceneSummary, objects, entities };
  }
}
