import { registerAs } from '@nestjs/config';

export default registerAs('elevenlabs', () => ({
  apiKey: process.env.ELEVENLABS_API_KEY,
  agentId: process.env.ELEVENLABS_AGENT_ID,
  baseUrl: process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io/v1',
  defaultVoiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? 'EXAVITQu4vr4xnSDxMaL', // Sarah by default
  enableVoiceOverride: process.env.ELEVENLABS_ENABLE_VOICE_OVERRIDE !== 'false', // true by default
  /**
   * When set, forces this TTS `model_id` for every call (overrides multilingual routing).
   * Example: `eleven_turbo_v2_5`, `eleven_v3`, `eleven_multilingual_v2`.
   */
  ttsModelId: process.env.ELEVENLABS_TTS_MODEL_ID?.trim() ?? '',
  /**
   * Default TTS model when the call language is not in `ttsMultilingualLanguages`.
   * `eleven_turbo_v2_5` is latency-optimized at the cost of prosody/expressiveness —
   * `eleven_multilingual_v2` trades a little latency for materially better, less robotic-sounding
   * delivery (see the comment on `VoiceClientFactory.getDefaultVoiceConfig`). This must match
   * `ttsModelMultilingual` below as the actual live default — `voice-client.factory.ts` falls back
   * to `eleven_multilingual_v2` too, but that fallback is dead code as long as this registered
   * config value is what `ConfigService.get('elevenlabs.ttsModelDefault')` actually returns.
   */
  ttsModelDefault: process.env.ELEVENLABS_TTS_MODEL_DEFAULT?.trim() ?? 'eleven_multilingual_v2',
  /** TTS model for multilingual languages (Urdu, Hindi, Arabic, etc.). `eleven_multilingual_v2` works on stream-input for most plans. */
  ttsModelMultilingual:
    process.env.ELEVENLABS_TTS_MODEL_MULTILINGUAL?.trim() ?? 'eleven_multilingual_v2',
  /** Comma-separated ISO 639-1 codes that use `ttsModelMultilingual`. */
  ttsMultilingualLanguages: process.env.ELEVENLABS_TTS_MULTILINGUAL_LANGS?.trim() ?? 'ur,en,fr,no',
  /** Comma-separated fallback `model_id`s tried in order when the primary model returns 403. */
  ttsModelFallbacks:
    process.env.ELEVENLABS_TTS_MODEL_FALLBACKS?.trim() ??
    'eleven_multilingual_v2,eleven_turbo_v2_5',
  /** Realtime STT `model_id` query param (Urdu uses `language_code=ur` with Scribe). */
  sttModelId: process.env.ELEVENLABS_STT_MODEL_ID?.trim() ?? 'scribe_v2_realtime',
  /**
   * When true (default), Scribe auto-detects language and does not pin `language_code`.
   * User speech is interpreted via LLM before flow matching.
   */
  sttMultilingual:
    process.env.ELEVENLABS_STT_MULTILINGUAL !== 'false' &&
    process.env.ELEVENLABS_STT_MULTILINGUAL !== '0',
  /** Use `eleven_v3` TTS for all calls when STT multilingual is on (best cross-language synthesis). */
  ttsMultilingualAll:
    process.env.ELEVENLABS_TTS_MULTILINGUAL_ALL === 'true' ||
    process.env.ELEVENLABS_TTS_MULTILINGUAL_ALL === '1',
}));
