# Gugu Quick Deployment Guide

This guide covers a standard deployment without cloning the source repository, including NAS systems that let you paste a complete Compose file. For reverse proxies, access control, backups, and troubleshooting, see the [operations deployment guide](ops/deploy.md).

## Requirements

- Docker 20+
- Docker Compose v2.20+
- Access to an LLM provider, or a BYOK configuration
- Network access to the image registries and model service

## Quick start: integrated Compose

Create a deployment directory and download only the Compose file and environment template:

```bash
mkdir -p gugu && cd gugu
curl -fsSL https://raw.githubusercontent.com/Coffeiz/Gugu-web/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/Coffeiz/Gugu-web/main/.env.example -o .env.example
cp .env.example .env
```

Edit `.env` and set at least a database password:

```dotenv
GUGU_DB_PASSWORD=replace-with-a-long-random-password
```

You can set the initial administrator credentials there as well. If `ADMIN_PASSWORD` is omitted, Gugu generates a random password on first startup, saves it in `Gugu-data/.env`, and prints it once in the container logs. No public default password is built into the image.

Start the services:

```bash
docker compose up -d
```

Compose pulls the unified `coffeiz/gugu-web` image and the SearXNG, egress proxy, and sandbox images from their registries. The deployment directory does not need source code or Git metadata. The unified image includes the frontend, Nginx, Uvicorn, worker, IM gateway, PostgreSQL, and Redis. The Compose project also runs SearXNG, `egress-proxy`, `sandboxd`, and a restricted updater service. The web app itself does not receive the Docker Socket.

Open <http://localhost:9595>. The admin interface is at <http://localhost:9595/admin/>. Keep `Gugu-data` and the Compose-managed configuration volumes; PostgreSQL and Redis data are stored under `Gugu-data`. Do not replace your local `.env` with the template.

## fnOS and other NAS: paste the complete Compose file

If your NAS Compose interface accepts YAML directly, create a project and paste the complete Compose file below. It includes the app, SearXNG, egress proxy, `sandboxd`, and updater, so web search and the Shell sandbox are available.

Set these values in the project `.env` or the panel's environment-variable form. Use an absolute path that exists on your NAS for `GUGU_DATA_HOST_DIR`. Set `GUGU_DOCKER_SOCKET` if your Docker Socket is at a different location.

```dotenv
GUGU_DB_PASSWORD=replace-with-a-long-random-password
GUGU_DATA_HOST_DIR=/absolute/path/on/your/nas/Gugu-data
GUGU_DOCKER_SOCKET=/var/run/docker.sock
```

If no administrator password is set, the first startup generates one and prints it in the container logs.

The YAML below is copied from the repository's `docker-compose.yml`. Keep it in sync when changing the deployment configuration.

