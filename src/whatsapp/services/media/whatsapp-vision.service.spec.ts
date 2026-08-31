import { WhatsAppVisionService } from './whatsapp-vision.service';

describe('WhatsAppVisionService.mergeFrameAnalyses', () => {
  const service = new WhatsAppVisionService({} as never);

  it('merges multiple frame analyses into one description and deduped object/entity lists', () => {
    const merged = service.mergeFrameAnalyses([
      { description: 'a cat on a couch', ocrText: '', objects: ['cat', 'couch'], entities: [], summary: 'A cat.' },
      { description: 'the same cat jumping', ocrText: '', objects: ['cat', 'table'], entities: ['Nike'], summary: 'Cat jumps.' },
    ]);

    expect(merged.description).toBe('Frame 1: a cat on a couch\nFrame 2: the same cat jumping');
    expect(merged.sceneSummary).toBe('A cat. Cat jumps.');
    expect(merged.objects).toEqual(['cat', 'couch', 'table']);
    expect(merged.entities).toEqual(['Nike']);
  });

  it('handles an empty list of analyses gracefully', () => {
    const merged = service.mergeFrameAnalyses([]);
    expect(merged).toEqual({ description: '', sceneSummary: '', objects: [], entities: [] });
  });
});
