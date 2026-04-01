import type {
  ChannelPlugin,
  ChannelCapabilities,
  ChannelGatewayContext,
  ChannelOutboundAdapter,
  OpenClawConfig,
} from "openclaw/plugin-sdk/compat";
import { getSuperAgentRuntime } from "./runtime.js";
import {
  WsBridge,
  type WsBridgeConfig,
  type AgentExecuteParams,
  type AgentConfirmResponseParams,
  type AgentClarifyResponseParams,
  type AgentInterveneParams,
  type VoiceStartParams,
  type VoicePcmParams,
  type VoiceEndParams,
  type VoiceInterruptParams,
  type VoiceStopParams,
} from "./ws-bridge.js";
import { VoiceSession } from "./voice-session.js";
import { resolveVoiceConfig, buildTTSConfig, buildASRConfig } from "./voice-config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SuperAgentChannelConfig {
  serverUrl?: string;
  email?: string;
  password?: string;
  deviceId?: string;
  deviceName?: string;
  voice?: Record<string, unknown>;
}

interface ResolvedSuperAgentAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  serverUrl: string;
  email: string;
  password: string;
  deviceId: string;
  deviceName: string;
}

// ─── Pending Confirm/Clarify ─────────────────────────────────────────────────

const pendingConfirms = new Map<string, (approved: boolean) => void>();
const pendingClarifies = new Map<string, (answer: string) => void>();

// ─── Active Bridges ──────────────────────────────────────────────────────────

const activeBridges = new Map<string, WsBridge>();

// ─── Active Voice Sessions ────────────────────────────────────────────────────

const activeSessions = new Map<string, VoiceSession>();

// ─── Constants ───────────────────────────────────────────────────────────────

const CHANNEL_ID = "super-agent";
const DEFAULT_ACCOUNT_ID = "default";

// ─── Config Helpers ──────────────────────────────────────────────────────────

function resolveSuperAgentConfig(cfg: OpenClawConfig): SuperAgentChannelConfig {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return (channels?.[CHANNEL_ID] as SuperAgentChannelConfig) ?? {};
}

function resolveAccount(cfg: OpenClawConfig, accountId: string): ResolvedSuperAgentAccount {
  const channelCfg = resolveSuperAgentConfig(cfg);
  return {
    accountId,
    name: channelCfg.deviceName ?? "OpenClaw Agent",
    enabled: Boolean(channelCfg.serverUrl && channelCfg.email && channelCfg.password),
    serverUrl: channelCfg.serverUrl ?? "",
    email: channelCfg.email ?? "",
    password: channelCfg.password ?? "",
    deviceId: channelCfg.deviceId ?? `openclaw-${accountId}`,
    deviceName: channelCfg.deviceName ?? "OpenClaw Agent",
  };
}

// ─── Channel Plugin ──────────────────────────────────────────────────────────

