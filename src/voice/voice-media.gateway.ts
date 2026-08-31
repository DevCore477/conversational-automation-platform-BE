import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocketGateway, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import WebSocket from 'ws';

import { metadataToCanonicalIso6391, transcriptMatchesExpectedLanguage } from './call-language';
import { getEffectiveFlow } from '../flows/flow-accessors';
import type { ConversationFlowJSON } from '../flows/types/flows.types';
import { ElevenLabsVoiceBridgeService } from './elevanlabs.voice-bridge-service.service';
import { CallStateService } from '../calls/services/call-state.service';
import { CallStatus } from '../calls/types/call-state.types';
import { STTTranscript } from '../clients/elevenlabs/elevanlabs-voice.client';
import { VoiceClientFactory } from '../clients/voice-client/voice-client.factory';
import { ISTTClient } from '../clients/voice-client/voice-client.interface';
import { mulawToPcm, upsample8kTo16k } from '../common/utils/audio-codec.util';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Telnyx Media Streaming (the only active call path): start.call_control_id, stream_id — see
 * Telnyx's Media Streaming over WebSockets docs. The `start.callSid`/`start.streamSid` branch below
 * is legacy Twilio Media Streams framing, kept only because this gateway's path predates
 * Telnyx-only operation; it is not exercised by any currently configured call path.
 */
function readStreamStartFields(msg: Record<string, unknown>): {
  callSid?: string;
  streamSid?: string;
} {
  const start = msg.start;
  if (!isRecord(start)) return {};

  const twilioCallSid = start.callSid;
  const twilioStreamSid = start.streamSid;
  if (typeof twilioCallSid === 'string' && twilioCallSid !== '') {
    return {
      callSid: twilioCallSid,
      streamSid:
        typeof twilioStreamSid === 'string' && twilioStreamSid !== ''
          ? twilioStreamSid
          : twilioCallSid,
    };
  }

  const telnyxCallControlId = start.call_control_id;
  const telnyxStreamId = msg.stream_id;
  if (typeof telnyxCallControlId === 'string' && telnyxCallControlId !== '') {
    const streamSid =
      typeof telnyxStreamId === 'string' && telnyxStreamId !== ''
        ? telnyxStreamId
        : telnyxCallControlId;
    return {
      callSid: `TLX_${telnyxCallControlId}`,
      streamSid,
    };
  }

  return {};
}

function readMediaPayload(msg: Record<string, unknown>): string | undefined {
  const media = msg.media;
  if (!isRecord(media)) return undefined;
  const payload = media.payload;
  return typeof payload === 'string' ? payload : undefined;
}

/** Telnyx `start.start.media_format` — inbound frames match this after streaming_start. */
function readTelnyxMediaFormat(msg: Record<string, unknown>): {
  encoding: string;
  sampleRate: number;
} | null {
  const start = msg.start;
  if (!isRecord(start)) return null;
  const mf = start.media_format;
  if (!isRecord(mf)) return null;
  const encoding = mf.encoding;
  const sr = mf.sample_rate;
  return {
    encoding: typeof encoding === 'string' ? encoding : 'PCMU',
    sampleRate: typeof sr === 'number' ? sr : 8000,
  };
}

function readTelnyxMediaTrack(msg: Record<string, unknown>): string | undefined {
  const media = msg.media;
  if (!isRecord(media)) return undefined;
  const t = media.track;
  return typeof t === 'string' ? t : undefined;
}

function rawDataToUtf8(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return '';
}

interface StreamState {
  streamSid: string;
  client: WebSocket;
  sttClient: ISTTClient | null;
  isProcessing: boolean;
  aiSpeaking: boolean;
  lastAiSpeechEnd: number;
  /** Set when user interrupted agent so we allow the next final transcript through */
  justInterrupted?: boolean;
  recentTranscripts: Map<string, number>;
  pendingAudio: Buffer[];
  /** Present for Telnyx: inbound encoding from `start.media_format` (must match STT decode path). */
  telnyxInboundFormat?: { encoding: string; sampleRate: number };
}

