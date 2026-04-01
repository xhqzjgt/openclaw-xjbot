/**
 * Voice session management for super-agent channel.
 * Manages the lifecycle of a single voice call: idle → listening → thinking → speaking → idle
 *
 * Full streaming pipeline:
 * - ASR: PCM chunks are streamed to ASR as they arrive (no buffering)
 * - Agent: text is processed and streamed back
 * - TTS: Agent text chunks are fed to TTS as they arrive
 */

import { DoubaoASR, type DoubaoASRConfig } from "./voice-asr.js";
import { DoubaoTTS, type DoubaoTTSConfig, type TTSStreamHandle } from "./voice-tts.js";

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
  /**
   * Process transcribed text through the Agent pipeline.
   * Calls onTextChunk for each text chunk as it arrives from the Agent.
   * The returned promise resolves when the Agent is done producing text.
   */
  processText: (text: string, onTextChunk: (chunk: string) => void) => Promise<void>;
}

export class VoiceSession {
  private state: VoiceState = "idle";
  private tts: DoubaoTTS;
  private asr: DoubaoASR | null = null;
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

  /**
   * Start streaming ASR session. Called when voice.start arrives.
   * After this, handlePcm() sends audio directly to ASR.
   */
  async startListening(): Promise<void> {
    if (this.destroyed) return;

    this.asr = new DoubaoASR(this.cfg.asrConfig, {
      info: (s) => this.log.info(s),
      error: (s) => this.log.error(s),
    });

    await this.asr.start((partialText) => {
      // Send partial transcripts to the client for real-time display
      if (!this.destroyed && partialText) {
        this.callbacks.onTranscript(partialText);
      }
    });

    this.log.info(`[voice-session:${this.sessionId}] ASR started, streaming PCM`);
  }

  /** Send PCM chunk directly to ASR — no buffering. */
  handlePcm(data: Buffer): void {
    if (this.destroyed) return;
    if (this.asr) {
      this.asr.feedPCM(data);
    }
  }

  /** User stopped speaking — finalize ASR and run Agent→TTS pipeline. */
  async handleSpeechEnd(): Promise<void> {
    if (this.destroyed) return;
    if (this.state !== "idle" && this.state !== "listening") return;

    this.processingPromise = this.runPipeline();
    await this.processingPromise;
  }

  private async runPipeline(): Promise<void> {
    try {
      this.setState("thinking");
      const log = this.log;

      // Finalize ASR — get the final transcript
      if (!this.asr) {
        log.warn(`[voice-session:${this.sessionId}] no ASR session, skipping`);
        this.setState("idle");
        return;
      }

      const text = await this.asr.finish();
      this.asr = null;

      if (this.destroyed) return;

      if (!text || text.trim() === "") {
        log.info(`[voice-session:${this.sessionId}] empty transcript, skipping`);
        this.setState("idle");
        return;
      }

      // Send the final transcript
      this.callbacks.onTranscript(text);
      log.info(`[voice-session:${this.sessionId}] transcript: "${text}"`);

      // Streaming Agent → TTS pipeline
      this.interruptSignal = { aborted: false };

      const pendingChunks: string[] = [];
      let ttsHandle: TTSStreamHandle | null = null;
      let ttsReady = false;
      let ttsStartPromise: Promise<void> | null = null;
      let hasText = false;

      log.info(`[voice-session:${this.sessionId}] starting streaming agent → TTS pipeline`);

      await this.cfg.processText(text, (chunk: string) => {
        if (this.destroyed || this.interruptSignal.aborted || !chunk.trim()) return;

        if (!hasText) {
          hasText = true;
          this.setState("speaking");
          ttsStartPromise = this.tts.synthesizeStreaming(
            (audioChunk) => {
              if (!this.destroyed && !this.interruptSignal.aborted) {
                this.callbacks.onAudioChunk(audioChunk);
              }
            },
            this.interruptSignal,
          ).then((handle) => {
            ttsHandle = handle;
            for (const pending of pendingChunks) {
              handle.feedText(pending);
            }
            pendingChunks.length = 0;
            ttsReady = true;
          }).catch((err) => {
            log.error(`[voice-session:${this.sessionId}] TTS start error: ${err}`);
          });
        }

        if (ttsReady && ttsHandle) {
          ttsHandle.feedText(chunk);
        } else {
          pendingChunks.push(chunk);
        }
      });

      if (this.destroyed || this.interruptSignal.aborted) {
        this.setState("idle");
        return;
      }

      if (ttsStartPromise) {
        await ttsStartPromise;
        if (ttsHandle) {
          await ttsHandle.finish();
        }
      }

      if (this.destroyed) return;

      if (!hasText) {
        log.info(`[voice-session:${this.sessionId}] empty agent reply, skipping TTS`);
      } else {
        this.callbacks.onAudioEnd();
      }
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
    if (this.asr) {
      this.asr.destroy();
      this.asr = null;
    }
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
    if (this.asr) {
      this.asr.destroy();
      this.asr = null;
    }
    try {
      await this.tts.disconnect();
    } catch {}
  }
}
