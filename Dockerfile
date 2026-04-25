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
