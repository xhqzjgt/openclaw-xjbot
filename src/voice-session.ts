/**
 * Voice session management for super-agent channel.
 * Manages the lifecycle of a single voice call: idle → listening → thinking → speaking → idle
 */

import { transcribePCM, type DoubaoASRConfig } from "./voice-asr.js";
import { DoubaoTTS, type DoubaoTTSConfig } from "./voice-tts.js";

export type VoiceState = "listening" | "thinking" | "speaking" | "idle";

export interface VoiceSessionCallbacks {
  onStatus: (state: VoiceState) => void;
  onTranscript: (text: string) => void;
  onAudioChunk: (data: Buffer) => void;
  onAudioEnd: () => void;
  onError: (message: string) => void;
}

export interface VoiceSessionConfig {
  asrConfig: DoubaoASRConfig;
  ttsConfig: DoubaoTTSConfig;
  processText: (text: string) => Promise<string>;
}

export class VoiceSession {
  private pcmChunks: Buffer[] = [];
  private state: VoiceState = "idle";
  private tts: DoubaoTTS;
  private destroyed = false;
  private interruptSignal = { aborted: false };
  private processingPromise: Promise<void> | null = null;

  constructor(
    readonly sessionId: string,
    private cfg: VoiceSessionConfig,
    private callbacks: VoiceSessionCallbacks,
    private log: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void }
  ) {
    this.tts = new DoubaoTTS(cfg.ttsConfig);
  }

  handlePcm(data: Buffer): void {
    if (this.destroyed) return;
    this.pcmChunks.push(data);
  }

  async handleSpeechEnd(): Promise<void> {
    if (this.destroyed) return;
    if (this.state !== "idle" && this.state !== "listening") return;

    const pcmBuffer = Buffer.concat(this.pcmChunks);
    this.pcmChunks = [];

    this.processingPromise = this.runPipeline(pcmBuffer);
    await this.processingPromise;
  }

  private async runPipeline(pcmBuffer: Buffer): Promise<void> {
    try {
      // Step 1: ASR
      this.setState("thinking");
      const log = this.log;

      if (pcmBuffer.length === 0) {
        log.warn(`[voice-session:${this.sessionId}] empty PCM buffer, skipping`);
        this.setState("idle");
        return;
      }

      log.info(`[voice-session:${this.sessionId}] transcribing ${pcmBuffer.length} bytes`);
      const text = await transcribePCM(pcmBuffer, this.cfg.asrConfig, {
        info: (s) => log.info(s),
        error: (s) => log.error(s),
      });

      if (this.destroyed) return;

      if (!text || text.trim() === "") {
        log.info(`[voice-session:${this.sessionId}] empty transcript, skipping`);
        this.setState("idle");
        return;
      }

      this.callbacks.onTranscript(text);
      log.info(`[voice-session:${this.sessionId}] transcript: "${text}"`);

      // Step 2: Agent processing
      const reply = await this.cfg.processText(text);

      if (this.destroyed || this.interruptSignal.aborted) {
        this.setState("idle");
        return;
      }

      if (!reply || reply.trim() === "") {
        log.info(`[voice-session:${this.sessionId}] empty agent reply, skipping TTS`);
        this.setState("idle");
        return;
      }

      // Step 3: TTS
      this.setState("speaking");
      this.interruptSignal = { aborted: false };

      log.info(`[voice-session:${this.sessionId}] synthesizing: "${reply.slice(0, 80)}..."`);
      await this.tts.synthesize(reply, (chunk) => {
        if (!this.destroyed && !this.interruptSignal.aborted) {
          this.callbacks.onAudioChunk(chunk);
        }
      }, this.interruptSignal);

      if (this.destroyed) return;

      this.callbacks.onAudioEnd();
      this.setState("idle");
    } catch (err) {
      if (this.destroyed) return;
      const msg = String(err);
      this.log.error(`[voice-session:${this.sessionId}] pipeline error: ${msg}`);
      this.callbacks.onError(msg);
      this.setState("idle");
    }
  }

  handleInterrupt(): void {
    if (this.destroyed) return;
    this.log.info(`[voice-session:${this.sessionId}] interrupted`);
    this.interruptSignal.aborted = true;
    if (this.state === "speaking") {
      this.setState("idle");
    }
  }

  private setState(state: VoiceState): void {
    if (this.destroyed) return;
    this.state = state;
    this.callbacks.onStatus(state);
  }

  get currentState(): VoiceState {
    return this.state;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.interruptSignal.aborted = true;
    this.pcmChunks = [];
    try {
      await this.tts.disconnect();
    } catch {}
  }
}
