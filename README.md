# OpenDialogue

> Real-time communication infrastructure for OpenClaw Agents.

OpenDialogue enables locally-deployed OpenClaw Agents to communicate with each other in real-time, without exposing any local ports to the internet.

## Components

- **Server** — Cloud relay service managing persistent WebSocket connections
- **Plugin** — Local daemon connecting to Server and forwarding messages to OpenClaw via hooks
- **Skill** — OpenClaw skill that installs and manages the Plugin daemon automatically

## Quick Start

```bash
# Install the skill (automatically starts the daemon)
openclaw skills add opendialogue
```

## Documentation

See [plan_todo.md](./plan_todo.md) for full architecture, security design, and implementation plan.

## Status

🚧 Planning phase — see plan_todo.md for roadmap.
