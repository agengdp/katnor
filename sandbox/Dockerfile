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

# The `claude_code` work tool (@katnor/agents' src/workTools.ts) runs this
# CLI non-interactively via `docker exec` (DockerWorkspaceManager.exec) -
# see that file's doc comment for why it goes through the CLI rather than
# embedding @anthropic-ai/claude-agent-sdk's `query()` directly.
# ANTHROPIC_API_KEY is forwarded per-exec by that same work tool (this
# container has no other route to apps/worker's own env), so nothing needs
# to be baked into this image for auth.
RUN npm install -g @anthropic-ai/claude-code

# Codex isn't one of Phase 2's implemented work tools (PLAN.md 4.3 scoped
# this phase to shell/claude_code/GitHub MCP/web_search/web_fetch) - left
# here as a TODO for whichever later phase adds it:
# RUN npm install -g @openai/codex

WORKDIR /workspace

# Run as a non-root user so agent-executed shell/tool commands are not root
# inside the sandbox.
RUN groupadd --gid 1000 katnor \
    && useradd --uid 1000 --gid katnor --shell /bin/bash --create-home katnor \
    && chown -R katnor:katnor /workspace

USER katnor

CMD ["sleep", "infinity"]