export const superAgentPlugin: ChannelPlugin<ResolvedSuperAgentAccount> = {
  id: CHANNEL_ID,

  meta: {
    label: "Super Agent",
    blurb: "Bridge Mobile App to OpenClaw Agent via Super Agent Server",
    order: 900,
  },

  capabilities: {
    chatTypes: ["direct"],
    blockStreaming: true,
  } as ChannelCapabilities,

  config: {
    listAccountIds: (cfg) => {
      const channelCfg = resolveSuperAgentConfig(cfg);
      return channelCfg.serverUrl ? [DEFAULT_ACCOUNT_ID] : [];
    },
    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID),
    isConfigured: (account) => {
      return Boolean(account.serverUrl && account.email && account.password);
    },
    unconfiguredReason: (account) => {
      if (!account.serverUrl) return "serverUrl not set";
      if (!account.email) return "email not set";
      if (!account.password) return "password not set";
      return "not configured";
    },
  },

  gateway: {
    startAccount: async (ctx: ChannelGatewayContext<ResolvedSuperAgentAccount>) => {
      const account = ctx.account;
      if (!account.serverUrl || !account.email || !account.password) {
        throw new Error(`[${CHANNEL_ID}] not configured: missing serverUrl, email, or password`);
      }

      const bridgeConfig: WsBridgeConfig = {
        serverUrl: account.serverUrl,
        email: account.email,
        password: account.password,
        deviceId: account.deviceId,
        deviceName: account.deviceName,
      };

      const log = {
        info: (msg: string) => ctx.log?.info?.(`[${CHANNEL_ID}] ${msg}`),
        warn: (msg: string) => ctx.log?.warn?.(`[${CHANNEL_ID}] ${msg}`),
        error: (msg: string) => ctx.log?.error?.(`[${CHANNEL_ID}] ${msg}`),
        debug: (msg: string) => ctx.log?.debug?.(`[${CHANNEL_ID}] ${msg}`),
      };

      // Resolve voice config
      const channelCfgRaw = resolveSuperAgentConfig(ctx.cfg) as unknown as Record<string, unknown>;
      const voiceCfg = resolveVoiceConfig(channelCfgRaw);
      const asrConfig = buildASRConfig(voiceCfg);
      const ttsConfig = buildTTSConfig(voiceCfg);

      const bridge = new WsBridge(
        bridgeConfig,
        {
          onExecute: (params: AgentExecuteParams) => {
            handleInboundExecute(ctx, bridge, params).catch((err) => {
              log.error(`failed to handle agent.execute: ${err}`);
              bridge.sendAgentError({
                session_id: params.session_id,
                request_id: params.request_id || crypto.randomUUID(),
                message_id: crypto.randomUUID(),
                code: -1,
                message: String(err),
              });
            });
          },
          onConfirmResponse: (params: AgentConfirmResponseParams) => {
            const resolve = pendingConfirms.get(params.confirm_id);
            if (resolve) {
              pendingConfirms.delete(params.confirm_id);
              resolve(params.approved);
            } else {
              log.warn(`no pending confirm for id=${params.confirm_id}`);
            }
          },
          onClarifyResponse: (params: AgentClarifyResponseParams) => {
            const resolve = pendingClarifies.get(params.clarify_id);
            if (resolve) {
              pendingClarifies.delete(params.clarify_id);
              resolve(params.answer);
            } else {
              log.warn(`no pending clarify for id=${params.clarify_id}`);
            }
          },
          onIntervene: (params: AgentInterveneParams) => {
            log.info(`intervene received: action=${params.action} session=${params.session_id}`);
          },
          onConnected: () => log.info("connected to Super Agent Server"),
          onDisconnected: () => log.warn("disconnected from Super Agent Server"),
          onVoiceStart: (params: VoiceStartParams) => {
            handleVoiceStart(ctx, bridge, params, asrConfig, ttsConfig, log);
          },
          onVoicePcm: (params: VoicePcmParams) => {
            const session = activeSessions.get(params.session_id);
            if (session) {
              session.handlePcm(Buffer.from(params.data, "base64"));
            }
          },
          onVoiceEnd: (params: VoiceEndParams) => {
            const session = activeSessions.get(params.session_id);
            if (session) {
              session.handleSpeechEnd().catch((err) => {
                log.error(`voice.end error: ${err}`);
              });
            }
          },
          onVoiceInterrupt: (params: VoiceInterruptParams) => {
            const session = activeSessions.get(params.session_id);
            if (session) {
              session.handleInterrupt();
            }
          },
          onVoiceStop: (params: VoiceStopParams) => {
            const session = activeSessions.get(params.session_id);
            if (session) {
              activeSessions.delete(params.session_id);
              session.destroy().catch(() => {});
            }
          },
        },
        log,
      );

      activeBridges.set(account.accountId, bridge);

      try {
        await bridge.start(ctx.abortSignal);
      } catch (err) {
        activeBridges.delete(account.accountId);
        throw err;
      }

      // Keep running until aborted
      return new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => {
          bridge.close();
          activeBridges.delete(account.accountId);
          resolve();
        });
      });
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,

    sendText: async ({ to, text }) => {
      const bridge = getActiveBridge();
      if (!bridge) {
        throw new Error("super-agent bridge not connected");
      }
      // Generate IDs for outbound messages (agent-initiated)
      const requestId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      bridge.sendAgentStream({
        session_id: to,
        request_id: requestId,
        message_id: messageId,
        chunk_type: "text",
        created_at: Date.now(),
        data: { content: text },
      });
      return { channel: CHANNEL_ID };
    },
  } as ChannelOutboundAdapter,
};

