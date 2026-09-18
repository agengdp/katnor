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
    python3-venv \
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

# The `codex` work tool (@katnor/agents' src/workTools.ts, Phase 5) runs
# this CLI the same way - non-interactively via `docker exec`.
# OPENAI_API_KEY is forwarded per-exec by that work tool, same as
# ANTHROPIC_API_KEY above, so nothing needs to be baked in here for auth.
RUN npm install -g @openai/codex

# graphify (https://github.com/Graphify-Labs/graphify, Apache-2.0) is the
# tree-sitter code indexer behind @katnor/knowledge's codeIndexer.ts. That
# module runs `graphify extract . --code-only` in a repo clone here, then
# maps the graph.json it writes onto kg_node/kg_edge. `--code-only` keeps it
# to the local AST pass, so no API key is needed and nothing is forwarded
# per-exec for it, unlike the two CLIs above.
#
# Installed into its own venv rather than via a bare `pip install`: Debian
# bookworm marks the system Python as externally managed (PEP 668), so a
# plain install refuses unless told to --break-system-packages, and writing
# into system site-packages to get around that is worse than an isolated
# venv. The symlink is what puts `graphify` on PATH for `docker exec`.
#
# Pinned deliberately: graphify is pre-1.0, and its graph.json shape is the
# contract codeIndexer.ts parses. Unpinned, an image rebuild could change
# that contract with nothing in this repo having changed.
RUN python3 -m venv /opt/graphify \
    && /opt/graphify/bin/pip install --no-cache-dir graphifyy==0.9.63 \
    && ln -s /opt/graphify/bin/graphify /usr/local/bin/graphify

WORKDIR /workspace

# Run as a non-root user so agent-executed shell/tool commands are not root
# inside the sandbox.
RUN groupadd --gid 1000 katnor \
    && useradd --uid 1000 --gid katnor --shell /bin/bash --create-home katnor \
    && chown -R katnor:katnor /workspace

USER katnor

CMD ["sleep", "infinity"]
