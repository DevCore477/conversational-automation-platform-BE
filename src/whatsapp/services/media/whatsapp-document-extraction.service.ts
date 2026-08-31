import { Injectable, Logger } from '@nestjs/common';
import * as officeParser from 'officeparser';

const MAX_EXTRACTED_TEXT_CHARS = 200_000;

export interface DocumentExtractionResult {
  extractedText: string;
  pageCount: number | null;
}

const MIME_TO_FILETYPE: Record<string, 'pdf' | 'docx' | 'xlsx' | 'pptx'> = {
  'application/pdf': 'pdf',
  'application/msword': 'docx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const EXTENSION_TO_FILETYPE: Record<string, 'pdf' | 'docx' | 'xlsx' | 'pptx'> = {
  pdf: 'pdf',
  doc: 'docx',
  docx: 'docx',
  xls: 'xlsx',
  xlsx: 'xlsx',
  ppt: 'pptx',
  pptx: 'pptx',
};

/**
 * Extracts readable text from PDF/DOCX/XLSX/PPTX/TXT documents so it can be stored and
 * surfaced in AI conversation context. Plain text files are read directly; everything else
 * goes through `officeparser`, which covers all four office formats from one dependency.
 */
@Injectable()
export class WhatsAppDocumentExtractionService {
  private readonly logger = new Logger(WhatsAppDocumentExtractionService.name);

  isSupported(mimeType: string, filename?: string): boolean {
    return this.resolveFileType(mimeType, filename) !== null || this.isPlainText(mimeType, filename);
  }

  async extract(buffer: Buffer, mimeType: string, filename?: string): Promise<DocumentExtractionResult> {
    if (this.isPlainText(mimeType, filename)) {
      return { extractedText: this.cap(buffer.toString('utf-8')), pageCount: null };
    }

    const fileType = this.resolveFileType(mimeType, filename);
    if (!fileType) {
      throw new Error(`Unsupported document type: ${mimeType} (${filename ?? 'unknown filename'})`);
    }

    const ast = await officeParser.parseOffice(buffer, { fileType });
    const text = ast.toText();
    const pageCount = this.extractPageCount(ast);

    return { extractedText: this.cap(text), pageCount };
  }

  private extractPageCount(ast: unknown): number | null {
    const metadata = (ast as { metadata?: Record<string, unknown> })?.metadata;
    const pages = metadata?.pageCount ?? metadata?.pages ?? metadata?.slideCount;
    return typeof pages === 'number' ? pages : null;
  }

  private isPlainText(mimeType: string, filename?: string): boolean {
    return mimeType === 'text/plain' || /\.txt$/i.test(filename ?? '');
  }

  private resolveFileType(mimeType: string, filename?: string): 'pdf' | 'docx' | 'xlsx' | 'pptx' | null {
    if (MIME_TO_FILETYPE[mimeType]) {
      return MIME_TO_FILETYPE[mimeType];
    }
    const ext = filename?.split('.').pop()?.toLowerCase();
    if (ext && EXTENSION_TO_FILETYPE[ext]) {
      return EXTENSION_TO_FILETYPE[ext];
    }
    return null;
  }

  private cap(text: string): string {
    if (text.length <= MAX_EXTRACTED_TEXT_CHARS) {
      return text;
    }
    this.logger.warn(`Extracted text truncated from ${text.length} to ${MAX_EXTRACTED_TEXT_CHARS} chars`);
    return text.slice(0, MAX_EXTRACTED_TEXT_CHARS);
  }
}
