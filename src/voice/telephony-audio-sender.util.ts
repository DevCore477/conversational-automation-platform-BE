import { downsample16kTo8k, pcm16ToMulaw } from '../common/utils/audio-codec.util';

/**
 * Real-time frame pacing/draining for outbound TTS audio to Twilio (μ-law 8kHz) and Telnyx (L16
 * 16kHz). Extracted from `ElevenLabsVoiceBridgeService` — this only touches per-call audio buffers
 * and timers, not conversation/flow state, so it can move without touching turn-taking logic.
 *
 * Structural typing: functions here accept the minimal slice of `CallSession` they actually read
 * or mutate (see `TelephonyDrainSession`) rather than the full session type, so the real
 * `CallSession` object satisfies it with no adapter — passed by reference, mutated in place exactly
 * as before.
 */

/** Twilio Media Streams expect 20ms chunks = 160 bytes μ-law 8kHz. Must send at ~20ms intervals or playback fails. */
const TWILIO_CHUNK_BYTES = 160;
const TWILIO_CHUNK_INTERVAL_MS = 20;
/** Telnyx L16 mono 16kHz: 20ms = 320 samples × 2 bytes = 640 bytes (matches streaming_start L16/16000). */
const TELNYX_L16_CHUNK_BYTES = 640;
const TELNYX_L16_CHUNK_INTERVAL_MS = 20;

export interface TelephonyDrainSession {
  callSid: string;
  streamSid: string;
  twilioWs: { send(data: string): void };
  twilioMulawPending?: Buffer;
  twilioDrainActive?: boolean;
  telnyxPcm16Pending?: Buffer;
  telnyxL16DrainIntervalId?: NodeJS.Timeout;
}

export interface TelephonyDrainHooks {
  /** Whether the call session is still live — drain loops stop once it isn't. */
  isSessionAlive(callSid: string): boolean;
  onError(message: string, err: unknown): void;
}

/**
 * Send one 20ms audio frame to Twilio.
 *
 * Mark messages are sent separately, once per drained segment (see {@link sendTwilioMark}) —
 * sending one per 20ms frame doubled WS message volume on the exact path whose timing precision
 * matters most, and isn't required by Twilio (only the ~20ms media cadence is).
 */
function sendTwilioMediaFrame(session: TelephonyDrainSession, mulawChunk: Buffer): void {
  session.twilioWs.send(
    JSON.stringify({
      event: 'media',
      streamSid: session.streamSid,
      media: { payload: mulawChunk.toString('base64') },
    }),
  );
}

