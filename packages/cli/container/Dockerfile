# relay worker image (docs/WORKERS.md, "Isolation"): everything `relay work` needs, in one Linux VM.
#
# `relay work --isolation container --install` builds this with Apple's `container` CLI and creates the container
# `relay-work` from it, with a named volume at /home/relay. The vendor CLIs' logins, the site token, the clones and
# the model's shell all live in that volume; the Mac's home directory is never mounted. Everything the image
# installs goes under /usr/local, because the volume hides whatever the image put in /home/relay.
#
# Build arguments:
#   RELAY_SPEC     what `npm install -g` gets for relay when the build context holds no tarball
#                  (`@kyleroche/relay@<version>`); a checkout drops its `npm pack` tarball into the context instead
#   FX_VERSION     fx release (`vX.Y.Z`); `latest` reads https://releases.fx.sh/latest.txt
#   CLAUDE_SPEC    the Claude Code npm package spec
FROM docker.io/library/node:24-bookworm-slim

ARG RELAY_SPEC=@kyleroche/relay
ARG FX_VERSION=latest
ARG CLAUDE_SPEC=@anthropic-ai/claude-code
ARG DEBIAN_FRONTEND=noninteractive

# git, curl and CA certificates for the clone and the installers; bubblewrap, socat and ripgrep for Claude Code's own
# sandbox around the lane's Bash (nested inside the VM: the container is created with the runtime masks off so a
# user namespace can mount /proc); util-linux for `setpriv`; gh from GitHub's own apt repository.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg procps util-linux bubblewrap socat ripgrep less \
 && install -d -m 0755 /usr/share/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# fx: the release tarball for this architecture, verified against the .sha256 the CDN publishes beside it.
RUN set -eu; \
    arch="$(uname -m)"; case "$arch" in aarch64|arm64) arch=aarch64;; x86_64|amd64) arch=x86_64;; *) echo "unsupported arch $arch" >&2; exit 1;; esac; \
    v="$FX_VERSION"; if [ "$v" = latest ]; then v="$(curl -fsSL https://releases.fx.sh/latest.txt | tr -d '[:space:]')"; fi; \
    cd /tmp; curl -fsSL "https://releases.fx.sh/$v/fx-linux-$arch.tar.gz" -o fx.tar.gz; \
    curl -fsSL "https://releases.fx.sh/$v/fx-linux-$arch.tar.gz.sha256" -o fx.sha256; \
    want="$(tr -d '[:space:]' < fx.sha256 | cut -c1-64)"; have="$(sha256sum fx.tar.gz | cut -c1-64)"; \
    [ "$want" = "$have" ] || { echo "fx checksum mismatch: $want != $have" >&2; exit 1; }; \
    tar -xzf fx.tar.gz; install -m 0755 fx /usr/local/bin/fx; rm -f fx fx.tar.gz fx.sha256; \
    fx --version

# pnpm through corepack (the Node image ships it), Claude Code (its postinstall puts the native binary in place, so
# it is allowed by name), and relay: a tarball from the build context when a checkout built this image, the npm
# package otherwise.
COPY . /tmp/ctx/
RUN set -eu; \
    corepack enable && corepack prepare pnpm@latest --activate; \
    npm install -g --no-fund --no-audit --allow-scripts=@anthropic-ai/claude-code "$CLAUDE_SPEC"; \
    tgz="$(ls /tmp/ctx/*.tgz 2>/dev/null | head -n1 || true)"; \
    if [ -n "$tgz" ]; then npm install -g --no-fund --no-audit "$tgz"; else npm install -g --no-fund --no-audit "$RELAY_SPEC"; fi; \
    npm cache clean --force; rm -rf /tmp/ctx; \
    claude --version; relay --version

# The worker's user. The volume mounted at /home/relay arrives owned by root; relay-entry hands it over on first boot.
RUN userdel -r node 2>/dev/null || true; \
    groupadd -g 1000 relay && useradd -m -u 1000 -g 1000 -s /bin/bash relay
COPY --chmod=0755 relay-entry /usr/local/bin/relay-entry

ENV RELAY_HOME=/home/relay/.harness \
    RELAY_ISOLATION=container \
    HOME=/home/relay
WORKDIR /home/relay
ENTRYPOINT ["/usr/local/bin/relay-entry"]
CMD ["relay", "work"]