```yaml
# Gugu one-step deployment: unified app image, search, and sandbox services.
# The Docker Socket is available only to sandboxd and the restricted updater, never directly to the web app.

name: gugu-web-compose

x-json-file-logging: &json-file-logging
  driver: json-file
  options:
    max-size: "50m"
    max-file: "3"

x-squid-config-command: &squid-config-command
  - |
    cat > /etc/squid/squid.conf <<'SQUID_CONF'
    http_port 3128
    cache deny all
    acl SSL_ports port 443
    acl Safe_ports port 80 443
    acl CONNECT method CONNECT
    acl private_dst dst 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 0.0.0.0/8
    acl private_dst6 dst ::1/128 fc00::/7 fe80::/10
    http_access deny !Safe_ports
    http_access deny CONNECT !SSL_ports
    http_access deny private_dst
    http_access deny private_dst6
    http_access allow all
    via off
    forwarded_for delete
    request_header_access X-Forwarded-For deny all
    request_header_access Via deny all
    SQUID_CONF
    exec /usr/sbin/squid -N -d 1

configs:
  searxng-settings:
    content: |
      # Built-in SearXNG configuration; JSON is required by Gugu web_search and image_search.
      use_default_settings: true

      server:
        secret_key: "gugu-compose-dev-change-me"
        limiter: false

      search:
        formats:
          - html
          - json

x-gugu-data-mount: &gugu-data-mount
  type: bind
  source: ${GUGU_DATA_HOST_DIR:-./Gugu-data}
  target: /data
  bind:
    create_host_path: true

x-app-environment: &app-environment
  GUGU_UNIFIED_APP: "1"
  # PostgreSQL and Redis are managed by the app image to avoid starting duplicate services in Compose.
  GUGU_EMBEDDED_DEPS: "1"
  GUGU_APP_PORT: "8001"
  GUGU_ENABLE_WORKER: "1"
  GUGU_ENABLE_GATEWAY: "1"
  GUGU_ENV_FILE: /data/.env
  GUGU_DATA_DIR: /data
  # Used to print a host-side directory repair command if startup fails; the actual mount is controlled by x-gugu-data-mount.
  GUGU_DATA_HOST_DIR: ${GUGU_DATA_HOST_DIR:-${PWD}/Gugu-data}
  SECRET_KEY: ${SECRET_KEY:-}
  ADMIN_USERNAME: ${ADMIN_USERNAME:-}
  ADMIN_PASSWORD: ${ADMIN_PASSWORD:-}
  GUGU_DB_PASSWORD: ${GUGU_DB_PASSWORD:-}
  DB__PASSWORD: ${GUGU_DB_PASSWORD:-}
  DB__HOST: 127.0.0.1
  DB__PORT: 5432
  DB__NAME: ${GUGU_DB_NAME:-gugu}
  DB__USER: ${GUGU_DB_USER:-gugu}
  REDIS__HOST: 127.0.0.1
  REDIS__PORT: 6379
  REDIS__PASSWORD: ${GUGU_REDIS_PASSWORD:-}
  PUBLIC_APP_URL: ${GUGU_PUBLIC_APP_URL:-http://localhost:9595}
  STORAGE__LOCAL_PATH: /data/users
  CREDENTIALS_MASTER_KEY_FILE: /data/byok/.byok-master-key
  GUGU_CONFIG_OVERRIDE_FILE: /config/config.override.json
  SEARCH__SEARXNG_URL: http://searxng:8080
  GUGU_LOG_FILE: /app/logs/gugu.log
  # The default Compose setup also starts a separate sandboxd; the single-container image does not manage it.
  SANDBOX__ROOTLESS_REQUIRED: ${GUGU_SANDBOX_ROOTLESS_REQUIRED:-false}
  SANDBOX__IMAGE: ${GUGU_SANDBOX_IMAGE:-coffeiz/gugu-sandbox:latest}
  SANDBOX__IMAGE_DIGEST: ${GUGU_SANDBOX_IMAGE_DIGEST:-resolved}
  GUGU_SANDBOX_IMAGE_DIGEST_FILE: /run/gugu/sandbox-image-digest
  SANDBOX__EGRESS_PROXY_URL: http://egress-proxy:3128
  SANDBOX__EGRESS_NETWORK_NAME: ${GUGU_SANDBOX_EGRESS_NETWORK_NAME:-gugu-sandbox-egress}
  SANDBOX__EGRESS_ISOLATION_ENABLED: "true"
  GUGU_SANDBOXD_SOCKET: /run/gugu/sandboxd.sock

services:
  searxng:
    image: searxng/searxng:latest
    logging: *json-file-logging
    configs:
      - source: searxng-settings
        target: /etc/searxng/settings.yml
    environment:
      SEARXNG_BASE_URL: ${SEARXNG_BASE_URL:-http://searxng:8080/}
      UWSGI_WORKERS: 2
      UWSGI_THREADS: 4
    mem_limit: 512m
    restart: unless-stopped

  app:
    image: ${GUGU_WEB_IMAGE:-coffeiz/gugu-web:latest}
    logging: *json-file-logging
    ports:
      - "${GUGU_HTTP_PORT:-9595}:9595"
    # Secrets, database password, and administrator password generated on first startup are saved to Gugu-data/.env.
    # Self-updates run through the separate updater RPC; the app does not hold the Docker Socket.
    environment:
      <<: *app-environment
      GUGU_SELF_UPDATE: ${GUGU_SELF_UPDATE:-on}
      GUGU_UPDATE_DEPLOYMENT_MODE: integrated_compose
      GUGU_UPDATER_RPC_SOCKET: /run/gugu-updater/updater.sock
      GUGU_UPDATER_COMPOSE_DIR: /workspace
      GUGU_UPDATER_COMPOSE_FILE: docker-compose.yml
      GUGU_UPDATER_STATE_DIR: ${GUGU_UPDATER_STATE_DIR:-/data/updater}
    volumes:
      - *gugu-data-mount
      - legacy_pgdata:/legacy-pgdata:ro
      - legacy_redisdata:/legacy-redisdata:ro
      - gugu_config:/config
      - gugu_logs:/app/logs
      - sandbox_socket:/run/gugu
      - updater_socket:/run/gugu-updater
      - ${GUGU_UPDATER_COMPOSE_DIR:-${PWD}}:/workspace:ro
    depends_on:
      searxng:
        condition: service_started
      updater:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://127.0.0.1:9595/health"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3
    restart: unless-stopped

  updater:
    image: ${GUGU_WEB_IMAGE:-coffeiz/gugu-web:latest}
    logging: *json-file-logging
    entrypoint: ["python", "-m", "updater.rpc_server"]
    environment:
      GUGU_UPDATE_DEPLOYMENT_MODE: integrated_compose
      GUGU_UNIFIED_APP: "1"
      GUGU_EMBEDDED_DEPS: "1"
      GUGU_SELF_UPDATE: ${GUGU_SELF_UPDATE:-on}
      GUGU_UPDATER_COMPOSE_DIR: ${GUGU_UPDATER_COMPOSE_DIR:-${PWD}}
      GUGU_UPDATER_COMPOSE_FILE: docker-compose.yml
      GUGU_UPDATER_STATE_DIR: /data/updater
      GUGU_UPDATER_RPC_SOCKET: /run/gugu-updater/updater.sock
      GUGU_DOCKER_SOCKET: /run/gugu-updater/docker.sock
      DOCKER_HOST: unix:///run/gugu-updater/docker.sock
    volumes:
      - *gugu-data-mount
      - updater_socket:/run/gugu-updater
      - ${GUGU_DOCKER_SOCKET:-/var/run/docker.sock}:/run/gugu-updater/docker.sock
      - ${GUGU_UPDATER_COMPOSE_DIR:-${PWD}}:${GUGU_UPDATER_COMPOSE_DIR:-${PWD}}:ro
    healthcheck:
      test: ["CMD-SHELL", "test -S /run/gugu-updater/updater.sock"]
      interval: 10s
      timeout: 3s
      start_period: 10s
      retries: 3
    restart: unless-stopped

  egress-proxy:
    image: ubuntu/squid:latest
    logging: *json-file-logging
    # Generate the configuration inline so NAS panels do not create a directory when squid/egress.conf is missing.
    entrypoint: ["/bin/sh", "-c"]
    command: *squid-config-command
    networks:
      - default
      - egress_internal
    restart: unless-stopped

  sandboxd:
    image: ${GUGU_SANDBOXD_IMAGE:-${GUGU_WEB_IMAGE:-coffeiz/gugu-web:latest}}
    logging: *json-file-logging
    pid: "host"
    # sandboxd is not a web service and must not run the default Compose database migration or worker entry point.
    entrypoint: ["sh", "-c"]
    command:
      - |
        sh /usr/local/bin/gugu-sandbox-init.sh
        exec python -m agent.sandbox.sandboxd --socket /run/gugu/sandboxd.sock --allowed-root /data/users
    # sandboxd serves over a Unix socket and does not use the unified web image HTTP health check.
    healthcheck:
      test: ["CMD-SHELL", "test -S \"$${GUGU_SANDBOXD_SOCKET}\""]
      interval: 10s
      timeout: 3s
      start_period: 10s
      retries: 3
    environment:
      DOCKER_HOST: unix:///run/gugu/docker.sock
      STORAGE__LOCAL_PATH: /data/users
      GUGU_SANDBOXD_SOCKET: /run/gugu/sandboxd.sock
      SANDBOX__ROOTLESS_REQUIRED: ${GUGU_SANDBOX_ROOTLESS_REQUIRED:-false}
      SANDBOX__IMAGE: ${GUGU_SANDBOX_IMAGE:-coffeiz/gugu-sandbox:latest}
      SANDBOX__IMAGE_DIGEST: ${GUGU_SANDBOX_IMAGE_DIGEST:-resolved}
      GUGU_SANDBOX_IMAGE_DIGEST_FILE: /run/gugu/sandbox-image-digest
      SANDBOX__EGRESS_PROXY_URL: http://egress-proxy:3128
      SANDBOX__EGRESS_NETWORK_NAME: ${GUGU_SANDBOX_EGRESS_NETWORK_NAME:-gugu-sandbox-egress}
      SANDBOX__EGRESS_ISOLATION_ENABLED: "true"
      SQUID_CONF_PATH: /opt/gugu/egress.conf
    volumes:
      - *gugu-data-mount
      - gugu_config:/config
      - sandbox_socket:/run/gugu
      - ${GUGU_DOCKER_SOCKET:-/var/run/docker.sock}:/run/gugu/docker.sock
      - /etc/passwd:/host/etc/passwd:ro
      - /etc/subuid:/host/etc/subuid:ro
      - /etc/subgid:/host/etc/subgid:ro
    depends_on:
      egress-proxy:
        condition: service_started
    restart: unless-stopped

volumes:
  gugu_config:
  gugu_logs:
  sandbox_socket:
  updater_socket:
  # Keep the legacy default Compose volume name and mount it read-only to detect PostgreSQL data that has not been migrated.
  # Deployments with a custom legacy project or volume name can specify the original volume via GUGU_LEGACY_PGDATA_VOLUME.
  legacy_pgdata:
    name: ${GUGU_LEGACY_PGDATA_VOLUME:-gugu-web-compose_pgdata}
  # The legacy default Compose Redis AOF volume is probed read-only during migration to avoid discarding unprocessed IM Streams.
  legacy_redisdata:
    name: ${GUGU_LEGACY_REDISDATA_VOLUME:-gugu-web-compose_redisdata}

networks:
  egress_internal:
    name: ${GUGU_SANDBOX_EGRESS_NETWORK_NAME:-gugu-sandbox-egress}
    internal: true

```

