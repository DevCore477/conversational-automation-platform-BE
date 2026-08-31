import {
  inferMetaMediaType,
  mimeTypeForMedia,
  shouldUploadMediaViaApi,
} from './meta-media.util';

describe('meta-media.util', () => {
  const elevenLabsMp3 =
    'https://storage.googleapis.com/eleven-public-prod/premade/voices/CwhRBWXzGAHq8TQ4Fs17/58ee3ff5-f6f2-4628-93b8-e38eb31806b0.mp3';

  it('detects mp3 as audio', () => {
    expect(inferMetaMediaType(elevenLabsMp3)).toBe('audio');
    expect(mimeTypeForMedia('audio', elevenLabsMp3)).toBe('audio/mpeg');
  });

  it('requires Media API upload for audio', () => {
    expect(shouldUploadMediaViaApi('audio')).toBe(true);
    expect(shouldUploadMediaViaApi('image')).toBe(false);
  });
});
