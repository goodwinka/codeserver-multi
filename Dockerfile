FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TZ=UTC

# Base tools + runtimes commonly used inside code-server
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg lsb-release \
        git openssh-client sudo less vim-tiny \
        build-essential python3 python3-pip python3-venv \
        locales tzdata \
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Node.js 20 LTS (used by both the auth-proxy and by code-server runtime tooling)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# code-server (official installer)
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Language server system dependencies:
#   clangd        — C/C++ LSP
#   default-jdk-headless — JVM runtime for kotlin-language-server
#   unzip         — extract kotlin-language-server release archive
#   cmake ninja-build — cmake-language-server introspection
#   Qt5 dev headers — qt5-qmake / qtbase5-dev / qttools5-dev for Qt5 projects
RUN apt-get update && apt-get install -y --no-install-recommends \
        clangd \
        default-jdk-headless \
        unzip \
        cmake \
        ninja-build \
        qt5-qmake \
        qtbase5-dev \
        qttools5-dev \
        qttools5-dev-tools \
        libqt5widgets5 \
    && rm -rf /var/lib/apt/lists/*

# Python language servers (installed system-wide; --break-system-packages required on Debian 12)
RUN pip3 install --no-cache-dir --break-system-packages \
        "python-lsp-server[all]" \
        cmake-language-server

# Node.js language servers installed globally:
#   bash-language-server         — Bash LSP
#   vscode-langservers-extracted — CSS / HTML / JSON language servers
#   pyright                      — Python type-checking LSP
RUN npm install -g --no-fund --no-audit \
        bash-language-server \
        vscode-langservers-extracted \
        pyright

# Kotlin language server — download prebuilt release from GitHub
ARG KOTLIN_LS_VERSION=1.3.13
RUN curl -fsSL \
        "https://github.com/fwcd/kotlin-language-server/releases/download/${KOTLIN_LS_VERSION}/server.zip" \
        -o /tmp/kotlin-ls.zip \
    && unzip -q /tmp/kotlin-ls.zip -d /opt/kotlin-language-server \
    && rm /tmp/kotlin-ls.zip \
    && ln -sf /opt/kotlin-language-server/server/bin/kotlin-language-server \
              /usr/local/bin/kotlin-language-server

# Directory layout
# /users                  — user home directories (bind-mounted from host)
# /opt/shared-extensions  — shared extensions dir used by every user's code-server
# /config                 — users.json + runtime config (bind-mounted from host)
# /app                    — auth-proxy source
RUN mkdir -p /users /opt/shared-extensions /config /app \
    && chmod 711 /users \
    && chmod 755 /opt/shared-extensions

WORKDIR /app

# Install JS deps first for layer caching
COPY auth-proxy/package.json auth-proxy/package-lock.json* /app/
RUN npm install --omit=dev

# Copy the rest of the proxy sources
COPY auth-proxy/ /app/

# Scripts and default config
COPY scripts/ /scripts/
COPY config/ /config.default/
RUN chmod +x /scripts/*.sh

EXPOSE 8080

ENTRYPOINT ["/scripts/entrypoint.sh"]
