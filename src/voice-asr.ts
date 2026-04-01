/**
 * Doubao (ByteDance) Streaming ASR — WebSocket Client
 * Adapted from openclaw-voice/src/doubao-asr.ts
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

export async function transcribePCM(
  pcmBuffer: Buffer,
  cfg: DoubaoASRConfig,
  log?: { info: (s: string) => void; error: (s: string) => void }
): Promise<string> {
  const headers: Record<string, string> = {
    "x-api-key": cfg.apiKey,
    "X-Api-Resource-Id": "volc.bigasr.sauc.duration",
    "X-Api-Connect-Id": randomUUID(),
  };

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      { headers }
    );

    const timeout = setTimeout(() => {
      log?.error("[voice:asr] timeout 15s, finalText=" + JSON.stringify(finalText));
      ws.terminate();
      resolve(finalText);
    }, 15000);

    let finalText = "";
    let resolved = false;

    function done(text: string) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve(text);
    }

    ws.once("open", () => {
      log?.info(`[voice:asr] connected, sending ${pcmBuffer.length} bytes`);

      ws.send(buildFullClientRequest({
        user: { uid: "voice-user" },
        audio: { format: "pcm", rate: 16000, bits: 16, channel: 1, language: cfg.language ?? "zh-CN" },
        request: { model_name: "bigmodel", enable_itn: true, enable_punc: true },
      }));

      const CHUNK_SIZE = 6400;
      let offset = 0;
      while (offset < pcmBuffer.length) {
        const end = Math.min(offset + CHUNK_SIZE, pcmBuffer.length);
        ws.send(buildAudioFrame(pcmBuffer.slice(offset, end)));
        offset = end;
      }

      log?.info("[voice:asr] all audio sent, closing to signal end of stream");
      ws.close();
    });

    ws.on("message", (data: Buffer) => {
      if (resolved) return;

      const parsed = parseASRFrame(data);
      if (!parsed) return;

      if (parsed.error) {
        log?.error(`[voice:asr] server error: ${parsed.error}`);
        if (!resolved) { resolved = true; clearTimeout(timeout); ws.close(); reject(new Error(parsed.error)); }
        return;
      }

      if (parsed.text) {
        finalText = parsed.text;
      }

      if (parsed.isFinal) {
        log?.info(`[voice:asr] final: "${finalText}"`);
        done(finalText);
      }
    });

    ws.on("error", (err) => {
      log?.error(`[voice:asr] ws error: ${err.message}`);
      if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error(`ASR WebSocket error: ${err.message}`)); }
    });

    ws.on("close", () => {
      if (!resolved) done(finalText);
    });
  });
}
