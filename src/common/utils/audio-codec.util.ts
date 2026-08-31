/**
 * Audio codec utilities for Twilio (μ-law 8 kHz) ↔ ElevenLabs (PCM 16 kHz).
 * Used by the voice bridge to convert between formats.
 */

const BIAS = 0x84;

function muLawEncode(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  sample = Math.min(sample + BIAS, 0x7fff);

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0; expMask >>= 1) exponent--;

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawDecode(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80 ? -1 : 1;
  const exponent = (u >> 4) & 7;
  const mantissa = u & 0xf;
  return sign * (((mantissa << 3) + BIAS) << exponent) - BIAS;
}

/** μ-law buffer → 16-bit PCM (same sample rate). */
export function mulawToPcm(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    out.writeInt16LE(muLawDecode(buf[i]), i * 2);
  }
  return out;
}

/** 16-bit PCM → μ-law. */
export function pcm16ToMulaw(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = muLawEncode(buf.readInt16LE(i * 2));
  }
  return out;
}

/** Upsample PCM from 8 kHz to 16 kHz (duplicate each sample). */
export function upsample8kTo16k(pcm8k: Buffer): Buffer {
  const sampleCount = Math.floor(pcm8k.length / 2);
  const out = Buffer.alloc(sampleCount * 4);
  let outIndex = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm8k.readInt16LE(i * 2);
    out.writeInt16LE(sample, outIndex);
    out.writeInt16LE(sample, outIndex + 2);
    outIndex += 4;
  }
  return out;
}

/**
 * Downsample PCM from 16 kHz to 8 kHz.
 * Averages each pair of samples (simple anti-alias filter) instead of dropping every other
 * sample — plain decimation folds energy above 4kHz back into the audible band as buzzy/harsh
 * artifacts on every Twilio (8kHz) call.
 */
export function downsample16kTo8k(pcm16k: Buffer): Buffer {
  const sampleCount = Math.floor(pcm16k.length / 2);
  const outSamples = Math.floor(sampleCount / 2);
  const out = Buffer.alloc(outSamples * 2);
  let outIndex = 0;
  for (let i = 0; i < outSamples; i++) {
    const inSampleOffset = i * 4;
    if (inSampleOffset + 1 >= pcm16k.length) break;
    const s0 = pcm16k.readInt16LE(inSampleOffset);
    const s1 =
      inSampleOffset + 3 < pcm16k.length ? pcm16k.readInt16LE(inSampleOffset + 2) : s0;
    out.writeInt16LE(Math.round((s0 + s1) / 2), outIndex);
    outIndex += 2;
  }
  return out;
}

/**
 * Linear resample 16-bit mono PCM from inRate to outRate.
 */
export function resamplePcm16Mono(pcm: Buffer, inRate: number, outRate: number): Buffer {
  if (inRate === outRate || pcm.length < 2) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  const ratio = outRate / inRate;
  const outSamples = Math.max(1, Math.floor(inSamples * ratio));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const t = srcPos - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    const s = Math.round(s0 + (s1 - s0) * t);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return out;
}

/** WAVE_FORMAT_PCM */
const WAVE_FORMAT_PCM = 0x0001;
/** WAVE_FORMAT_IEEE_FLOAT — common for PyTorch / Chatterbox WAV export */
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;

function float32StereoToMonoInt16(raw: Buffer, channels: number, sampleRate: number): Buffer {
  const bytesPerFrame = 4 * channels;
  const numFrames = Math.floor(raw.length / bytesPerFrame);
  const mono = Buffer.alloc(numFrames * 2);
  for (let i = 0; i < numFrames; i++) {
    const off = i * bytesPerFrame;
    let f = raw.readFloatLE(off);
    if (channels === 2) {
      f = (f + raw.readFloatLE(off + 4)) / 2;
    }
    const s = Math.max(-32768, Math.min(32767, Math.round(f * 32767)));
    mono.writeInt16LE(s, i * 2);
  }
  return resamplePcm16Mono(mono, sampleRate, 16000);
}

/**
 * Parse a WAV buffer to 16 kHz 16-bit mono PCM (for Twilio pipeline after Chatterbox / local TTS).
 * Supports PCM 16-bit and IEEE float 32-bit (Chatterbox often writes float WAV).
 */
export function wavBufferToPcm16kMono(wav: Buffer): Buffer {
  if (wav.length < 44) return Buffer.alloc(0);

  let offset = 12;
  let wFormatTag = WAVE_FORMAT_PCM;
  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = 0;
  let dataLength = 0;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;
    if (chunkId === 'fmt ') {
      wFormatTag = wav.readUInt16LE(chunkDataStart + 0);
      channels = wav.readUInt16LE(chunkDataStart + 2);
      sampleRate = wav.readUInt32LE(chunkDataStart + 4);
      bitsPerSample = wav.readUInt16LE(chunkDataStart + 14);
    }
    if (chunkId === 'data') {
      dataStart = chunkDataStart;
      dataLength = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
  }

  if (!dataStart || !dataLength) {
    return Buffer.alloc(0);
  }

  const raw = wav.subarray(dataStart, Math.min(dataStart + dataLength, wav.length));

  // IEEE float 32-bit (Chatterbox / many ML stacks)
  if (wFormatTag === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    if (channels !== 1 && channels !== 2) {
      return Buffer.alloc(0);
    }
    return float32StereoToMonoInt16(raw, channels, sampleRate);
  }

  // Integer PCM 16-bit
  if (wFormatTag === WAVE_FORMAT_PCM && bitsPerSample === 16) {
    let pcm = raw;
    if (channels === 2) {
      const samplePairs = Math.floor(pcm.length / 4);
      const mono = Buffer.alloc(samplePairs * 2);
      for (let i = 0; i < samplePairs; i++) {
        const l = pcm.readInt16LE(i * 4);
        const r = pcm.readInt16LE(i * 4 + 2);
        mono.writeInt16LE(Math.round((l + r) / 2), i * 2);
      }
      pcm = mono;
    } else if (channels !== 1) {
      return Buffer.alloc(0);
    }
    return resamplePcm16Mono(pcm, sampleRate, 16000);
  }

  return Buffer.alloc(0);
}
