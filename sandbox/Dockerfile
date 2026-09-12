# Per-project workspace image (see PLAN.md section 4.3 "Workspaces").
#
# One container is started per project from this image. The project's repos
# are cloned into a named volume mounted at /workspace, and agents run
# claude_code / codex / shell / git tools inside it.

FROM node:22-bookworm

# Base OS tooling agents rely on: python3/pip for scripts and MCP servers,
# git for version control, ripgrep for fast code search, curl for health
# checks and downloading files.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    git \
    ripgrep \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# TODO: install the Claude Agent SDK / Claude Code CLI once this can be
# verified against the real npm registry (no network access in this
# scaffolding sandbox):
# RUN npm install -g @anthropic-ai/claude-agent-sdk @anthropic-ai/claude-code

# TODO: install the Codex CLI once this can be verified against the real npm
# registry:
# RUN npm install -g @openai/codex

WORKDIR /workspace

# Run as a non-root user so agent-executed shell/tool commands are not root
# inside the sandbox.
RUN groupadd --gid 1000 katnor \
    && useradd --uid 1000 --gid katnor --shell /bin/bash --create-home katnor \
    && chown -R katnor:katnor /workspace

USER katnor

CMD ["sleep", "infinity"]
