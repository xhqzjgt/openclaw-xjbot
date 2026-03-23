import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/compat";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/compat";
import { superAgentPlugin } from "./src/channel.js";
import { setSuperAgentRuntime } from "./src/runtime.js";

const plugin = {
  id: "super-agent",
  name: "Super Agent",
  description: "Bridge Mobile App to OpenClaw Agent via Super Agent Server",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSuperAgentRuntime(api.runtime);
    api.registerChannel({ plugin: superAgentPlugin as ChannelPlugin });
  },
};

export default plugin;
