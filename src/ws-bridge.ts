import WebSocket from "ws";

// ─── JSON-RPC 2.0 Types ─────────────────────────────────────────────────────

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─── Server Protocol Types ───────────────────────────────────────────────────

export interface AgentExecuteParams {
  target_device_id: string;
  instruction: string;
  session_id: string;
  request_id: string;
  attachments?: Array<{
    type?: "image" | "audio" | "file";
    file_type?: "image" | "audio" | "file";
    file_id?: string;
    file_name?: string;
    url: string;
    name?: string;
    mime_type?: string;
    size_bytes?: number;
  }>;
}

export interface TextChunkData {
  content: string;
}

export interface ToolCallChunkData {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface ToolResultChunkData {
  tool_name: string;
  output: string;
  success: boolean;
}

export interface StatusChunkData {
  message: string;
}

export interface FileChunkData {
  attachments: Array<{
    file_id: string;
    file_name: string;
    file_type: "image" | "video" | "audio" | "file";
    mime_type: string;
    size_bytes: number;
    url: string;
  }>;
}

export type ChunkData = TextChunkData | ToolCallChunkData | ToolResultChunkData | StatusChunkData | FileChunkData;

export interface AgentStreamParams {
  session_id: string;
  request_id: string;
  message_id: string;
  chunk_type: "text" | "tool_call" | "tool_result" | "status" | "file";
  created_at?: number;
  data: ChunkData;
}

export interface AgentCompleteParams {
  session_id: string;
  request_id: string;
}

export interface AgentErrorParams {
  session_id: string;
  request_id: string;
  message_id: string;
  code: number;
  message: string;
}

export interface AgentConfirmRequestParams {
  session_id: string;
  confirm_id: string;
  tool_name: string;
  description: string;
  risk_level: "low" | "medium" | "high";
  tool_input?: Record<string, unknown>;
}

export interface AgentConfirmResponseParams {
  confirm_id: string;
  approved: boolean;
  reason?: string;
}

export interface AgentClarifyParams {
  session_id: string;
  clarify_id: string;
  question: string;
}

export interface AgentClarifyResponseParams {
  clarify_id: string;
  answer: string;
}

export interface AgentInterveneParams {
  session_id: string;
  action: string;
  message?: string;
}

// ─── Voice Protocol Types ─────────────────────────────────────────────────────

export type VoiceState = "listening" | "thinking" | "speaking" | "idle";

export interface VoiceStartParams {
  target_device_id: string;
  session_id: string;
  chat_session_id?: string;
}

export interface VoicePcmParams {
  target_device_id: string;
  session_id: string;
  data: string; // base64-encoded PCM
}

export interface VoiceEndParams {
  target_device_id: string;
  session_id: string;
}

export interface VoiceInterruptParams {
  target_device_id: string;
  session_id: string;
}

export interface VoiceStopParams {
  target_device_id: string;
  session_id: string;
}

// ─── Auth Types ──────────────────────────────────────────────────────────────

interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

// ─── WsBridge Config & Callbacks ─────────────────────────────────────────────

export interface WsBridgeConfig {
  serverUrl: string;
  email: string;
  password: string;
  deviceId: string;
  deviceName?: string;
}

export interface WsBridgeCallbacks {
  onExecute?: (params: AgentExecuteParams) => void;
  onConfirmResponse?: (params: AgentConfirmResponseParams) => void;
  onClarifyResponse?: (params: AgentClarifyResponseParams) => void;
  onIntervene?: (params: AgentInterveneParams) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onVoiceStart?: (params: VoiceStartParams) => void;
  onVoicePcm?: (params: VoicePcmParams) => void;
  onVoiceEnd?: (params: VoiceEndParams) => void;
  onVoiceInterrupt?: (params: VoiceInterruptParams) => void;
  onVoiceStop?: (params: VoiceStopParams) => void;
}

export interface WsBridgeLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

// ─── WsBridge ────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export class WsBridge {
  private config: WsBridgeConfig;
  private callbacks: WsBridgeCallbacks;
  private log: WsBridgeLogger;

