import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChatterboxWithElevenLabsFallbackTTS } from './chatterbox-elevenlabs-fallback.tts';
import { ElevenLabsTTSAdapter } from './elevenlabs-tts.adapter';
import { ITTSClient, ISTTClient, TTSConfig, VoiceProvider } from './voice-client.interface';
import { ChatterboxTTSClient } from '../chatterbox/chatterbox.client';
import { ElevenLabsSTTClient } from '../elevenlabs/elevanlabs-voice.client';
import { ElevenLabsTTSClient } from '../elevenlabs/elevenlabs.client';
import { WhisperSTTClient, type WhisperConfig } from '../whisper/whisper.client';
import {
  buildElevenLabsSttKeyterms,
  canonicalIso6391ToElevenLabsSttCode,
  getElevenLabsTtsFallbackChain,
  metadataToCanonicalIso6391,
  resolveElevenLabsTtsModelId,
} from '../../voice/call-language';
import type { ConversationFlowJSON } from '../../flows/types/flows.types';

export type VoiceMode = 'local' | 'cloud';

@Injectable()
export class VoiceClientFactory {
  private readonly logger = new Logger(VoiceClientFactory.name);
  private readonly mode: VoiceMode;

  constructor(private readonly configService: ConfigService) {
    this.mode = this.configService.get<VoiceMode>('voice.mode', 'cloud');
    this.logger.log(
      `🎙️ Voice mode: ${this.mode} (VOICE_MODE=${process.env.VOICE_MODE ?? 'cloud'})`,
    );
  }

  getMode(): VoiceMode {
    return this.mode;
  }

  /** Provider id for logging / diagnostics */
  getProvider(): VoiceProvider {
    return this.mode === 'local' ? 'chatterbox' : 'elevenlabs';
  }

  isLocalMode(): boolean {
    return this.mode === 'local';
  }

  isCloudMode(): boolean {
    return this.mode === 'cloud';
  }

  createTTSClient(): ITTSClient {
    if (this.mode === 'cloud') {
      const apiKey = this.configService.getOrThrow<string>('elevenlabs.apiKey');
      this.logger.log('🔧 Creating ElevenLabs TTS client (cloud)');
      const client = new ElevenLabsTTSClient(apiKey);
      return new ElevenLabsTTSAdapter(client);
    }

    const baseUrl = this.configService.get<string>(
      'voice.chatterbox.baseUrl',
      'http://localhost:4123',
    );
    const defaultVoicePath = this.configService.get<string>(
      'voice.chatterbox.defaultVoicePath',
      './voice-sample.mp3',
    );
    const apiType = this.configService.get<'openai' | 'gradio'>(
      'voice.chatterbox.apiType',
      'openai',
    );
    const gradioFnIndex = this.configService.get<number>('voice.chatterbox.gradioFnIndex', 0);
    const gradioIncludeVoiceInput = this.configService.get<boolean>(
      'voice.chatterbox.gradioIncludeVoiceInput',
      false,
    );
    const gradioApiName = this.configService.get<string>(
      'voice.chatterbox.gradioApiName',
      'wrap_generate',
    );
    const gradioLangName = this.configService.get<string>('voice.chatterbox.gradioLangName', '');
    this.logger.log(
      `🔧 Chatterbox apiType=${apiType} (baseUrl=${baseUrl}, gradioApi=${gradioApiName})`,
    );

    const chatterbox = new ChatterboxTTSClient(baseUrl, defaultVoicePath, {
      apiType,
      gradioFnIndex,
      gradioIncludeVoiceInput,
      gradioApiName,
      gradioLangName,
    });

    const fallbackEnabled = this.configService.get<boolean>(
      'voice.chatterbox.fallbackToElevenlabs',
      true,
    );
    const elevenKey = this.configService.get<string>('elevenlabs.apiKey')?.trim();
    if (fallbackEnabled && elevenKey) {
      const defaultElVoice = this.configService.get<string>(
        'elevenlabs.defaultVoiceId',
        '21m00Tcm4TlvDq8ikWAM',
      );
      this.logger.log(
        '🔧 Chatterbox TTS (local) + ElevenLabs fallback if Chatterbox is unreachable',
      );
      return new ChatterboxWithElevenLabsFallbackTTS(
        chatterbox,
        new ElevenLabsTTSAdapter(new ElevenLabsTTSClient(elevenKey)),
        this.logger,
        defaultElVoice,
      );
    }

    this.logger.log('🔧 Creating Chatterbox TTS client (local, no ElevenLabs fallback)');
    return chatterbox;
  }

