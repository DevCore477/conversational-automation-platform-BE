import { Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';

export interface TTSStreamConfig {
  voiceId: string;
  fallbackVoiceId?: string;
  modelId?: string;
  modelFallbackIds?: string[];
  outputFormat?: 'mp3_44100' | 'pcm_16000' | 'pcm_22050' | 'pcm_24000' | 'pcm_44100';
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
}

export interface TTSAudioChunk {
  audio: Buffer;
  isFinal: boolean;
}

export interface VerifiedLanguage {
  language: string;
  model_id?: string;
  accent?: string | null;
  locale?: string | null;
  preview_url?: string | null;
}

export interface ElevenLabsVoice {
  voice_id: string;
  public_owner_id?: string;
  name: string;
  category: string;
  labels?: Record<string, string>;
  description?: string;
  preview_url?: string;
  available_for_tiers?: string[];
  settings?: {
    stability?: number;
    similarity_boost?: number;
  };
  verified_languages?: VerifiedLanguage[];
}

/**
 * ElevenLabs' streaming-input WS defaults to closing a connection that has received no new text
 * for 20s. `inactivity_timeout` extends that — but only when sent as a URL query parameter on the
 * connection itself; it is NOT read from the BOS JSON message body (a prior version of this file
 * sent it there, which ElevenLabs silently ignored, so every prewarmed socket kept closing after
 * exactly the default 20s regardless of what we asked for). 180 is ElevenLabs' documented maximum.
 */
const TTS_INACTIVITY_TIMEOUT_SECS = 180;

/**
 * Belt-and-suspenders on top of `inactivity_timeout`: while a prewarmed socket sits idle waiting
 * for the next turn's text (LLM/flow latency, user thinking time), periodically send a whitespace
 * keep-alive so the server's inactivity clock never has a chance to elapse — even if a turn takes
 * longer than `TTS_INACTIVITY_TIMEOUT_SECS`, or if the query-param timeout is ever capped/ignored
 * again. `try_trigger_generation: false` means this never produces audible output.
 */
const TTS_KEEPALIVE_INTERVAL_MS = 15_000;

export class ElevenLabsTTSClient {
  private readonly logger = new Logger(ElevenLabsTTSClient.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'wss://api.elevenlabs.io/v1/text-to-speech';
  private readonly client: AxiosInstance;
  private readonly defaultVoiceId: string;
  private readonly agentId: string;
  private activeWebSocket: WebSocket | null = null;
  /** Opened ahead of need by {@link prewarm} so the next turn's TTS doesn't pay the connect+TLS
   * handshake (~1s observed against ElevenLabs) on the critical path. Consumed by streamTTSOnce. */
  private warmSocket: WebSocket | null = null;
  private warmSocketKey: string | null = null;
  private warmSocketKeepAlive: NodeJS.Timeout | null = null;
  private isAborted = false;
  /** Static: a fresh ElevenLabsTTSClient instance is created per call (see VoiceClientFactory),
   * so an instance-level cache would never get a hit and every call would re-pay the
   * `GET /voices/{id}` round trip on the hot path before the first TTS connect. Shared across all
   * instances in the process so a voice is validated once, not once per call. */
  private static readonly knownVoiceIds = new Set<string>();
  private static readonly knownInvalidVoiceIds = new Set<string>();
  /** voice_id -> origin in the public Voice Library, learned whenever shared voices are fetched.
   * A shared voice must be added to the account (see addSharedVoiceToLibrary) before it can be used
   * for TTS — listing it from `/shared-voices` alone does not make it usable. */
  private sharedVoiceOrigins = new Map<string, { publicOwnerId: string; name: string }>();

  // Cache for voices to prevent repeated slow fetches
  private voicesCache: {
    data: { voices: ElevenLabsVoice[] } | null;
    expiry: number;
  } = { data: null, expiry: 0 };
  private readonly VOICES_CACHE_TTL_MS = 60_000; // 1 minute

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.defaultVoiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? 'iP95p4xoKVk53GoZ742B';
    this.agentId = process.env.ELEVENLABS_AGENT_ID ?? 'default-agent';

    this.client = axios.create({
      baseURL: 'https://api.elevenlabs.io/v1',
      timeout: 8000, // CRITICAL: 8s timeout per request
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  abort(): void {
    this.logger.log(`🛑 Aborting TTS stream`);
    this.isAborted = true;
    this.discardWarmSocket();
    if (this.activeWebSocket) {
      try {
        this.activeWebSocket.close(1000, 'Aborted by user');
      } catch (err) {
        // Ignore
      }
      this.activeWebSocket = null;
    }
  }

  isActive(): boolean {
    return this.activeWebSocket !== null && this.activeWebSocket.readyState === WebSocket.OPEN;
  }

  private warmSocketKeyFor(voiceId: string, modelId: string): string {
    return `${voiceId}::${modelId}`;
  }

  private clearWarmSocketKeepAlive(): void {
    if (this.warmSocketKeepAlive) {
      clearInterval(this.warmSocketKeepAlive);
      this.warmSocketKeepAlive = null;
    }
  }

  private discardWarmSocket(): void {
    this.clearWarmSocketKeepAlive();
    if (this.warmSocket) {
      try {
        this.warmSocket.close();
      } catch {
        /* ignore */
      }
    }
    this.warmSocket = null;
    this.warmSocketKey = null;
  }

  /**
   * Open and initialize a TTS WebSocket ahead of need. Call this as soon as the current turn
   * finishes speaking — by the time the next reply is ready (after STT silence wait + LLM/flow
   * processing, normally 1-3s+), the connection is already open, so `streamTTS` can skip the
   * connect+TLS handshake that otherwise blocks the start of every single reply. Best-effort: if
   * the warm socket isn't ready or has gone stale by the time it's needed, streamTTS just falls
   * back to opening a fresh one as before.
   */
  prewarm(config: TTSStreamConfig): void {
    const voiceId = config.voiceId;
    if (!voiceId) return;
    const modelId = config.modelId || 'eleven_turbo_v2_5';
    const key = this.warmSocketKeyFor(voiceId, modelId);

    if (
      this.warmSocket &&
      this.warmSocket.readyState === WebSocket.OPEN &&
      this.warmSocketKey === key
    ) {
      return; // already warm for this voice/model
    }
    this.discardWarmSocket();

    try {
      const wsUrl = `${this.baseUrl}/${voiceId}/stream-input?model_id=${modelId}&inactivity_timeout=${String(TTS_INACTIVITY_TIMEOUT_SECS)}`;
      const ws = new WebSocket(wsUrl);
      this.warmSocket = ws;
      this.warmSocketKey = key;

      ws.on('open', () => {
        if (this.warmSocket !== ws) return; // superseded by a newer prewarm() call
        const initMessage = {
          text: ' ',
          voice_settings: {
            stability: config.stability ?? 0.5,
            similarity_boost: config.similarityBoost ?? 0.8,
            style: config.style ?? 0.0,
            use_speaker_boost: config.useSpeakerBoost ?? true,
            speed: config.speed ?? 1.0,
          },
          generation_config: {
            chunk_length_schedule: [50, 80, 120, 160],
          },
          xi_api_key: this.apiKey,
          try_trigger_generation: true,
          output_format: config.outputFormat ?? 'pcm_22050',
          // Level 4 (max) sacrifices pronunciation/quality for speed per ElevenLabs docs — was
          // producing slurred/stretched-sounding speech. 2 keeps most of the latency win.
          optimize_streaming_latency: 2,
        };
        try {
          ws.send(JSON.stringify(initMessage));
          this.logger.debug(
            `🌤️ Pre-warmed TTS WebSocket ready for ${voiceId}/${modelId} (inactivity_timeout=${String(TTS_INACTIVITY_TIMEOUT_SECS)}s)`,
          );
        } catch {
          /* ignore */
        }
        // Defense in depth on top of inactivity_timeout: keep resetting the server's inactivity
        // clock for as long as this socket sits idle waiting to be claimed by the next turn.
        this.clearWarmSocketKeepAlive();
        this.warmSocketKeepAlive = setInterval(() => {
          if (this.warmSocket !== ws || ws.readyState !== WebSocket.OPEN) {
            this.clearWarmSocketKeepAlive();
            return;
          }
          try {
            ws.send(JSON.stringify({ text: ' ', try_trigger_generation: false }));
            this.logger.debug(
              `🌤️ Pre-warmed TTS WebSocket keep-alive sent for ${voiceId}/${modelId}`,
            );
          } catch (err) {
            this.logger.debug(
              `Pre-warmed TTS keep-alive send failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }, TTS_KEEPALIVE_INTERVAL_MS);
      });
      ws.on('close', () => {
        if (this.warmSocket === ws) {
          this.clearWarmSocketKeepAlive();
          this.warmSocket = null;
          this.warmSocketKey = null;
        }
      });
      ws.on('error', () => {
        if (this.warmSocket === ws) {
          this.clearWarmSocketKeepAlive();
          this.warmSocket = null;
          this.warmSocketKey = null;
        }
      });
    } catch {
      this.clearWarmSocketKeepAlive();
      this.warmSocket = null;
      this.warmSocketKey = null;
    }
  }

  /** Claim the warm socket for reuse if it matches and its init message has already been sent. */
  private claimWarmSocket(voiceId: string, modelId: string): WebSocket | null {
    const key = this.warmSocketKeyFor(voiceId, modelId);
    if (
      this.warmSocket &&
      this.warmSocket.readyState === WebSocket.OPEN &&
      this.warmSocketKey === key
    ) {
      const ws = this.warmSocket;
      // Real text is about to be sent — the keep-alive's job (preventing the *idle* timeout) is
      // done; leaving it running would race a keep-alive send against the real chunks below.
      this.clearWarmSocketKeepAlive();
      this.warmSocket = null;
      this.warmSocketKey = null;
      return ws;
    }
    return null;
  }

  async validateVoiceId(voiceId: string): Promise<boolean> {
    if (ElevenLabsTTSClient.knownVoiceIds.has(voiceId)) return true;
    if (ElevenLabsTTSClient.knownInvalidVoiceIds.has(voiceId)) return false;
    try {
      await this.client.get(`/voices/${voiceId}`);
      ElevenLabsTTSClient.knownVoiceIds.add(voiceId);
      return true;
    } catch (error: any) {
      // ElevenLabs returns 404 for some invalid IDs and 400 for others (e.g. malformed or
      // not-owned voice IDs) — both mean "this voice can't be used," not "validation failed."
      if (error.response?.status === 404 || error.response?.status === 400) {
        ElevenLabsTTSClient.knownInvalidVoiceIds.add(voiceId);
        return false;
      }
      this.logger.warn(`Could not validate voice ${voiceId}: ${error.message}`);
      return true;
    }
  }

  async streamTTS(
    config: TTSStreamConfig,
    textIterator: AsyncIterable<string>,
    onAudioChunk: (chunk: TTSAudioChunk) => void | Promise<void>,
    onError?: (error: Error) => void,
  ): Promise<void> {
    let primaryVoiceId: string | undefined = config.voiceId;
    if (primaryVoiceId && !(await this.validateVoiceId(primaryVoiceId))) {
      this.logger.warn(
        `Voice ${primaryVoiceId} not found in account. ` +
          `Make sure shared voices are added to your account, or use a default voice.`,
      );
      // Known-bad: skip straight to the fallback instead of eating a full failed
      // connect+init+error round trip on the doomed voice every single call.
      if (config.fallbackVoiceId) {
        primaryVoiceId = undefined;
      }
    }

    // const textChunks: string[] = [];
    // for await (const chunk of textIterator) {
    //   textChunks.push(chunk);
    // }
    // const replayText = async function* (): AsyncGenerator<string> {
    //   for (const chunk of textChunks) yield chunk;
    // };

    const voiceIds = [primaryVoiceId, config.fallbackVoiceId].filter(
      (id, index, all): id is string => Boolean(id) && all.indexOf(id) === index,
    );
    if (voiceIds.length === 0) {
      throw new Error('No voice ID or fallbackVoiceId provided');
    }

    const replayableChunks: string[] = [];
    let liveIteratorUsed = false;

    const liveText = async function* (): AsyncGenerator<string> {
      for await (const chunk of textIterator) {
        replayableChunks.push(chunk);
        yield chunk;
      }
    };

    const replayText = function* (): Generator<string> {
      for (const chunk of replayableChunks) {
        yield chunk;
      }
    };

    let lastError: Error | undefined;
    for (let voiceAttempt = 0; voiceAttempt < voiceIds.length; voiceAttempt++) {
      const voiceId = voiceIds[voiceAttempt];
      const primary = config.modelId || 'eleven_turbo_v2_5';
      const modelIds = [primary, ...(config.modelFallbackIds ?? [])].filter(
        (id, index, all) => all.indexOf(id) === index,
      );

      for (let modelAttempt = 0; modelAttempt < modelIds.length; modelAttempt++) {
        const modelId = modelIds[modelAttempt];
        this.isAborted = false;

        const iterator = !liveIteratorUsed ? liveText() : replayText();
        liveIteratorUsed = true;
        try {
          await this.streamTTSOnce(
            { ...config, voiceId, modelId },
            iterator,
            onAudioChunk,
            onError,
          );
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const nextModel = modelIds[modelAttempt + 1];
          if (nextModel && isTtsAccessDenied(lastError)) {
            this.logger.warn(
              `⚠️ TTS model ${modelId} rejected (${lastError.message}); trying ${nextModel}`,
            );
            continue;
          }
          const nextVoice = voiceIds[voiceAttempt + 1];
          if (nextVoice && isTtsVoiceInvalid(lastError)) {
            this.logger.warn(
              `⚠️ ElevenLabs voice ${voiceId} unavailable (${lastError.message}); trying ${nextVoice}`,
            );
            break;
          }
          throw lastError;
        }
      }
    }
    throw lastError ?? new Error('TTS stream failed after exhausting all voice/model fallbacks');
  }

  private async streamTTSOnce(
    config: TTSStreamConfig,
    textIterator: AsyncGenerator<string> | Generator<string>,
    onAudioChunk: (chunk: TTSAudioChunk) => void | Promise<void>,
    onError?: (error: Error) => void,
  ): Promise<void> {
    const voiceId = config.voiceId;
    const modelId = config.modelId || 'eleven_turbo_v2_5';
    const wsUrl = `${this.baseUrl}/${voiceId}/stream-input?model_id=${modelId}&inactivity_timeout=${String(TTS_INACTIVITY_TIMEOUT_SECS)}`;

    const reused = this.claimWarmSocket(voiceId, modelId);
    if (!reused) {
      this.logger.log(`🔌 Connecting to ElevenLabs TTS: ${wsUrl}`);
    } else {
      this.logger.log(`🌤️ Reusing pre-warmed TTS WebSocket for ${voiceId}/${modelId}`);
    }

    return new Promise((resolve, reject) => {
      this.isAborted = false;
      let ws: WebSocket | null = null;
      let isClosed = false;
      let audioReceived = false;
      let listenTask: Promise<void> | null = null;
      let settled = false;

      const safeResolve = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const safeReject = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      try {
        ws = reused ?? new WebSocket(wsUrl);
        const connectionTimeout = setTimeout(() => {
          if (!audioReceived && !isClosed) {
            isClosed = true;
            ws?.close();
            safeReject(new Error('Connection timeout - no audio received'));
          }
        }, 8000);

        const onSocketOpen = async () => {
          this.logger.log(
            reused
              ? `🌤️ Pre-warmed TTS WebSocket ready to stream`
              : `🔌 ElevenLabs TTS WebSocket opened`,
          );
          this.activeWebSocket = ws;

          if (this.isAborted) {
            isClosed = true;
            try {
              ws?.close(1000, 'Aborted before stream');
            } catch {
              /* ignore */
            }
            if (this.activeWebSocket === ws) {
              this.activeWebSocket = null;
            }
            clearTimeout(connectionTimeout);
            safeResolve();
            return;
          }

          // A reused warm socket already had its init message sent (with the same voice/model
          // config) when it was opened by prewarm() — sending it again would restart that context.
          if (!reused) {
            const initMessage = {
              text: ' ',
              voice_settings: {
                stability: config.stability ?? 0.5,
                similarity_boost: config.similarityBoost ?? 0.8,
                style: config.style ?? 0.0,
                use_speaker_boost: config.useSpeakerBoost ?? true,
                speed: config.speed ?? 1.0,
              },
              generation_config: {
                chunk_length_schedule: [50, 80, 120, 160],
              },
              xi_api_key: this.apiKey,
              try_trigger_generation: true,
              output_format: config.outputFormat ?? 'pcm_22050',
              // Keep in sync with prewarm()'s init message — level 4 (max) trades pronunciation
              // quality for speed per ElevenLabs docs.
              optimize_streaming_latency: 2,
            };

            this.logger.debug(`📤 Sending init message`);
            ws!.send(JSON.stringify(initMessage));
          }

          listenTask = this.listenForAudio(
            ws,
            chunk => {
              if (chunk.audio && chunk.audio.length > 0) {
                audioReceived = true;
              }
              return onAudioChunk(chunk);
            },
            () => isClosed,
          );
          // listenTask isn't awaited until after the text-sending loop below finishes, which can
          // block indefinitely (e.g. waiting on more text to translate/stream). If it rejects
          // before then — e.g. ElevenLabs sends an init-time error like voice_id_does_not_exist —
          // fail fast: stop feeding text and surface the error immediately, instead of leaving the
          // rejection dangling with no handler (which crashes the process on Node's unhandled
          // rejection check) until the loop happens to finish on its own.
          listenTask.catch((err: unknown) => {
            isClosed = true;
            clearTimeout(connectionTimeout);
            safeReject(err instanceof Error ? err : new Error(String(err)));
          });

          try {
            let chunkCount = 0;
            for await (const textChunk of textIterator) {
              if (this.isAborted || isClosed || ws!.readyState !== WebSocket.OPEN) break;
              if (textChunk.trim()) {
                chunkCount++;
                this.logger.debug(
                  `📤 Sending chunk #${chunkCount}: "${textChunk.substring(0, 30)}..."`,
                );
                ws!.send(
                  JSON.stringify({
                    text: textChunk,
                    try_trigger_generation: true,
                  }),
                );
              }
            }

            this.logger.log(`📤 Finished sending ${chunkCount} chunks`);
            if (!this.isAborted && ws!.readyState === WebSocket.OPEN) {
              ws!.send(JSON.stringify({ text: '' }));
            }
            if (listenTask) {
              await listenTask;
            }
            clearTimeout(connectionTimeout);
            if (this.activeWebSocket === ws) {
              this.activeWebSocket = null;
            }
            safeResolve();
          } catch (error) {
            clearTimeout(connectionTimeout);
            if (this.activeWebSocket === ws) {
              this.activeWebSocket = null;
            }
            safeReject(error instanceof Error ? error : new Error(String(error)));
          }
        };

        if (reused) {
          // Already open — invoke directly instead of waiting for an 'open' event that already fired.
          void onSocketOpen();
        } else {
          ws.on('open', onSocketOpen);
        }

        ws.on('error', (error: any) => {
          this.logger.error(`❌ WebSocket error:`, error.message || error);
          isClosed = true;
          clearTimeout(connectionTimeout);
          if (this.activeWebSocket === ws) {
            this.activeWebSocket = null;
          }
          if (onError) onError(error);
          safeReject(error instanceof Error ? error : new Error(String(error)));
        });

        ws.on('close', (code: number, reason: Buffer) => {
          const reasonStr = reason.toString();
          this.logger.log(`🔌 WebSocket closed: ${code} - ${reasonStr}`);
          isClosed = true;
          clearTimeout(connectionTimeout);
          if (this.activeWebSocket === ws) {
            this.activeWebSocket = null;
          }
          if (code === 1008 && reasonStr.includes('input_timeout')) {
            this.logger.error(`⏱️ Input timeout - text not sent fast enough`);
          }
          if (code !== 1000 && code !== 1001 && !audioReceived) {
            safeReject(new Error(`WebSocket closed: ${code} - ${reasonStr}`));
          } else {
            safeResolve();
          }
        });
      } catch (error) {
        safeReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async generateSpeech(text: string, config: TTSStreamConfig): Promise<Buffer> {
    this.logger.log(`🎤 Generating speech for: "${text.substring(0, 50)}..."`);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const textIterator = (async function* () {
        const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
        for (const sentence of sentences) {
          yield sentence;
        }
      })();

      this.streamTTS(
        config,
        textIterator,
        chunk => {
          if (chunk.audio && chunk.audio.length > 0) {
            chunks.push(chunk.audio);
          }
        },
        error => {
          reject(error);
        },
      )
        .then(() => {
          const finalBuffer = Buffer.concat(chunks);
          this.logger.log(`✅ Generated ${finalBuffer.length} bytes of audio`);
          if (finalBuffer.length === 0) {
            reject(new Error('No audio generated'));
          } else {
            resolve(finalBuffer);
          }
        })
        .catch(reject);
    });
  }

  private async listenForAudio(
    ws: WebSocket,
    onAudioChunk: (chunk: TTSAudioChunk) => void | Promise<void>,
    isClosed: () => boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const messageHandler = async (data: WebSocket.Data) => {
        if (isClosed()) {
          ws.off('message', messageHandler);
          resolve();
          return;
        }
        try {
          const message = JSON.parse(data.toString());
          const isFinal = message.isFinal === true || message.is_final === true;
          const audioBase64 = message.audio ?? message.chunk ?? message.data;

          if (audioBase64 && typeof audioBase64 === 'string') {
            const audioBuffer = Buffer.from(audioBase64, 'base64');
            if (audioBuffer.length > 0) {
              this.logger.debug(`📥 TTS received audio chunk: ${audioBuffer.length} bytes`);
              await onAudioChunk({
                audio: audioBuffer,
                isFinal: false,
              });
            }
          }

          if (isFinal) {
            await onAudioChunk({
              audio: Buffer.alloc(0),
              isFinal: true,
            });
            ws.off('message', messageHandler);
            resolve();
          }

          if (message.error) {
            this.logger.error(`❌ ElevenLabs error:`, message.error);
            const errText =
              typeof message.error === 'string' ? message.error : JSON.stringify(message.error);
            if (isTtsVoiceInvalidMessage(errText)) {
              ws.off('message', messageHandler);
              reject(new Error(errText));
            }
          }
        } catch (error) {
          ws.off('message', messageHandler);
          reject(error);
        }
      };

      ws.on('message', messageHandler);
      ws.on('close', () => {
        ws.off('message', messageHandler);
        if (!isClosed()) resolve();
      });
    });
  }

  async getAgent(): Promise<{
    agent_id: string;
    name: string;
    voice_id?: string;
    conversation_config?: any;
  }> {
    try {
      this.logger.log(`Fetching agent configuration for ${this.agentId}`);
      const res = await this.client.get(`/convai/agents/${this.agentId}`);
      this.logger.log(`Successfully fetched agent configuration`);
      return res.data;
    } catch (error: any) {
      this.logger.error(`Failed to fetch agent: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Fetch voices with caching and a hard global timeout.
   * This prevents the server from hanging if ElevenLabs is slow.
   */
  async getVoices(): Promise<{ voices: ElevenLabsVoice[] }> {
    // Return cached result if valid
    if (this.voicesCache.data && Date.now() < this.voicesCache.expiry) {
      this.logger.log('Returning cached voices');
      return this.voicesCache.data;
    }

    this.logger.log('Fetching available voices from ElevenLabs');

    // Race against a global 8-second timeout
    const voicesPromise = this.fetchVoicesInternal();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error('Voices fetch timed out after 8s'));
      }, 8000),
    );

    try {
      const result = await Promise.race([voicesPromise, timeoutPromise]);
      this.voicesCache = {
        data: result,
        expiry: Date.now() + this.VOICES_CACHE_TTL_MS,
      };
      return result;
    } catch (error: any) {
      this.logger.error(`Failed to fetch voices: ${error.message}`);
      // Return stale cache if available, otherwise empty
      if (this.voicesCache.data) {
        this.logger.warn('Returning stale voice cache due to fetch failure');
        return this.voicesCache.data;
      }
      return { voices: [] };
    }
  }

  private async fetchVoicesInternal(): Promise<{ voices: ElevenLabsVoice[] }> {
    // Fetch default voices + shared voices in parallel
    const [defaultRes, urduVoices] = await Promise.all([
      this.client.get('/voices').catch((err: any) => {
        this.logger.error(`Failed to fetch default voices: ${err.message}`);
        return { data: { voices: [] } };
      }),
      this.getUrduVoices().catch((err: any) => {
        this.logger.error(`Failed to fetch Urdu voices: ${err.message}`);
        return [] as ElevenLabsVoice[];
      }),
      // this.getHindiVoices().catch((err: any) => {
      //   this.logger.error(`Failed to fetch Hindi voices: ${err.message}`);
      //   return [] as ElevenLabsVoice[];
      // }),
    ]);

    const defaultVoices: ElevenLabsVoice[] = defaultRes.data?.voices || [];
    const existingVoiceIds = new Set(defaultVoices.map((v: ElevenLabsVoice) => v.voice_id));

    const mergedVoices = [
      ...defaultVoices,
      ...urduVoices.filter((v: ElevenLabsVoice) => !existingVoiceIds.has(v.voice_id)),
      // ...hindiVoices.filter((v: ElevenLabsVoice) => !existingVoiceIds.has(v.voice_id)),
    ];

    mergedVoices.forEach((v: ElevenLabsVoice) => ElevenLabsTTSClient.knownVoiceIds.add(v.voice_id));

    this.logger.log(`Successfully fetched ${mergedVoices.length} voices`);
    return { voices: mergedVoices };
  }

  async getUrduVoices(): Promise<ElevenLabsVoice[]> {
    return this.fetchSharedVoices(['ur', 'urd'], ['Urdu', 'Pakistan']);
  }

  async getHindiVoices(): Promise<ElevenLabsVoice[]> {
    return this.fetchSharedVoices(['hi', 'hin'], ['Hindi', 'India']);
  }

  /**
   * Fetch shared voices with hard limits so it never hangs.
   * Max 10 pages per query (1000 results).
   */
  private async fetchSharedVoices(
    languageCodes: string[],
    searchTerms: string[],
  ): Promise<ElevenLabsVoice[]> {
    const allVoices: any[] = [];
    const queries = [
      ...languageCodes.map(code => ({ language: code })),
      ...searchTerms.map(term => ({ search: term })),
    ];

    const MAX_PAGES = 10; // Hard cap: 10 pages × 100 = 1000 results per query

    for (const query of queries) {
      let page = 0;
      let hasMore = true;

      while (hasMore && page < MAX_PAGES) {
        try {
          const res = await this.client.get('/shared-voices', {
            params: {
              ...query,
              page_size: 100,
              page,
            },
          });

          const voices = res.data?.voices || [];
          allVoices.push(...voices);
          hasMore = Boolean(res.data?.has_more) && voices.length > 0;
          page++;
        } catch (error: any) {
          this.logger.warn(
            `Failed to fetch shared voices for query ${JSON.stringify(query)} page ${page}: ${error.message}`,
          );
          hasMore = false;
        }
      }

      if (page >= MAX_PAGES) {
        this.logger.warn(
          `Reached max page limit (${MAX_PAGES}) for query ${JSON.stringify(query)}`,
        );
      }
    }

    if (allVoices.length === 0) {
      this.logger.warn(`No shared voices found for languages: ${languageCodes.join(', ')}`);
      return [];
    }

    this.logger.log(`Fetched ${allVoices.length} shared voices for ${languageCodes.join(', ')}`);

    for (const voice of allVoices) {
      if (voice.voice_id && voice.public_owner_id) {
        this.sharedVoiceOrigins.set(voice.voice_id, {
          publicOwnerId: voice.public_owner_id,
          name: voice.name ?? voice.voice_id,
        });
      }
    }

    return allVoices.map((voice): ElevenLabsVoice => {
      const verifiedLanguages: VerifiedLanguage[] = Array.isArray(voice.verified_languages)
        ? voice.verified_languages
        : [];

      const matchedLanguage = verifiedLanguages.find(
        lang =>
          languageCodes.includes(lang.language) ||
          languageCodes.some(code => lang.locale?.startsWith(code)),
      );

      return {
        voice_id: voice.voice_id,
        public_owner_id: voice.public_owner_id,
        name: voice.name,
        category: voice.category || 'shared',
        description: voice.description || voice.descriptive || '',
        preview_url:
          matchedLanguage?.preview_url ||
          voice.preview_url ||
          verifiedLanguages?.[0]?.preview_url ||
          '',
        verified_languages: verifiedLanguages,
        labels: {
          language: languageCodes[0],
          gender: voice.gender || '',
          age: voice.age || '',
          accent: voice.accent || '',
          use_case: voice.use_case || '',
          source: 'shared_voice',
        },
        settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      };
    });
  }

  /**
   * Add a voice from the public Voice Library to this account's voice collection. Required before
   * a shared voice (one returned by `/shared-voices`, e.g. the Urdu voices from getUrduVoices) can
   * be used for TTS — until this is called, its voice_id only exists in the public catalog, not in
   * this account, which is why using it directly raises `voice_id_does_not_exist`.
   * @see https://elevenlabs.io/docs/api-reference/voices/add-shared (POST /v1/voices/add/{public_user_id}/{voice_id})
   */
  async addSharedVoiceToLibrary(
    publicOwnerId: string,
    voiceId: string,
    newName: string,
  ): Promise<string> {
    const res = await this.client.post(`/voices/add/${publicOwnerId}/${voiceId}`, {
      new_name: newName,
    });
    const addedVoiceId: string =
      typeof res.data?.voice_id === 'string' ? res.data.voice_id : voiceId;
    ElevenLabsTTSClient.knownVoiceIds.add(addedVoiceId);
    ElevenLabsTTSClient.knownInvalidVoiceIds.delete(addedVoiceId);
    this.voicesCache = { data: null, expiry: 0 }; // force a fresh /voices list on next fetch
    this.logger.log(`Added shared voice "${newName}" (${voiceId}) to account as ${addedVoiceId}`);
    return addedVoiceId;
  }

  /**
   * Make a voice usable for TTS: a no-op if it's already in this account, otherwise looks it up in
   * the cached Voice Library search results (populated by getUrduVoices/getHindiVoices) and adds it.
   * Throws if the voice isn't in this account and wasn't found in a prior shared-voice search —
   * call getUrduVoices()/getHindiVoices() (or a fresh search) first if the cache may be cold.
   */
  async ensureVoiceUsable(voiceId: string, displayName?: string): Promise<string> {
    if (await this.validateVoiceId(voiceId)) return voiceId;

    const origin = this.sharedVoiceOrigins.get(voiceId);
    if (!origin) {
      throw new Error(
        `Voice ${voiceId} is not in this ElevenLabs account and was not found in the shared-voice ` +
          `library cache. Fetch voices (GET /elevenlabs/voices) first, or this voice_id may not exist.`,
      );
    }

    return this.addSharedVoiceToLibrary(origin.publicOwnerId, voiceId, displayName ?? origin.name);
  }

  async getVoicesWithDefault(): Promise<{
    voices: {
      voice_id: string;
      name: string;
      category: string;
      isDefault: boolean;
      labels?: Record<string, string>;
      description?: string;
      preview_url?: string;
      available_for_tiers?: string[];
      settings?: {
        stability?: number;
        similarity_boost?: number;
      };
    }[];
    defaultVoiceId: string;
    defaultVoiceSource: 'agent' | 'config' | 'fallback';
  }> {
    try {
      const [voicesData, agentData] = await Promise.all([
        this.getVoices(),
        this.getAgent().catch(() => ({ voice_id: null })),
      ]);

      let defaultVoiceId: string;
      let defaultVoiceSource: 'agent' | 'config' | 'fallback';

      if (agentData.voice_id) {
        defaultVoiceId = agentData.voice_id;
        defaultVoiceSource = 'agent';
        this.logger.log(`Using agent's configured default voice: ${defaultVoiceId}`);
      } else if (this.defaultVoiceId) {
        defaultVoiceId = this.defaultVoiceId;
        defaultVoiceSource = 'config';
        this.logger.log(`Using system configured default voice: ${defaultVoiceId}`);
      } else if (voicesData.voices.length > 0) {
        defaultVoiceId = voicesData.voices[0].voice_id;
        defaultVoiceSource = 'fallback';
        this.logger.warn(`No default voice configured, using fallback: ${defaultVoiceId}`);
      } else {
        throw new Error('No voices available');
      }

      const voiceExists = voicesData.voices.some(v => v.voice_id === defaultVoiceId);
      if (!voiceExists && voicesData.voices.length > 0) {
        this.logger.warn(
          `Default voice ${defaultVoiceId} not found in available voices. ` +
            `Falling back to first available: ${voicesData.voices[0].voice_id}`,
        );
        defaultVoiceId = voicesData.voices[0].voice_id;
        defaultVoiceSource = 'fallback';
      }

      const voicesWithDefault = voicesData.voices.map(voice => ({
        ...voice,
        isDefault: voice.voice_id === defaultVoiceId,
      }));

      return {
        voices: voicesWithDefault,
        defaultVoiceId,
        defaultVoiceSource,
      };
    } catch (error: any) {
      this.logger.error(`Failed to fetch voices with default: ${error.message}`, error.stack);
      throw error;
    }
  }

  async updateAgent(): Promise<{
    agent_id: string;
    name: string;
    voice_id?: string;
    conversation_config?: any;
  }> {
    try {
      this.logger.log(`Updating agent configuration for ${this.agentId}`);
      const updatedConfig = {
        conversation_config: {
          turn: {
            turn_timeout: 5,
            soft_timeout_config: {
              timeout_seconds: 5,
              message: 'Hhmmmm...yeah give me a second...',
              use_llm_generated_message: false,
            },
          },
          tts: {
            model_id: 'eleven_turbo_v2',
            optimize_streaming_latency: 1,
            speed: 1,
            stability: 0.5,
            similarity_boost: 0.8,
          },
        },
      };
      const res = await this.client.patch(`/convai/agents/${this.agentId}`, updatedConfig);
      this.logger.log(`Successfully updated agent configuration`);
      return res.data;
    } catch (error: any) {
      this.logger.error(`Failed to update agent: ${error.message}`, error.stack);
      throw error;
    }
  }
}

function isTtsAccessDenied(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return msg.includes('403') || msg.includes('forbidden');
}

function isTtsVoiceInvalidMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('voice_id_does_not_exist') ||
    lower.includes('does not exist') ||
    lower.includes('invalid_voice') ||
    lower.includes('voice not found')
  );
}

function isTtsVoiceInvalid(error: Error): boolean {
  return isTtsVoiceInvalidMessage(error.message);
}