  private tokens: AuthTokens | null = null;
  private tokenExpiresAt = 0;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private rpcIdCounter = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private abortSignal: AbortSignal | null = null;
  private closed = false;

  constructor(config: WsBridgeConfig, callbacks: WsBridgeCallbacks, log: WsBridgeLogger) {
    this.config = config;
    this.log = log;
    this.callbacks = callbacks;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async start(abortSignal: AbortSignal): Promise<void> {
    this.abortSignal = abortSignal;
    this.closed = false;

    abortSignal.addEventListener("abort", () => this.close(), { once: true });

    await this.ensureTokens();
    await this.connect();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close(1000, "shutdown");
      this.ws = null;
    }
    this.rejectAllPending("bridge closed");
    this.callbacks.onDisconnected?.();
  }

  // ── Outbound Messages ────────────────────────────────────────────────────

  sendAgentStream(params: AgentStreamParams): void {
    this.sendNotification("agent.stream", params);
  }

  sendAgentComplete(params: AgentCompleteParams): void {
    this.sendNotification("agent.complete", params);
  }

  sendAgentError(params: AgentErrorParams): void {
    this.sendNotification("agent.error", params);
  }

  sendConfirmRequest(params: AgentConfirmRequestParams): void {
    this.sendNotification("agent.confirm_request", params);
  }

  sendClarifyRequest(params: AgentClarifyParams): void {
    this.sendNotification("agent.clarify", params);
  }

  sendVoiceStatus(sessionId: string, state: VoiceState): void {
    this.sendNotification("voice.status", { session_id: sessionId, state });
  }

  sendVoiceTranscript(sessionId: string, text: string): void {
    this.sendNotification("voice.transcript", { session_id: sessionId, text });
  }

  sendVoiceAudioChunk(sessionId: string, data: string): void {
    this.sendNotification("voice.audio_chunk", { session_id: sessionId, data });
  }

  sendVoiceAudioEnd(sessionId: string): void {
    this.sendNotification("voice.audio_end", { session_id: sessionId });
  }

  sendVoiceAiText(sessionId: string, chunk: string): void {
    this.sendNotification("voice.ai_text", { session_id: sessionId, text: chunk });
  }