// ─── Inbound Handling ────────────────────────────────────────────────────────

async function handleInboundExecute(
  ctx: ChannelGatewayContext<ResolvedSuperAgentAccount>,
  bridge: WsBridge,
  params: AgentExecuteParams,
): Promise<void> {
  const runtime = getSuperAgentRuntime();
  const channelRuntime = ctx.channelRuntime ?? runtime.channel;
  const cfg = ctx.cfg;
  const sessionId = params.session_id || crypto.randomUUID();
  const requestId = params.request_id || crypto.randomUUID();
  const messageId = crypto.randomUUID(); // Stable message ID for this response stream
  const instruction = params.instruction;

  // Resolve agent route
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: ctx.account.accountId,
    peer: { kind: "user", id: sessionId },
  });

  // Resolve session store path
  const storePath = channelRuntime.session.resolveStorePath(undefined, {
    agentId: route.agentId,
  });

  // Build envelope for agent context
  const envelopeOptions = channelRuntime.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = channelRuntime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = channelRuntime.reply.formatAgentEnvelope({
    channel: CHANNEL_ID,
    from: `mobile:${sessionId}`,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: instruction,
  });

  // Finalize inbound context
  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    RawBody: instruction,
    CommandBody: instruction,
    BodyForAgent: instruction,
    From: `${CHANNEL_ID}:${sessionId}`,
    To: `${CHANNEL_ID}:${ctx.account.accountId}`,
    SessionKey: route.sessionKey,
    AccountId: ctx.account.accountId,
    ChatType: "direct",
    SenderName: `mobile:${sessionId}`,
    SenderId: sessionId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: sessionId,
    CommandAuthorized: true,
    Timestamp: Date.now(),
  });

  // Record inbound session
  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => {
      ctx.log?.error?.(`[${CHANNEL_ID}] session record error: ${err}`);
    },
  });

  // Dispatch reply through OpenClaw agent pipeline
  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: unknown) => {
        const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
        const text = typeof p.text === "string" ? p.text.trim() : "";
        const mediaUrls = Array.isArray(p.mediaUrls)
          ? p.mediaUrls.filter((u): u is string => typeof u === "string")
          : typeof p.mediaUrl === "string"
            ? [p.mediaUrl]
            : [];

        if (mediaUrls.length > 0) {
          const mediaBlock = mediaUrls.map((url) => `Attachment: ${url}`).join("\n");
          const combined = text ? `${text}\n\n${mediaBlock}` : mediaBlock;
          bridge.sendAgentStream({
            session_id: sessionId,
            request_id: requestId,
            message_id: messageId,
            chunk_type: "text",
            created_at: Date.now(),
            data: { content: combined },
          });
        } else if (text) {
          bridge.sendAgentStream({
            session_id: sessionId,
            request_id: requestId,
            message_id: messageId,
            chunk_type: "text",
            created_at: Date.now(),
            data: { content: text },
          });
        }
      },
      onError: (err: unknown, info: { kind: string }) => {
        ctx.log?.error?.(`[${CHANNEL_ID}] dispatch error (${info.kind}): ${err}`);
        bridge.sendAgentError({
          session_id: sessionId,
          request_id: requestId,
          message_id: crypto.randomUUID(),
          code: -1,
          message: `Agent error: ${err}`,
        });
      },
    },
  });

  // Signal completion
  bridge.sendAgentComplete({ session_id: sessionId, request_id: requestId });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getActiveBridge(): WsBridge | undefined {
  for (const bridge of activeBridges.values()) {
    if (bridge.connected) return bridge;
  }
  return undefined;
}

// ─── Confirm/Clarify API ─────────────────────────────────────────────────────

export function requestConfirm(
  bridge: WsBridge,
  sessionId: string,
  confirmId: string,
  toolName: string,
  description: string,
  riskLevel: "low" | "medium" | "high",
  toolInput?: Record<string, unknown>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pendingConfirms.set(confirmId, resolve);
    bridge.sendConfirmRequest({
      session_id: sessionId,
      confirm_id: confirmId,
      tool_name: toolName,
      description,
      risk_level: riskLevel,
      tool_input: toolInput,
    });
  });
}

