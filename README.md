# openclaw-super-agent

[OpenClaw](https://github.com/nicepkg/openclaw) channel plugin that connects **Super Agent Mobile App** to an OpenClaw Agent instance via a relay server.

## How it works

```
Mobile App ──WebSocket──▶ Super Agent Server ──WebSocket──▶ This Plugin ──▶ OpenClaw Agent
```

The plugin registers as a `device_type: "desktop"` device on the Super Agent Server, reusing the existing WebSocket relay protocol. **No changes needed on the server or mobile app side.**

Features:
- Receive instructions from the mobile app, execute via OpenClaw Agent, stream results back
- Automatic reconnection with exponential backoff (1s → 30s max)
- JWT token auto-refresh
- 30s heartbeat keepalive
- Approval & clarification API for tool execution confirmation

## Installation

### 1. Clone this plugin

```bash
git clone https://github.com/xhqzjgt/openclaw-xjbot.git
```

### 2. Register the plugin with OpenClaw

Add to your `~/.openclaw/openclaw.json`:

```jsonc
{
  // Tell OpenClaw where to find this plugin
  "plugins": {
    "load": {
      "paths": ["/path/to/openclaw-super-agent"]
    }
  },

  // Configure the Super Agent channel
  "channels": {
    "super-agent": {
      "serverUrl": "https://your-server.com",
      "email": "user@example.com",
      "password": "your-password",
      "deviceId": "openclaw-main",
      "deviceName": "My OpenClaw Agent"
    }
  }
}
```

**Alternative:** symlink into OpenClaw's extensions directory:

```bash
# macOS / Linux
ln -s /path/to/openclaw-super-agent ~/.openclaw/extensions/super-agent

# Windows (Admin)
mklink /D "%USERPROFILE%\.openclaw\extensions\super-agent" "C:\path\to\openclaw-super-agent"
```

### 3. Start OpenClaw

```bash
openclaw
```

Check logs for: `[super-agent] connected to Super Agent Server`

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `serverUrl` | Yes | — | Super Agent Server URL (e.g. `https://agent.example.com`) |
| `email` | Yes | — | Login email |
| `password` | Yes | — | Login password |
| `deviceId` | No | `openclaw-default` | Unique device identifier |
| `deviceName` | No | `OpenClaw Agent` | Display name shown in mobile app |

## Verify

1. Start OpenClaw with the plugin configured
2. Open the Super Agent mobile app
3. The device list should show your OpenClaw Agent
4. Send a message — you should see the agent process it and stream the response back

## Requirements

- [OpenClaw](https://github.com/nicepkg/openclaw) installed and running
- A running Super Agent Server instance
- Super Agent Mobile App

## Platform Support

Works on **Windows**, **macOS**, and **Linux** — anywhere OpenClaw runs.

## License

MIT