@WebSocketGateway({ path: '/ws/voice-media' })
export class VoiceMediaGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(VoiceMediaGateway.name);
  private callStates = new Map<string, StreamState>();

  /**
   * After agent audio ends, ignore inbound mic audio briefly so Twilio/phone echo is not sent to STT.
   * ElevenLabs realtime has VAD; Whisper batches need a longer guard (echo often transcribes as "you").
   * 40ms was too short — echo of the agent's last word arrives well after 40ms on real phone lines. */
  private readonly AI_COOLDOWN_MS = 300;

  constructor(
    private readonly callStateService: CallStateService,
    private readonly bridge: ElevenLabsVoiceBridgeService,
    private readonly configService: ConfigService,
    private readonly voiceClientFactory: VoiceClientFactory,
  ) {}

  private async waitForCallState(callSid: string, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const cs = this.callStateService.findOne(callSid);
      if (cs) return cs;
      await new Promise(r => setTimeout(r, 20));
    }
    return null;
  }

  handleConnection(client: WebSocket) {
    this.logger.log('🔥 Telnyx voice media WebSocket CONNECTED');

    let callSid: string | null = null;
    let streamSid: string | null = null;

    client.on('message', async (raw: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToUtf8(raw)) as unknown;
      } catch {
        return;
      }

      if (!isRecord(parsed)) return;
      const eventName = parsed.event;
      if (typeof eventName !== 'string') return;

      if (eventName === 'connected') {
        return;
      }

      if (eventName === 'start') {
        const { callSid: sid, streamSid: ssid } = readStreamStartFields(parsed);

        if (!sid) {
          this.logger.warn(
            '⚠️ Start event missing callSid (expected Twilio start.callSid or Telnyx start.call_control_id)',
          );
          return;
        }

        // Guard: 'both' target_legs (or a duplicate webhook) opens a second WebSocket
        // for the same call. The second connection would stream the agent's own TTS audio
        // back into STT, causing the agent to hear and respond to its own voice.
        if (this.callStates.has(sid)) {
          this.logger.warn(
            `⚠️ Duplicate WebSocket for ${sid} (streamSid=${ssid ?? sid}) — closing to prevent echo loop`,
          );
          client.close(1000, 'Duplicate stream — only one WebSocket per call allowed');
          return;
        }

        callSid = sid;
        streamSid = ssid ?? sid;

        this.logger.log(`▶️ start: callSid=${sid}, streamSid=${streamSid}`);

        const callState = await this.waitForCallState(sid);
        if (!callState) {
          this.logger.error(`❌ CallState not found for ${sid}`);
          return;
        }

        let telnyxFmt = sid.startsWith('TLX_') ? readTelnyxMediaFormat(parsed) : null;
        let telnyxFmtSource: 'websocket' | 'metadata' | null = telnyxFmt ? 'websocket' : null;
        if (
          !telnyxFmt &&
          sid.startsWith('TLX_') &&
          callState.metadata &&
          typeof callState.metadata === 'object'
        ) {
          const m = callState.metadata as Record<string, unknown>;
          if (m.telnyxBidirectionalCodec === 'L16') {
            const sr = m.telnyxInboundSampleRate;
            telnyxFmt = {
              encoding: 'L16',
              sampleRate: typeof sr === 'number' ? sr : 16000,
            };
            telnyxFmtSource = 'metadata';
          }
        }

        const state: StreamState = {
          streamSid: streamSid,
          client,
          sttClient: null,
          isProcessing: false,
          aiSpeaking: false,
          lastAiSpeechEnd: 0,
          recentTranscripts: new Map(),
          pendingAudio: [],
          ...(telnyxFmt
            ? {
                telnyxInboundFormat: {
                  encoding: telnyxFmt.encoding,
                  sampleRate: telnyxFmt.sampleRate,
                },
              }
            : {}),
        };

        this.callStates.set(sid, state);

        if (sid.startsWith('TLX_')) {
          if (telnyxFmt) {
            this.logger.log(
              `📥 Telnyx STT input (${telnyxFmtSource ?? 'unknown'}): ${telnyxFmt.encoding} @ ${String(telnyxFmt.sampleRate)} Hz`,
            );
          } else {
            this.logger.warn(
              '⚠️ Telnyx inbound format unknown — STT assumes μ-law 8 kHz (wrong if stream is L16)',
            );
          }
        }

        const langMeta = callState.metadata?.language;
        const expectedLang = typeof langMeta === 'string' ? langMeta : 'en';
        const flowForStt = this.readFlowFromCallMetadata(callState.metadata);

        this.callStateService.updateStatus(sid, CallStatus.ACTIVE);

        // Initialize ElevenLabs STT with call's expected language so STT favors it and ignores other-language background
        // try {
        //   await this.initializeSTT(state, sid, expectedLang, flowForStt);
        // } catch (err: unknown) {
        //   this.logger.error(`❌ Failed to initialize STT for ${sid}:`, err);
        // }
        void this.initializeSTT(state, sid, expectedLang, flowForStt).catch((err: unknown) => {
          this.logger.error(`❌ Failed to initialize STT for ${sid}:`, err);
        });

        // Start the voice bridge
        try {
          await this.bridge.start(sid, state.streamSid, client, {
            onTtsStart: cid => {
              this.markAiSpeaking(cid, true);
            },
            onTtsEnd: cid => {
              this.markAiSpeaking(cid, false);
            },
            onInterruption: cid => {
              const s = this.callStates.get(cid);
              if (s) {
                s.justInterrupted = true;
                s.aiSpeaking = false;
                s.lastAiSpeechEnd = Date.now();
              }
            },
          });

          this.logger.log(`✅ Bridge started for ${sid}`);
        } catch (err: unknown) {
          this.logger.error(`❌ Bridge start failed:`, err);
        }
        return;
      }

      if (eventName === 'media' && callSid) {
        this.processAudioChunk(callSid, parsed);
        return;
      }

      if (eventName === 'stop' && callSid) {
        this.logger.log(
          `⏹️ Received 'stop' frame from telephony provider for ${callSid} — the provider ended the media stream`,
        );
        this.cleanupCall(callSid, 'provider_sent_stream_stop');
        return;
      }
    });

    client.on('close', () => {
      if (callSid) {
        this.logger.log(`🔌 Media WebSocket closed by peer for ${callSid}`);
        this.cleanupCall(callSid, 'websocket_closed');
        this.callStateService.updateStatus(callSid, CallStatus.COMPLETED);
      }
    });

    client.on('error', e => {
      this.logger.error('❌ Voice media WS error:', e);
    });
  }

  private readFlowFromCallMetadata(metadata: unknown): ConversationFlowJSON | undefined {
    if (!metadata || typeof metadata !== 'object') return undefined;
    const flowRaw = (metadata as { flow?: unknown }).flow;
    if (!flowRaw) return undefined;
    try {
      return getEffectiveFlow(flowRaw);
    } catch {
      return undefined;
    }
  }

  private async initializeSTT(
    state: StreamState,
    callSid: string,
    expectedLanguage?: string,
    flow?: ConversationFlowJSON,
  ): Promise<void> {
    const languageCode = metadataToCanonicalIso6391(expectedLanguage);
    const sttClient: ISTTClient = this.voiceClientFactory.createSTTClient(languageCode, flow);

    // Handle partial transcripts: always send to bridge so it can apply per-node interruption_sensitivity
    sttClient.on('partial', (transcript: STTTranscript) => {
      if (transcript.text) {
        this.logger.debug(`📝 Partial for ${callSid}: "${transcript.text}"`);

        void Promise.resolve(this.bridge.processPartialTranscript(callSid, transcript.text)).catch(
          (err: unknown) => {
            this.logger.error(`❌ Bridge partial error for ${callSid}:`, err);
          },
        );
      }
    });
    // Handle final transcripts
    sttClient.on('transcript', (transcript: STTTranscript) => {
      if (transcript.isFinal && transcript.text) {
        this.handleTranscript(callSid, transcript.text, transcript.language);
      }
    });

    // Handle Silence detection - useful for debugging and potential future features
    sttClient.on('silence', () => {
      this.logger.debug(`🔇 Silence detected for ${callSid}`);
      void Promise.resolve(this.bridge.handleSilence(callSid)).catch((err: unknown) => {
        this.logger.error(`❌ Bridge silence error for ${callSid}:`, err);
      });
    });

    sttClient.on('error', err => {
      this.logger.error(`❌ STT error for ${callSid}:`, err);
    });

    sttClient.on('ready', () => {
      this.logger.log(`✅ STT ready (${this.voiceClientFactory.getMode()}) for ${callSid}`);
    });

    state.sttClient = sttClient;

    await sttClient.connect();

    if (state.pendingAudio.length > 0 && sttClient.isReady()) {
      const pending = state.pendingAudio.splice(0);
      for (const chunk of pending) {
        sttClient.sendAudio(chunk);
      }
      this.logger.log(`🎧 Flushed ${pending.length} buffered audio chunks to STT for ${callSid}`);
    }

    this.logger.log(`✅ STT connected (${this.voiceClientFactory.getMode()}) for ${callSid}`);
  }

  private processAudioChunk(callSid: string, msg: Record<string, unknown>) {
    const state = this.callStates.get(callSid);
    if (!state) {
      this.logger.debug(`⚠️ No state for ${callSid}`);
      return;
    }

    const track = readTelnyxMediaTrack(msg);
    if (track === 'outbound') {
      return;
    }

    const payload = readMediaPayload(msg);
    if (!payload) return;

    const now = Date.now();

    // Skip if AI is speaking (cooldown period)
    // if (state.aiSpeaking) {
    //   return;
    // }

    // AI cooldown check
    if (now - state.lastAiSpeechEnd < this.AI_COOLDOWN_MS) {
      return;
    }

    try {
      const raw = Buffer.from(payload, 'base64');
      let pcm16k: Buffer;

      if (callSid.startsWith('TLX_') && state.telnyxInboundFormat) {
        const { encoding, sampleRate } = state.telnyxInboundFormat;
        const enc = encoding.toUpperCase();

        if (enc === 'L16' || enc === 'LINEAR16') {
          pcm16k = sampleRate === 8000 ? upsample8kTo16k(raw) : raw;
        } else {
          const pcm8k = mulawToPcm(raw);
          pcm16k = upsample8kTo16k(pcm8k);
        }
      } else {
        const pcm8k = mulawToPcm(raw);
        pcm16k = upsample8kTo16k(pcm8k);
      }

      if (state.sttClient?.isReady()) {
        state.sttClient.sendAudio(pcm16k);
      } else {
        state.pendingAudio.push(pcm16k);
        if (state.pendingAudio.length > 50) {
          state.pendingAudio.shift();
        }
      }
    } catch (err: unknown) {
      this.logger.error(`❌ Audio processing error for ${callSid}:`, err);
    }
  }

  private handleTranscript(callSid: string, transcript: string, language?: string) {
    const state = this.callStates.get(callSid);
    if (!state) return;

    const callState = this.callStateService.findOne(callSid);
    const langRaw = callState?.metadata?.language;
    const expectedLanguage = typeof langRaw === 'string' ? langRaw : 'en';
    const acceptAnyLanguage = this.voiceClientFactory.isSttMultilingualEnabled();
    if (!transcriptMatchesExpectedLanguage(language, expectedLanguage, acceptAnyLanguage)) {
      this.logger.debug(
        `⏭️ Ignoring transcript — wrong language (expected ${expectedLanguage}, got ${language ?? 'unknown'}) for ${callSid}`,
      );
      return;
    }

    // Allow barge-in utterance through; otherwise drop transcripts that arrive while agent
    // is still speaking (echo of agent's own voice committed by STT's VAD) — unless this final
    // transcript itself clears the same barge-in bar partials use (onset grace + min length), in
    // which case a real interruption slipped past the partial-driven path and must not be lost.
    if (state.justInterrupted) {
      state.justInterrupted = false;
    } else if (state.aiSpeaking) {
      if (this.bridge.isFinalTranscriptEligibleForBargeIn(callSid, transcript)) {
        this.logger.log(
          `✋ Final transcript qualifies as barge-in for ${callSid}: "${transcript}"`,
        );
        this.bridge.handleInterruption(callSid);
      } else {
        this.logger.debug(`⏭️ Ignoring final transcript — agent is speaking (likely echo)`);
        return;
      }
    }

    // Duplicate detection (within last 2 seconds)
    const now = Date.now();
    const recent = state.recentTranscripts;

    for (const [text, time] of recent.entries()) {
      if (now - time > 2000) recent.delete(text);
    }

    const normalizedText = transcript.toLowerCase().trim();
    if (recent.has(normalizedText)) {
      this.logger.debug(`⏭️ Duplicate transcript ignored for ${callSid}`);
      return;
    }

    recent.set(normalizedText, now);

    // Check for echo (if transcript matches recent AI speech)
    if (this.isLikelyEcho(transcript, state)) {
      this.logger.log(`🔄 Filtered likely echo transcript: "${transcript}"`);
      return;
    }

    this.logger.log(`🗣️ User (${callSid}): "${transcript}"`);

    // Send to bridge for processing
    state.isProcessing = true;
    this.bridge
      .processUserTranscript(callSid, transcript, language)
      .then(() => {
        this.logger.log(`✅ Bridge processed transcript for ${callSid}`);
      })
      .catch((err: unknown) => {
        this.logger.error(`❌ Bridge error for ${callSid}:`, err);
      })
      .finally(() => {
        state.isProcessing = false;
      });
  }

  /**
   * Detect if transcript is likely echo/AI playback
   */
  private isLikelyEcho(transcript: string, state: StreamState): boolean {
    const lower = transcript.toLowerCase().trim();
    const timeSinceAi = Date.now() - state.lastAiSpeechEnd;

    // If transcript comes very soon after AI stopped speaking
    if (timeSinceAi < 1000) {
      // Single words that are likely the AI's own speech
      const echoWords = ['great', 'okay', 'yes', 'no', 'hello', 'hi', 'thanks', 'goodbye'];
      if (lower.split(' ').length === 1 && echoWords.includes(lower)) {
        return true;
      }
    }

    return false;
  }

  public markAiSpeaking(callSid: string, speaking: boolean) {
    const state = this.callStates.get(callSid);
    if (!state) return;

    const wasSpeaking = state.aiSpeaking;
    state.aiSpeaking = speaking;

    if (!speaking && wasSpeaking) {
      state.lastAiSpeechEnd = Date.now();
      // REMOVED: state.sttClient?.discardBufferedAudio?.();
      // Only discard on interruption, not normal speech end
      this.logger.log(`🤖 AI finished for ${callSid}`);
    } else if (speaking) {
      this.logger.log(`🤖 AI started for ${callSid}`);
    }
  }

  /**
   * Handle interruption - stop AI speech and reset STT
   */
  handleInterruption(callSid: string, transcriptSoFar?: string): void {
    const state = this.callStates.get(callSid);
    if (!state) return;

    this.logger.log(`✋ Interruption for ${callSid}: "${transcriptSoFar ?? ''}"`);

    state.aiSpeaking = false;
    state.justInterrupted = true;
    state.lastAiSpeechEnd = Date.now();

    this.bridge.handleInterruption(callSid, transcriptSoFar);
  }

  private cleanupCall(callSid: string, reason: string) {
    const state = this.callStates.get(callSid);
    if (!state) return;

    this.logger.log(
      `🧹 Cleaning up ${callSid} (reason: ${reason})\n${new Error('cleanupCall stack').stack ?? ''}`,
    );

    // Disconnect STT
    if (state.sttClient) {
      state.sttClient.disconnect();
    }

    this.callStates.delete(callSid);
    this.bridge.stop(callSid, reason);
  }

  handleDisconnect() {
    this.logger.log('👋 Voice media WebSocket DISCONNECTED');
  }
}