## Single-container Docker deployment

For NAS panels that only support creating a single container, you can run the unified image directly:

```bash
docker run -d --name gugu \
  -p 9595:9595 \
  -v /absolute/path/on/your/nas/Gugu-data:/data \
  -v /absolute/path/on/your/nas/Gugu-config:/config \
  -e GUGU_DB_PASSWORD=replace-with-a-long-random-password \
  coffeiz/gugu-web:latest
```

Open <http://localhost:9595>. Bind host directories for `/data` and `/config` so data persists when the container is recreated. `/data` stores the database, user files, and memory; `/config` stores Admin configuration. The container refuses to start without persistent data storage. For temporary evaluation only, `GUGU_ALLOW_ANONYMOUS_DATA=1` explicitly permits an anonymous volume, with a warning in the logs. It always refuses to run with data only in the container's writable layer.

If `SECRET_KEY` is omitted, the image creates a strong random key on first startup and saves it in persistent configuration. If `ADMIN_PASSWORD` is omitted, it generates a random password, stores it in `/data/.env`, and prints it once in the container logs (`docker logs gugu`). Set a strong `ADMIN_PASSWORD` explicitly for an Internet-facing deployment.

The single-container option does not include SearXNG or the Shell sandbox. Use the integrated Compose setup above when you need web search or sandboxed Shell execution.