/** Twilio acknowledges this with a `mark` event when playback catches up to it. */
function sendTwilioMark(session: TelephonyDrainSession): void {
  const markName = `audio_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
  session.twilioWs.send(
    JSON.stringify({
      event: 'mark',
      streamSid: session.streamSid,
      mark: { name: markName },
    }),
  );
}

/**
 * Telnyx bidirectional RTP (L16): Pipecat and Telnyx docs use only `event` + `media.payload` (no
 * `stream_id` on outbound — extra fields can misroute audio).
 */
function sendTelnyxL16MediaFrame(session: TelephonyDrainSession, pcm16LeChunk: Buffer): void {
  session.twilioWs.send(
    JSON.stringify({
      event: 'media',
      media: { payload: pcm16LeChunk.toString('base64') },
    }),
  );
}

/**
 * Queue TTS audio for the telephony provider and drain at real-time rate. Sending the entire
 * buffer in one `media` event often results in no audible playback.
 */
export function queueAudioForTelephony(
  session: TelephonyDrainSession,
  pcm16kBuffer: Buffer,
  hooks: TelephonyDrainHooks,
): void {
  try {
    if (session.callSid.startsWith('TLX_')) {
      session.telnyxPcm16Pending = Buffer.concat([
        session.telnyxPcm16Pending ?? Buffer.alloc(0),
        pcm16kBuffer,
      ]);
      ensureTelnyxL16MediaDrain(session, hooks);
      return;
    }
    const pcm8k = downsample16kTo8k(pcm16kBuffer);
    const mulaw8k = pcm16ToMulaw(pcm8k);
    session.twilioMulawPending = Buffer.concat([
      session.twilioMulawPending ?? Buffer.alloc(0),
      mulaw8k,
    ]);
    scheduleTwilioMediaDrain(session, hooks);
  } catch (error) {
    hooks.onError(`❌ Error sending audio to telephony provider for ${session.callSid}:`, error);
  }
}

export function stopTelnyxL16MediaDrain(session: TelephonyDrainSession): void {
  if (session.telnyxL16DrainIntervalId) {
    clearInterval(session.telnyxL16DrainIntervalId);
    session.telnyxL16DrainIntervalId = undefined;
  }
}

/**
 * Telnyx RTP expects one L16 frame per 20ms. Chained setTimeout + "send immediately on refill"
 * violates that cadence when TTS arrives in bursts (speedups / gaps / glitches). Use a steady 20ms
 * timer while the queue has at least one full frame.
 */
export function ensureTelnyxL16MediaDrain(
  session: TelephonyDrainSession,
  hooks: TelephonyDrainHooks,
): void {
  const trySendOne = (): void => {
    const pending = session.telnyxPcm16Pending;
    if (!pending || pending.length < TELNYX_L16_CHUNK_BYTES) return;
    const rest = pending.subarray(TELNYX_L16_CHUNK_BYTES);
    const chunk = pending.subarray(0, TELNYX_L16_CHUNK_BYTES);
    session.telnyxPcm16Pending = rest;
    try {
      sendTelnyxL16MediaFrame(session, chunk);
    } catch (e) {
      hooks.onError(`❌ Telnyx L16 media send failed for ${session.callSid}:`, e);
      stopTelnyxL16MediaDrain(session);
    }
  };

  if (session.telnyxL16DrainIntervalId) return;
  trySendOne();
  const after = session.telnyxPcm16Pending;
  if (!after || after.length < TELNYX_L16_CHUNK_BYTES) return;

  session.telnyxL16DrainIntervalId = setInterval(() => {
    if (!hooks.isSessionAlive(session.callSid)) {
      stopTelnyxL16MediaDrain(session);
      return;
    }
    trySendOne();
    const rest = session.telnyxPcm16Pending;
    if (!rest || rest.length < TELNYX_L16_CHUNK_BYTES) {
      stopTelnyxL16MediaDrain(session);
    }
  }, TELNYX_L16_CHUNK_INTERVAL_MS);
}

/**
 * Send pending μ-law in 160-byte frames every 20ms.
 * Uses setTimeout chain (maintains existing pattern but ensures no drift).
 */
export function scheduleTwilioMediaDrain(
  session: TelephonyDrainSession,
  hooks: TelephonyDrainHooks,
): void {
  if (session.twilioDrainActive) return;
  session.twilioDrainActive = true;

  const startTime = Date.now();
  let chunkIndex = 0;

  const tick = (): void => {
    const pending = session.twilioMulawPending;
    if (!pending || pending.length < TWILIO_CHUNK_BYTES) {
      session.twilioDrainActive = false;
      return;
    }

    const chunk = pending.subarray(0, TWILIO_CHUNK_BYTES);
    session.twilioMulawPending = pending.subarray(TWILIO_CHUNK_BYTES);

    try {
      sendTwilioMediaFrame(session, chunk);
    } catch (e) {
      hooks.onError(`❌ Twilio send failed for ${session.callSid}:`, e);
      session.twilioDrainActive = false;
      return;
    }

    chunkIndex++;
    const nextTime = startTime + chunkIndex * TWILIO_CHUNK_INTERVAL_MS;
    const delay = Math.max(0, nextTime - Date.now());

    if (session.twilioMulawPending.length >= TWILIO_CHUNK_BYTES) {
      setTimeout(tick, delay);
    } else {
      session.twilioDrainActive = false;
      try {
        sendTwilioMark(session);
      } catch (e) {
        hooks.onError(`❌ Twilio mark send failed for ${session.callSid}:`, e);
      }
    }
  };

  tick();
}

/** Linear ramp last sample → silence for L16 tail pad (reduces zipper noise vs hard zeros). */
export function padTelnyxL16PartialFrame(pending: Buffer): Buffer {
  const frame = TELNYX_L16_CHUNK_BYTES;
  const rem = pending.length % frame;
  if (rem === 0) return pending;
  const padLen = frame - rem;
  const pad = Buffer.alloc(padLen);
  let last = 0;
  if (pending.length >= 2) {
    last = pending.readInt16LE(pending.length - 2);
  }
  for (let i = 0; i < padLen; i += 2) {
    const t = (i + 2) / padLen;
    const s = Math.max(-32768, Math.min(32767, Math.round(last * (1 - t))));
    pad.writeInt16LE(s, i);
  }
  return Buffer.concat([pending, pad]);
}

/** Pad last partial frame and drain so the tail is played. */
export function flushTwilioPendingAudio(
  session: TelephonyDrainSession,
  hooks: TelephonyDrainHooks,
): void {
  if (session.callSid.startsWith('TLX_')) {
    const pending = session.telnyxPcm16Pending;
    if (!pending?.length) return;
    const rem = pending.length % TELNYX_L16_CHUNK_BYTES;
    if (rem === 0) {
      ensureTelnyxL16MediaDrain(session, hooks);
      return;
    }
    session.telnyxPcm16Pending = padTelnyxL16PartialFrame(pending);
    ensureTelnyxL16MediaDrain(session, hooks);
    return;
  }
  const pending = session.twilioMulawPending;
  if (!pending?.length) return;
  const rem = pending.length % TWILIO_CHUNK_BYTES;
  if (rem === 0) {
    scheduleTwilioMediaDrain(session, hooks);
    return;
  }
  const padLen = TWILIO_CHUNK_BYTES - rem;
  session.twilioMulawPending = Buffer.concat([pending, Buffer.alloc(padLen, 0xff)]);
  scheduleTwilioMediaDrain(session, hooks);
}