  createSTTClient(languageCode?: string, flow?: ConversationFlowJSON | null): ISTTClient {
    const iso6391 = metadataToCanonicalIso6391(languageCode);
    if (this.mode === 'cloud') {
      const apiKey = this.configService.getOrThrow<string>('elevenlabs.apiKey');
      const keyterms = buildElevenLabsSttKeyterms(flow ?? undefined);
      const sttMultilingual = this.configService.get<boolean>('elevenlabs.sttMultilingual') ?? true;
      const elevenLabsLang = canonicalIso6391ToElevenLabsSttCode(iso6391);
      const sttModelId =
        this.configService.get<string>('elevenlabs.sttModelId') ?? 'scribe_v2_realtime';
      // This call's expected language is already known (from the agent/flow/inbound-number
      // config) whenever it's 'en' — the common case. Previously `includeLanguageDetection` /
      // `enableAutomaticLanguageDetection` were forced on for every call as long as the *global*
      // `sttMultilingual` flag was true (its default), regardless of what language this specific
      // call actually expected. That let Scribe's auto-detect misidentify the language of clear
      // English speech (background noise, accent, short utterances) and silently hand a
      // "detected" non-English language to the interpretation/translation step, which then
      // translated speech that was never anything but English. Pin the STT language explicitly
      // whenever the call is English — no guessing — and only run full auto-detect for calls
      // that are genuinely configured for a non-English language, where auto-detect earns its
      // keep (e.g. code-switching within a multilingual conversation).
      const isExplicitlyEnglish = iso6391 === 'en';
      const useAutoDetect = sttMultilingual && !isExplicitlyEnglish;
      const sttLanguageHint = useAutoDetect ? elevenLabsLang : undefined;
      this.logger.log(
        isExplicitlyEnglish
          ? `🔧 ElevenLabs STT (language=en, pinned — no auto-detect/translation, ${String(keyterms.length)} keyterms)`
          : useAutoDetect
            ? sttLanguageHint
              ? `🔧 ElevenLabs STT (multilingual + hint=${sttLanguageHint}, ${String(keyterms.length)} keyterms)`
              : `🔧 ElevenLabs STT (multilingual auto-detect, ${String(keyterms.length)} keyterms)`
            : `🔧 ElevenLabs STT (language=${elevenLabsLang}, ${String(keyterms.length)} keyterms)`,
      );
      return new ElevenLabsSTTClient(apiKey, {
        modelId: sttModelId,
        languageCode: useAutoDetect ? sttLanguageHint : elevenLabsLang,
        keyterms,
        includeLanguageDetection: useAutoDetect,
        enableAutomaticLanguageDetection: useAutoDetect,
        audioFormat: 'pcm_16000',
        serverVad: {
          // Was 0.3/150ms — too sensitive to line noise/silence on real phone calls, producing
          // hallucinated transcripts ("Hello.", "Yeah.", "Aspirin.") with nobody speaking, which
          // then falsely triggered barge-in and consumed real flow turns.
          vadThreshold: 0.5,
          vadSilenceThresholdSecs: 0.7,
          minSpeechDurationMs: 250,
          /** How long a silence must hold before STT commits the utterance as final — this is pure
           * dead time added to every single turn (user stops talking → this elapses → the agent
           * even starts thinking). 1200ms was tuned up from 900ms specifically to avoid committing
           * on a brief mid-sentence pause; 900ms was itself already a working value, not a guess,
           * so reverting to it trades a small amount of that safety margin for ~300ms off every
           * turn's perceived response time. If users start getting cut off mid-sentence, raise this
           * back toward 1200ms rather than pushing it lower. */
          minSilenceDurationMs: 900,
        },
      }) as ISTTClient;
    }

    const serverUrl = this.configService.get<string>(
      'voice.whisper.serverUrl',
      'http://localhost:8000',
    );
    const modelSize = this.configService.get<string>('voice.whisper.modelSize', 'base');
    const whisperLang =
      iso6391 || this.configService.get<string>('voice.whisper.languageCode', 'en');

    const useOpenAi = this.configService.get<boolean>('voice.whisper.useOpenAi', true);
    const openaiKey = this.configService.get<string>('openai.apiKey')?.trim();
    const openaiApiKey = useOpenAi && openaiKey ? openaiKey : undefined;

    this.logger.log(
      openaiApiKey
        ? '🔧 Creating Whisper STT client (OpenAI whisper-1 API)'
        : '🔧 Creating Whisper STT client (self-hosted; set OPENAI_API_KEY to use OpenAI instead)',
    );

    return new WhisperSTTClient({
      modelSize: modelSize as NonNullable<WhisperConfig['modelSize']>,
      languageCode: whisperLang,
      audioFormat: 'pcm_16000',
      serverUrl,
      openaiApiKey,
    }) as ISTTClient;
  }