## Configuration locations

The integrated Compose deployment reads Compose variables from the project-root `.env` and stores runtime configuration in `Gugu-data/.env`, mounted at `/data`. Split production deployments use `backend/.env`. Both deployment layouts can be supplemented or overridden at runtime by `config.override.json` in the Admin settings.

Common project-root `.env` settings:

```dotenv
GUGU_DB_PASSWORD=replace-with-a-database-password
GUGU_HTTP_PORT=9595
GUGU_PUBLIC_APP_URL=http://localhost:9595
GUGU_WEB_IMAGE=coffeiz/gugu-web:latest
GUGU_SANDBOX_ENABLED=true
GUGU_SANDBOX_NETWORK_PROFILE=egress
```

`GUGU_PUBLIC_APP_URL` must be the public site URL used by people, such as `https://gugu.example.com`; do not set it to an internal container address. Email verification and password-reset links use this value.

After signing in, configure the model provider, BYOK, web search, email, and IM integrations in the Admin interface. Do not commit real passwords, tokens, or API keys.

## Shell sandbox

The integrated Compose setup starts `sandboxd` and a restricted egress proxy. In online mode it pulls the official `gugu-sandbox` execution image and pins its resolved digest. The execution image runs separately from `gugu-web` and is distributed alongside the app, proxy, and search images.

