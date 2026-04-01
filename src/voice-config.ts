/**
 * Voice configuration for super-agent channel.
 * Config lives in openclaw.json → channels["super-agent"].voice
 */

import type { DoubaoTTSConfig } from "./voice-tts.js";
import type { DoubaoASRConfig } from "./voice-asr.js";

export interface VoiceConfig {
  /** Doubao API Key (shared by TTS + ASR) */
  apiKey?: string;
  /** TTS resource ID, default "seed-tts-1.0" */
  resourceId?: string;
  /** TTS voice type ID */
  voiceType?: string;
  /** Audio format: mp3 | pcm, default "mp3" */
  audioFormat?: string;
  /** Sample rate, default 24000 */
  sampleRate?: number;
  /** ASR language, default "zh-CN" */
  language?: string;
}

export function resolveVoiceConfig(channelCfg: Record<string, unknown>): VoiceConfig {
  const raw = (channelCfg.voice ?? {}) as Record<string, unknown>;
  return {
    apiKey: raw.apiKey as string | undefined,
    resourceId: (raw.resourceId as string | undefined) ?? "seed-tts-1.0",
    voiceType: (raw.voiceType as string | undefined) ?? "zh_female_shuangkuaisisi_moon_bigtts",
    audioFormat: (raw.audioFormat as string | undefined) ?? "mp3",
    sampleRate: (raw.sampleRate as number | undefined) ?? 24000,
    language: (raw.language as string | undefined) ?? "zh-CN",
  };
}

export function buildTTSConfig(voice: VoiceConfig): DoubaoTTSConfig | null {
  if (!voice.apiKey) return null;
  return {
    apiKey: voice.apiKey,
    resourceId: voice.resourceId!,
    voiceType: voice.voiceType!,
    format: voice.audioFormat,
    sampleRate: voice.sampleRate,
  };
}

export function buildASRConfig(voice: VoiceConfig): DoubaoASRConfig | null {
  if (!voice.apiKey) return null;
  return {
    apiKey: voice.apiKey,
    language: voice.language ?? "zh-CN",
  };
}
