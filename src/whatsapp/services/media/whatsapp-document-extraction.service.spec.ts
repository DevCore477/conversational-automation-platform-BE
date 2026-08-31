import { WhatsAppDocumentExtractionService } from './whatsapp-document-extraction.service';

describe('WhatsAppDocumentExtractionService', () => {
  let service: WhatsAppDocumentExtractionService;

  beforeEach(() => {
    service = new WhatsAppDocumentExtractionService();
  });

  describe('isSupported', () => {
    it('supports plain text by mime type', () => {
      expect(service.isSupported('text/plain')).toBe(true);
    });

    it('supports plain text by extension when mime type is generic', () => {
      expect(service.isSupported('application/octet-stream', 'notes.txt')).toBe(true);
    });

    it('supports PDF by mime type', () => {
      expect(service.isSupported('application/pdf')).toBe(true);
    });

    it('supports DOCX by mime type', () => {
      expect(
        service.isSupported(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ).toBe(true);
    });

    it('supports XLSX/PPTX by file extension when mime type is unhelpful', () => {
      expect(service.isSupported('application/octet-stream', 'report.xlsx')).toBe(true);
      expect(service.isSupported('application/octet-stream', 'deck.pptx')).toBe(true);
    });

    it('rejects unsupported types', () => {
      expect(service.isSupported('application/zip', 'archive.zip')).toBe(false);
    });
  });

  describe('extract', () => {
    it('reads plain text files directly without officeparser', async () => {
      const buffer = Buffer.from('Hello world\nSecond line', 'utf-8');
      const result = await service.extract(buffer, 'text/plain', 'notes.txt');
      expect(result).toEqual({ extractedText: 'Hello world\nSecond line', pageCount: null });
    });

    it('throws for an unsupported document type', async () => {
      const buffer = Buffer.from('PK\x03\x04', 'binary');
      await expect(service.extract(buffer, 'application/zip', 'archive.zip')).rejects.toThrow(
        /Unsupported document type/,
      );
    });

    it('truncates extracted text beyond the cap', async () => {
      const longText = 'a'.repeat(250_000);
      const buffer = Buffer.from(longText, 'utf-8');
      const result = await service.extract(buffer, 'text/plain', 'big.txt');
      expect(result.extractedText.length).toBe(200_000);
    });
  });
});