  isSttMultilingualEnabled(): boolean {
    if (this.mode !== 'cloud') return false;
    return this.configService.get<boolean>('elevenlabs.sttMultilingual') ?? true;
  }

  getDefaultVoiceConfig(language?: string): TTSConfig {
    const lang = metadataToCanonicalIso6391(language);
    if (this.mode === 'cloud') {
      const ttsOverride = this.configService.get<string>('elevenlabs.ttsModelId')?.trim() ?? '';
      const sttMultilingual = this.isSttMultilingualEnabled();
      const ttsMultilingualAll =
        this.configService.get<boolean>('elevenlabs.ttsMultilingualAll') ?? false;
      const multilingualLanguagesCsv =
        this.configService.get<string>('elevenlabs.ttsMultilingualLanguages') ??
        'ur,hi,ar,bn,pa,fa,es,fr,de,no';
      const multilingualModelId =
        this.configService.get<string>('elevenlabs.ttsModelMultilingual') ?? 'eleven_v3';
      const fallbackCsv =
        this.configService.get<string>('elevenlabs.ttsModelFallbacks') ??
        'eleven_v3,eleven_turbo_v2_5';
      const modelId = resolveElevenLabsTtsModelId(lang, {
        explicitModelId: ttsOverride || undefined,
        forceMultilingualModel: ttsMultilingualAll,
        multilingualLanguagesCsv,
        multilingualModelId,
        // `eleven_turbo_v2_5` is latency-optimized at the cost of prosody/expressiveness — it was
        // the default for every English call (the majority of traffic), which is why the agent
        // sounds flat/robotic even though ElevenLabs itself supports much more natural output.
        // `eleven_multilingual_v2` trades a little latency for materially better prosody; turbo
        // is kept as a fallback below for when latency actually matters more than tone.
        defaultModelId:
          this.configService.get<string>('elevenlabs.ttsModelDefault') ?? 'eleven_multilingual_v2',
      });
      const modelFallbackIds = getElevenLabsTtsFallbackChain(modelId, fallbackCsv);
      this.logger.log(
        `🔧 ElevenLabs TTS model for ${lang}: ${modelId}${modelFallbackIds.length ? ` (fallback: ${modelFallbackIds.join(' → ')})` : ''}`,
      );
      return {
        voiceId: this.configService.get<string>(
          'elevenlabs.defaultVoiceId',
          '21m00Tcm4TlvDq8ikWAM',
        ),
        modelId,
        modelFallbackIds,
        outputFormat: 'pcm_16000',
        // style 0.0 (the previous implicit default) is the flattest setting ElevenLabs can
        // produce — it's the expressiveness/emotion knob. Paired with a slightly lower stability
        // so the model has room to vary delivery instead of flattening every line to the same
        // reading. Tune both against real call recordings; these are a starting point, not tuned
        // per-voice.
        stability: this.configService.get<number>('elevenlabs.ttsStability') ?? 0.42,
        similarityBoost: this.configService.get<number>('elevenlabs.ttsSimilarityBoost') ?? 0.8,
        style: this.configService.get<number>('elevenlabs.ttsStyle') ?? 0.35,
        useSpeakerBoost: true,
        speed: 1.0,
        language: lang,
      };
    }
    return {
      voiceId: this.configService.get<string>(
        'voice.chatterbox.defaultVoicePath',
        './voice-sample.mp3',
      ),
      outputFormat: 'wav',
      exaggeration: 0.5,
      cfgWeight: 0.5,
      temperature: 0.8,
      language: lang,
    };
  }
}
