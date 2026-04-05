/**
 * Doubao (ByteDance) Streaming ASR — WebSocket Client
 *
 * Supports two modes:
 * 1. Streaming: new DoubaoASR() → start() → feedPCM() ... → finish()
 * 2. One-shot:  transcribePCM(buffer) (convenience wrapper)
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";
import { gzipSync } from "zlib";

function buildFullClientRequest(jsonPayload: object): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(jsonPayload), "utf8");
  const compressed = gzipSync(jsonBuf);

  const parts: Buffer[] = [];
  parts.push(Buffer.from([0x11, 0x10, 0x11, 0x00]));

  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(compressed.length, 0);
  parts.push(lenBuf, compressed);

  return Buffer.concat(parts);
}

function buildAudioFrame(pcmChunk: Buffer): Buffer {
  const header = Buffer.from([0x11, 0x20, 0x00, 0x00]);
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(pcmChunk.length, 0);
  return Buffer.concat([header, lenBuf, pcmChunk]);
}

interface ASRResponse {
  text?: string;
  isFinal?: boolean;
  error?: string;
}

function parseASRFrame(data: Buffer): ASRResponse | null {
  if (data.length < 4) return null;

  const msgType = (data[1] >> 4) & 0x0f;

  let offset = 4;

  if (msgType === 0x0f) {
    const errCode = data.readUInt32BE(offset);
    offset += 4;
    const pLen = data.length > offset + 4 ? data.readUInt32BE(offset) : 0;
    offset += 4;
    const msg = pLen > 0 ? data.slice(offset, offset + pLen).toString("utf8") : "";
    return { error: `ASR error ${errCode}: ${msg}` };
  }

  if (msgType !== 0x09) return null;

  const flags = data[1] & 0x0f;
  if (flags & 0x03) {
    offset += 4;
  }

  if (data.length < offset + 4) return null;
  const pLen = data.readUInt32BE(offset);
  offset += 4;
  if (pLen === 0 || data.length < offset + pLen) return null;

  const payload = data.slice(offset, offset + pLen).toString("utf8");
  try {
    const result = JSON.parse(payload) as {
      result?: { text?: string };
      is_final?: boolean;
      code?: number;
      message?: string;
    };

    if (result.code && result.code !== 0 && result.code !== 1000) {
      return { error: `ASR code ${result.code}: ${result.message ?? ""}` };
    }

    return {
      text: result.result?.text ?? "",
      isFinal: result.is_final === true,
    };
  } catch {
    return null;
  }
}

export interface DoubaoASRConfig {
  apiKey: string;
  language?: string;
}

/**
 * Streaming ASR client.
 * Usage: start() → feedPCM() as audio arrives → finish() returns final text.
 */
export class DoubaoASR {
  private ws: WebSocket | null = null;
  private started = false;
  private finalText = "";
  private resolved = false;
  private resolveResult!: (text: string) => void;
  private rejectResult!: (err: Error) => void;
  private resultPromise: Promise<string>;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private onPartial?: (text: string) => void;

  /** Whether the ASR session is still active and accepting PCM. */
  get isAlive(): boolean {
    return this.started && !this.resolved;
  }

  constructor(
    private cfg: DoubaoASRConfig,
    private log?: { info: (s: string) => void; error: (s: string) => void },
  ) {
    this.resultPromise = new Promise<string>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  /**
   * Open WebSocket and send ASR config. Must be called before feedPCM().
   * @param onPartial Optional callback for intermediate transcription results.
   */
  async start(onPartial?: (text: string) => void): Promise<void> {
    this.onPartial = onPartial;

    const headers: Record<string, string> = {
      "x-api-key": this.cfg.apiKey,
      "X-Api-Resource-Id": "volc.bigasr.sauc.duration",
      "X-Api-Connect-Id": randomUUID(),
    };

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(
        "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
        { headers },
      );

      this.ws.once("open", () => {
        this.log?.info("[voice:asr] connected, sending config");

        this.ws!.send(buildFullClientRequest({
          user: { uid: "voice-user" },
          audio: { format: "pcm", rate: 16000, bits: 16, channel: 1, language: this.cfg.language ?? "zh-CN" },
          request: { model_name: "bigmodel", enable_itn: true, enable_punc: true },
        }));

        this.started = true;
        this.setupListeners();
        resolve();
      });

      this.ws.once("error", reject);
    });

    // Safety timeout — if no final result after 30s, resolve with whatever we have
    this.timeout = setTimeout(() => {
      this.log?.error("[voice:asr] timeout 30s, finalText=" + JSON.stringify(this.finalText));
      this.done(this.finalText);
    }, 30000);
  }

  /** Send a PCM audio chunk to ASR. Can be called as audio arrives. */
  feedPCM(chunk: Buffer): void {
    if (!this.started || !this.ws || this.resolved) return;
    this.ws.send(buildAudioFrame(chunk));
  }

  /**
   * Signal end of audio stream and wait for the final transcription result.
   */
  async finish(): Promise<string> {
    if (!this.started || !this.ws) return this.finalText;

    this.log?.info("[voice:asr] signaling end of audio stream");
    // Close the WebSocket to signal end-of-stream (same as original approach)
    try { this.ws.close(); } catch {}

    return this.resultPromise;
  }

  /** Abort the ASR session immediately. */
  destroy(): void {
    this.done(this.finalText);
    try { this.ws?.terminate(); } catch {}
  }

  private setupListeners(): void {
    this.ws!.on("message", (data: Buffer) => {
      if (this.resolved) return;

      const parsed = parseASRFrame(data);
      if (!parsed) return;

      if (parsed.error) {
        this.log?.error(`[voice:asr] server error: ${parsed.error}`);
        this.fail(new Error(parsed.error));
        return;
      }

      if (parsed.text) {
        this.finalText = parsed.text;
        this.onPartial?.(parsed.text);
      }

      if (parsed.isFinal) {
        this.log?.info(`[voice:asr] final: "${this.finalText}"`);
        this.done(this.finalText);
      }
    });

    this.ws!.on("error", (err) => {
      this.log?.error(`[voice:asr] ws error: ${err.message}`);
      this.fail(new Error(`ASR WebSocket error: ${err.message}`));
    });

    this.ws!.on("close", () => {
      // Server closed — resolve with whatever we have
      if (!this.resolved) this.done(this.finalText);
    });
  }

  private done(text: string): void {
    if (this.resolved) return;
    this.resolved = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.resolveResult(text);
  }

  private fail(err: Error): void {
    if (this.resolved) return;
    this.resolved = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.rejectResult(err);
  }
}

/**
 * One-shot convenience wrapper — sends all PCM at once.
 * Kept for backward compatibility.
 */
export async function transcribePCM(
  pcmBuffer: Buffer,
  cfg: DoubaoASRConfig,
  log?: { info: (s: string) => void; error: (s: string) => void }
): Promise<string> {
  const asr = new DoubaoASR(cfg, log);
  await asr.start();

  log?.info(`[voice:asr] sending ${pcmBuffer.length} bytes`);
  const CHUNK_SIZE = 6400;
  let offset = 0;
  while (offset < pcmBuffer.length) {
    const end = Math.min(offset + CHUNK_SIZE, pcmBuffer.length);
    asr.feedPCM(pcmBuffer.slice(offset, end));
    offset = end;
  }

  return asr.finish();
}
