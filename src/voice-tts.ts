/**
 * Doubao (ByteDance) Bidirectional Streaming TTS — WebSocket Client
 * Adapted from openclaw-voice/src/doubao-tts.ts
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";

const EVENT = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TTSResponse: 352,
} as const;

function buildFrame(opts: {
  msgType: number;
  serialization: number;
  event: number;
  sessionId?: string;
  payload: Buffer | string;
}): Buffer {
  const { msgType, serialization, event, sessionId, payload } = opts;
  const payloadBuf =
    typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;

  const parts: Buffer[] = [];

  parts.push(
    Buffer.from([
      0x11,
      (msgType << 4) | 0x04,
      (serialization << 4) | 0x00,
      0x00,
    ])
  );

  const evBuf = Buffer.allocUnsafe(4);
  evBuf.writeInt32BE(event, 0);
  parts.push(evBuf);

  if (sessionId) {
    const sidBuf = Buffer.from(sessionId, "utf8");
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(sidBuf.length, 0);
    parts.push(lenBuf, sidBuf);
  }

  const pLenBuf = Buffer.allocUnsafe(4);
  pLenBuf.writeUInt32BE(payloadBuf.length, 0);
  parts.push(pLenBuf, payloadBuf);

  return Buffer.concat(parts);
}

interface ParsedFrame {
  msgType: number;
  event?: number;
  id?: string;
  payload?: Buffer;
  error?: { code: number; message: string };
}

function parseFrame(data: Buffer): ParsedFrame {
  const headerSize = (data[0] & 0x0f) * 4;
  const msgType = (data[1] >> 4) & 0x0f;
  const flags = data[1] & 0x0f;
  let offset = headerSize;

  if (msgType === 0x0f) {
    const errorCode = data.readUInt32BE(offset);
    offset += 4;
    const pLen = data.length > offset + 4 ? data.readUInt32BE(offset) : 0;
    offset += 4;
    const msg = pLen > 0 ? data.slice(offset, offset + pLen).toString("utf8") : "";
    return { msgType, error: { code: errorCode, message: msg } };
  }

  let event: number | undefined;
  if (flags & 0x04) {
    event = data.readInt32BE(offset);
    offset += 4;
  }

  let id: string | undefined;
  if (data.length >= offset + 4) {
    const idLen = data.readUInt32BE(offset);
    offset += 4;
    if (idLen > 0 && data.length >= offset + idLen) {
      id = data.slice(offset, offset + idLen).toString("utf8");
      offset += idLen;
    }
  }

  let payload: Buffer | undefined;
  if (data.length >= offset + 4) {
    const pLen = data.readUInt32BE(offset);
    offset += 4;
    if (pLen > 0 && data.length >= offset + pLen) {
      payload = data.slice(offset, offset + pLen);
    }
  }

  return { msgType, event, id, payload };
}

export interface DoubaoTTSConfig {
  apiKey: string;
  resourceId: string;
  voiceType: string;
  format?: string;
  sampleRate?: number;
}

export class DoubaoTTS {
  private ws: WebSocket | null = null;
  private connected = false;

  constructor(private cfg: DoubaoTTSConfig) {}

  async connect(): Promise<void> {
    const headers: Record<string, string> = {
      "x-api-key": this.cfg.apiKey,
      "X-Api-Resource-Id": this.cfg.resourceId,
    };

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(
        "wss://openspeech.bytedance.com/api/v3/tts/bidirection",
        { headers }
      );

      this.ws.once("open", async () => {
        try {
          const frame = buildFrame({
            msgType: 0x01,
            serialization: 0x01,
            event: EVENT.StartConnection,
            payload: "{}",
          });
          this.ws!.send(frame);
        } catch (e) {
          reject(e);
        }
      });

      this.ws.once("message", (data: Buffer) => {
        const parsed = parseFrame(data);
        if (parsed.error) {
          reject(new Error(`TTS connection failed: ${parsed.error.message}`));
          return;
        }
        if (parsed.event === EVENT.ConnectionStarted) {
          this.connected = true;
          this.setupMessageLoop();
          resolve();
        } else {
          reject(new Error(`Unexpected event: ${parsed.event}`));
        }
      });

      this.ws.once("error", reject);
    });
  }

  private setupMessageLoop() {
    this.ws!.on("message", () => {});
    this.ws!.on("error", () => { this.connected = false; });
    this.ws!.on("close", () => { this.connected = false; });
  }

  async synthesize(
    text: string,
    onChunk: (audioChunk: Buffer) => void,
    interruptSignal?: { aborted: boolean }
  ): Promise<void> {
    if (!this.connected || !this.ws) {
      await this.connect();
    }

    const sessionId = randomUUID();
    const format = this.cfg.format ?? "mp3";
    const sampleRate = this.cfg.sampleRate ?? 24000;

    const sessionMeta = JSON.stringify({
      user: { uid: "voice-user" },
      event: EVENT.StartSession,
      req_params: {
        speaker: this.cfg.voiceType,
        audio_params: { format, sample_rate: sampleRate },
      },
    });
    this.ws!.send(
      buildFrame({
        msgType: 0x01,
        serialization: 0x01,
        event: EVENT.StartSession,
        sessionId,
        payload: sessionMeta,
      })
    );

    await this.waitForEvent(EVENT.SessionStarted, 10000);

    if (interruptSignal?.aborted) return;

    const taskPayload = JSON.stringify({
      event: EVENT.TaskRequest,
      req_params: { text },
    });
    this.ws!.send(
      buildFrame({
        msgType: 0x01,
        serialization: 0x01,
        event: EVENT.TaskRequest,
        sessionId,
        payload: taskPayload,
      })
    );

    this.ws!.send(
      buildFrame({
        msgType: 0x01,
        serialization: 0x01,
        event: EVENT.FinishSession,
        sessionId,
        payload: "{}",
      })
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("TTS session timeout"));
      }, 60000);

      const onMessage = (data: Buffer) => {
        if (interruptSignal?.aborted) {
          cleanup();
          resolve();
          return;
        }

        const parsed = parseFrame(data);

        if (parsed.error) {
          cleanup();
          reject(new Error(`TTS error: ${parsed.error.message}`));
          return;
        }

        if (parsed.event === EVENT.TTSResponse && parsed.payload) {
          onChunk(parsed.payload);
        } else if (
          parsed.event === EVENT.SessionFinished ||
          parsed.event === EVENT.SessionFailed
        ) {
          cleanup();
          if (parsed.event === EVENT.SessionFailed) {
            const msg = parsed.payload?.toString("utf8") ?? "unknown";
            reject(new Error(`TTS session failed: ${msg}`));
          } else {
            resolve();
          }
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.ws!.off("message", onMessage);
      };

      this.ws!.on("message", onMessage);
    });
  }

  private waitForEvent(event: number, timeoutMs: number): Promise<ParsedFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws!.off("message", handler);
        reject(new Error(`Timeout waiting for event ${event}`));
      }, timeoutMs);

      const handler = (data: Buffer) => {
        const parsed = parseFrame(data);
        if (parsed.event === event) {
          clearTimeout(timer);
          this.ws!.off("message", handler);
          resolve(parsed);
        }
      };
      this.ws!.on("message", handler);
    });
  }

  async disconnect(): Promise<void> {
    if (this.ws && this.connected) {
      this.ws.send(
        buildFrame({
          msgType: 0x01,
          serialization: 0x01,
          event: EVENT.FinishConnection,
          payload: "{}",
        })
      );
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }
}