export function requestClarify(
  bridge: WsBridge,
  sessionId: string,
  clarifyId: string,
  question: string,
): Promise<string> {
  return new Promise<string>((resolve) => {
    pendingClarifies.set(clarifyId, resolve);
    bridge.sendClarifyRequest({
      session_id: sessionId,
      clarify_id: clarifyId,
      question,
    });
  });
}

export { activeBridges };

// ─── Voice Session Handling ───────────────────────────────────────────────────

function handleVoiceStart(
  ctx: ChannelGatewayContext<ResolvedSuperAgentAccount>,
  bridge: WsBridge,
  params: VoiceStartParams,
  asrConfig: ReturnType<typeof buildASRConfig>,
  ttsConfig: ReturnType<typeof buildTTSConfig>,
  log: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void }
): void {
  const sessionId = params.session_id;

  // Destroy any existing session for this sessionId
  const existing = activeSessions.get(sessionId);
  if (existing) {
    existing.destroy().catch(() => {});
    activeSessions.delete(sessionId);
  }

  if (!asrConfig || !ttsConfig) {
    log.warn(`[voice] voice.start received but voice not configured (missing apiKey)`);
    bridge.sendVoiceError(sessionId, "Voice not configured: missing apiKey in channels[super-agent].voice");
    return;
  }

  const session = new VoiceSession(
    sessionId,
    {
      asrConfig,
      ttsConfig,
      processText: async (text: string) => {
        return handleVoiceText(ctx, text, sessionId, log);
      },
    },
    {
      onStatus: (state) => bridge.sendVoiceStatus(sessionId, state),
      onTranscript: (text) => bridge.sendVoiceTranscript(sessionId, text),
      onAudioChunk: (data) => bridge.sendVoiceAudioChunk(sessionId, data.toString("base64")),
      onAudioEnd: () => bridge.sendVoiceAudioEnd(sessionId),
      onError: (message) => bridge.sendVoiceError(sessionId, message),
    },
    log
  );

  activeSessions.set(sessionId, session);
  bridge.sendVoiceStatus(sessionId, "listening");
  log.info(`[voice] session started: ${sessionId}`);
}

async function handleVoiceText(
  ctx: ChannelGatewayContext<ResolvedSuperAgentAccount>,
  instruction: string,
  sessionId: string,
  log: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void }
): Promise<string> {
  const runtime = getSuperAgentRuntime();
  const channelRuntime = ctx.channelRuntime ?? runtime.channel;
  const cfg = ctx.cfg;

  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: ctx.account.accountId,
    peer: { kind: "user", id: sessionId },
  });

  const storePath = channelRuntime.session.resolveStorePath(undefined, {
    agentId: route.agentId,
  });

  const envelopeOptions = channelRuntime.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = channelRuntime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = channelRuntime.reply.formatAgentEnvelope({
    channel: CHANNEL_ID,
    from: `voice:${sessionId}`,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: instruction,
  });

  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    RawBody: instruction,
    CommandBody: instruction,
    BodyForAgent: instruction,
    From: `${CHANNEL_ID}:${sessionId}`,
    To: `${CHANNEL_ID}:${ctx.account.accountId}`,
    SessionKey: route.sessionKey,
    AccountId: ctx.account.accountId,
    ChatType: "direct",
    SenderName: `voice:${sessionId}`,
    SenderId: sessionId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: sessionId,
    CommandAuthorized: true,
    Timestamp: Date.now(),
  });

  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => {
      log.error(`[voice] session record error: ${err}`);
    },
  });

  let replyText = "";

  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: unknown) => {
        const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
        const text = typeof p.text === "string" ? p.text.trim() : "";
        if (text) {
          replyText = replyText ? `${replyText}\n${text}` : text;
        }
      },
      onError: (err: unknown, info: { kind: string }) => {
        log.error(`[voice] dispatch error (${info.kind}): ${err}`);
      },
    },
  });

  return replyText;
}
