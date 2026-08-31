import { WhatsAppVideoProcessingService } from './whatsapp-video-processing.service';

/**
 * Regression coverage: `whatsapp_message_media.durationSeconds` is a Postgres `int` column, but
 * ffmpeg's codecData duration ("HH:MM:SS.ms") frequently parses to a fractional value like 2.8s
 * (e.g. "00:00:02.800"). Writing that straight to the DB failed with
 * "invalid input syntax for type integer: 2.8" and crashed video processing entirely.
 */
describe('WhatsAppVideoProcessingService — duration rounding', () => {
  const service = new WhatsAppVideoProcessingService();

  function roundDuration(duration: number | null): number | null {
    return (service as unknown as { roundDuration: (d: number | null) => number | null }).roundDuration(
      duration,
    );
  }

  it('rounds a fractional duration to the nearest whole second', () => {
    expect(roundDuration(2.8)).toBe(3);
    expect(roundDuration(2.2)).toBe(2);
  });

  it('returns an integer unchanged', () => {
    expect(roundDuration(5)).toBe(5);
  });

  it('passes through null', () => {
    expect(roundDuration(null)).toBeNull();
  });

  it('always returns a value with no fractional part', () => {
    for (const input of [0.1, 1.49, 1.5, 59.999, 120.0001]) {
      const result = roundDuration(input);
      expect(result).not.toBeNull();
      expect(Number.isInteger(result)).toBe(true);
    }
  });
});