  sendVoiceError(sessionId: string, message: string): void {
    this.sendNotification("voice.error", { session_id: sessionId, message });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  private async ensureTokens(): Promise<void> {
    if (this.tokens && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return;
    }
    if (this.tokens) {
      try {
        await this.refreshTokens();
        return;
      } catch {
        this.log.warn("token refresh failed, re-logging in");
      }
    }
    await this.login();
  }

  private async login(): Promise<void> {
    const url = `${this.config.serverUrl}/api/v1/auth/login`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`login failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { tokens: AuthTokens };
    this.setTokens(data.tokens);
    this.log.info("authenticated with server");
  }

  private async refreshTokens(): Promise<void> {
    if (!this.tokens) throw new Error("no tokens to refresh");
    const url = `${this.config.serverUrl}/api/v1/auth/refresh`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: this.tokens.refresh_token }),
    });
    if (!res.ok) throw new Error(`refresh failed (${res.status})`);
    const data = (await res.json()) as { tokens: AuthTokens };
    this.setTokens(data.tokens);
    this.log.info("tokens refreshed");
  }

  private setTokens(tokens: AuthTokens): void {
    this.tokens = tokens;
    this.tokenExpiresAt = Date.now() + tokens.expires_in * 1000;
  }

  private async getWsTicket(): Promise<string> {
    await this.ensureTokens();
    const url = `${this.config.serverUrl}/api/v1/auth/ws-ticket`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.tokens!.access_token}` },
    });
    if (!res.ok) throw new Error(`ws-ticket failed (${res.status})`);
    const data = (await res.json()) as { ticket: string };
    return data.ticket;
  }

  // ── WebSocket Connect ────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.closed) return;

    const ticket = await this.getWsTicket();
    const wsUrl = this.config.serverUrl.replace(/^http/, "ws") + `/api/v1/ws?ticket=${ticket}`;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.on("open", async () => {
        this.log.info("websocket connected");
        this.reconnectAttempt = 0;
        try {
          await this.sendAuthHello();
          this.startHeartbeat();
          this.callbacks.onConnected?.();
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          this.log.error(`failed to parse message: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        this.log.warn(`websocket closed: ${code} ${reason.toString()}`);
        this.clearHeartbeat();
        this.callbacks.onDisconnected?.();
        if (!this.closed) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        this.log.error(`websocket error: ${err.message}`);
      });
    });
  }

  private async sendAuthHello(): Promise<void> {
    const result = await this.sendRequest("auth.hello", {
      device_id: this.config.deviceId,
      device_type: "desktop",
      device_name: this.config.deviceName ?? "OpenClaw Agent",
    });
    this.log.info(`auth.hello OK: connection_id=${(result as Record<string, unknown>).connection_id}`);
  }

  // ── Message Handling ─────────────────────────────────────────────────────

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest): void {
    // Response to a pending request
    if ("id" in msg && msg.id != null && this.pendingRequests.has(msg.id as number)) {
      const pending = this.pendingRequests.get(msg.id as number)!;
      this.pendingRequests.delete(msg.id as number);
      const resp = msg as JsonRpcResponse;
      if (resp.error) {
        pending.reject(new Error(`RPC error ${resp.error.code}: ${resp.error.message}`));
      } else {
        pending.resolve(resp.result);
      }
      return;
    }

    // Incoming notification/request from server
    const method = (msg as JsonRpcNotification).method;
    const params = (msg as JsonRpcNotification).params ?? {};

    switch (method) {
      case "agent.execute":
        this.callbacks.onExecute?.(params as unknown as AgentExecuteParams);
        // ACK the request if it has an id
        if ("id" in msg && msg.id != null) {
          this.sendRaw({
            jsonrpc: "2.0",
            id: msg.id as number,
            result: { status: "accepted" },
          });
        }
        break;
      case "agent.confirm_response":
        this.callbacks.onConfirmResponse?.(params as unknown as AgentConfirmResponseParams);
        break;
      case "agent.clarify_response":
        this.callbacks.onClarifyResponse?.(params as unknown as AgentClarifyResponseParams);
        break;
      case "agent.intervene":
        this.callbacks.onIntervene?.(params as unknown as AgentInterveneParams);
        break;
      case "voice.start":
        this.callbacks.onVoiceStart?.(params as unknown as VoiceStartParams);
        break;
      case "voice.pcm":
        this.callbacks.onVoicePcm?.(params as unknown as VoicePcmParams);
        break;
      case "voice.end":
        this.callbacks.onVoiceEnd?.(params as unknown as VoiceEndParams);
        break;
      case "voice.interrupt":
        this.callbacks.onVoiceInterrupt?.(params as unknown as VoiceInterruptParams);
        break;
      case "voice.stop":
        this.callbacks.onVoiceStop?.(params as unknown as VoiceStopParams);
        break;
      case "heartbeat.pong":
        this.log.debug?.("heartbeat pong received");
        break;
      default:
        this.log.debug?.(`unhandled method: ${method}`);
    }
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendNotification("heartbeat.ping", {});
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Reconnect ────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.closed || this.abortSignal?.aborted) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempt++;
    this.log.info(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.ensureTokens();
        await this.connect();
      } catch (err) {
        this.log.error(`reconnect failed: ${err}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Low-level Send ───────────────────────────────────────────────────────

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.sendRaw({ jsonrpc: "2.0", method, params } satisfies JsonRpcNotification);
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.rpcIdCounter;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.sendRaw({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest);
      // Timeout pending requests after 15s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC request ${method} timed out`));
        }
      }, 15_000);
    });
  }

  private sendRaw(msg: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.log.warn(`cannot send, ws not open: ${JSON.stringify(msg).slice(0, 100)}`);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }
}
