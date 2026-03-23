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
} from "./ws-bridge.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SuperAgentChannelConfig {
  serverUrl?: string;
  email?: string;
  password?: string;
  deviceId?: string;
  deviceName?: string;
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

      const bridge = new WsBridge(
        bridgeConfig,
        {
          onExecute: (params: AgentExecuteParams) => {
            handleInboundExecute(ctx, bridge, params).catch((err) => {
              log.error(`failed to handle agent.execute: ${err}`);
              bridge.sendAgentError({
                session_id: params.session_id,
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
      bridge.sendAgentStream({
        session_id: to,
        chunk_type: "text",
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
  const sessionId = params.session_id;
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
            chunk_type: "text",
            data: { content: combined },
          });
        } else if (text) {
          bridge.sendAgentStream({
            session_id: sessionId,
            chunk_type: "text",
            data: { content: text },
          });
        }
      },
      onError: (err: unknown, info: { kind: string }) => {
        ctx.log?.error?.(`[${CHANNEL_ID}] dispatch error (${info.kind}): ${err}`);
        bridge.sendAgentError({
          session_id: sessionId,
          code: -1,
          message: `Agent error: ${err}`,
        });
      },
    },
  });

  // Signal completion
  bridge.sendAgentComplete({ session_id: sessionId });
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