The default setup supports a Rootful host Docker daemon. For production, set `GUGU_SANDBOX_ROOTLESS_REQUIRED=true` to require Rootless Docker. The Docker Socket must be available to Compose; the default is `/var/run/docker.sock`. For Rootless Docker, set `GUGU_DOCKER_SOCKET` to the correct Socket path. To disable the sandbox, set `GUGU_SANDBOX_ENABLED=false` and stop `sandboxd` and `egress-proxy`. Do not mount sensitive host directories into sandbox containers.

If you override `GUGU_SANDBOX_IMAGE`, also set the matching `GUGU_SANDBOX_IMAGE_DIGEST`. Automatic digest resolution is intended for the official published execution image.

## Production deployment

The integrated image is the recommended option for most production deployments. Use a fixed release tag or image digest instead of `latest`:

```dotenv
GUGU_WEB_IMAGE=coffeiz/gugu-web:v1.x.y
GUGU_DB_PASSWORD=replace-with-a-database-password
```

Then start it with:

```bash
docker compose up -d
```

Prepare persistent storage and back up the database and user files before deploying.

For deployments that need separate frontend and backend images, use `docker-compose.prod.yml`:

```bash
export GUGU_BACKEND_IMAGE='docker.io/coffeiz/gugu-web-backend:v1.x.y'
export GUGU_FRONTEND_IMAGE='docker.io/coffeiz/gugu-web-frontend:v1.x.y'
export GUGU_DB_PASSWORD='replace-with-a-database-password'
docker compose -f docker-compose.prod.yml up -d
```

Both layouts use the same user-data directory. Follow the operations deployment guide before changing between layouts; their runtime configuration and database setup are not interchangeable as-is.

To store user data in a different host directory, set an absolute path in the project-root `.env`:

```dotenv
GUGU_DATA_HOST_DIR=/srv/gugu-data
```

Docker creates the directory when needed. Ensure the Docker daemon can read and write it.

## Development deployment

Developers who need source mounts, the Vite server, and local builds can use the separate Dev Compose file:

```bash
docker compose -f docker-compose.dev.yml up -d
```

## Status, logs, and stopping

```bash
docker compose ps
docker compose logs -f app
docker compose down
```

`docker compose down` keeps the data volumes. Do not use `docker compose down -v`, which removes Compose-managed volumes.
