import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk/compat";

const { setRuntime: setSuperAgentRuntime, getRuntime: getSuperAgentRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Super Agent runtime not initialized");
export { getSuperAgentRuntime, setSuperAgentRuntime };
