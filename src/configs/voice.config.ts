import { registerAs } from '@nestjs/config';
import * as path from 'path';

const templateAudioPath = path.join(__dirname, '../../assets/template_audio.wav');
/**
 * Voice stack selection (see VoiceClientFactory).
 * - cloud: ElevenLabs TTS + ElevenLabs STT (staging/production — same as before)
 * - local: Chatterbox TTS + Whisper STT (development)
 *
 * Set VOICE_MODE=local | cloud (default: cloud).
 *
 * When local: `POST /calls` skips Twilio and runs the same agent/flow in the server terminal
 * (optional idle chat: VOICE_TERMINAL_REPL=true). Inbound/voice-agent webhooks respond with
 * immediate Hangup. Optional: VOICE_TERMINAL_SCRIPT, VOICE_TERMINAL_METADATA (JSON),
 * VOICE_TERMINAL_FLOW_ID + VOICE_TERMINAL_FLOW_COMPANY_ID for idle REPL only.
 */
function resolveChatterboxApiType(
  baseUrl: string,
  explicit: string | undefined,
): 'openai' | 'gradio' {
  if (explicit === 'openai' || explicit === 'gradio') {
    return explicit;
  }
  // Gradio default port / URL → use /gradio_api/call (browser UI uses the same server)
  if (
    /:7860(\/|$)/.test(baseUrl) ||
    baseUrl.includes('127.0.0.1:7860') ||
    baseUrl.includes('localhost:7860')
  ) {
    return 'gradio';
  }
  return 'openai';
}

export default registerAs('voice', () => {
  const raw = (process.env.VOICE_MODE ?? 'cloud').toLowerCase();
  const mode = raw === 'local' ? 'local' : 'cloud';

  const chatterboxBaseUrl = process.env.CHATTERBOX_BASE_URL ?? 'http://localhost:4123';
  const chatterboxApiType = resolveChatterboxApiType(
    chatterboxBaseUrl,
    process.env.CHATTERBOX_API_TYPE,
  );

  const terminalRepl =
    mode === 'local' &&
    (process.env.VOICE_TERMINAL_REPL === 'true' || process.env.VOICE_TERMINAL_REPL === '1');

  return {
    mode,
    terminalRepl,
    chatterbox: {
      baseUrl: chatterboxBaseUrl,
      defaultVoicePath: process.env.CHATTERBOX_DEFAULT_VOICE_PATH ?? templateAudioPath,
      /** openai: POST /v1/audio/speech. gradio: POST /gradio_api/call (default when URL uses :7860). */
      apiType: chatterboxApiType,
      gradioFnIndex: parseInt(process.env.CHATTERBOX_GRADIO_FN_INDEX ?? '0', 10),
      /** Named endpoint from "View API" (e.g. wrap_generate → /wrap_generate via @gradio/client). */
      gradioApiName:
        (process.env.CHATTERBOX_GRADIO_API_NAME ?? 'wrap_generate').replace(/^\/+/, '').trim() ||
        'wrap_generate',
      /** Gradio "Language" dropdown label (e.g. English). Empty = derive from agent language code. */
      gradioLangName: process.env.CHATTERBOX_GRADIO_LANG_NAME ?? '',
      /** Set true if your Gradio app takes [text, reference_audio] as inputs. */
      gradioIncludeVoiceInput: process.env.CHATTERBOX_GRADIO_INCLUDE_VOICE === 'true',
      /** If Chatterbox is not running, use ElevenLabs TTS when ELEVENLABS_API_KEY is set (local dev). */
      fallbackToElevenlabs: process.env.CHATTERBOX_FALLBACK_TO_ELEVENLABS !== 'false',
    },
    whisper: {
      serverUrl: process.env.WHISPER_SERVER_URL ?? 'http://localhost:8000',
      /** When true (default) and OPENAI_API_KEY is set, use api.openai.com/v1/audio/transcriptions (no local Whisper server). */
      useOpenAi: process.env.WHISPER_USE_OPENAI !== 'false',
      modelSize: (process.env.WHISPER_MODEL_SIZE ?? 'base') as
        | 'tiny'
        | 'base'
        | 'small'
        | 'medium'
        | 'large-v3',
      languageCode: process.env.WHISPER_LANGUAGE_CODE ?? 'en',
    },
  };
});
