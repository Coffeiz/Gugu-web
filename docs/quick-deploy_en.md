# Gugu Quick Deployment Guide

This guide recommends running the unified Docker Hub image directly, and also covers optional integrated Compose deployment and NAS container-manager settings. For reverse proxies, access control, backups, and troubleshooting, see the [operations deployment guide](ops/deploy.md).

## Get the image

The unified `gugu-web` image is published to both Docker Hub and GitHub Container Registry (GHCR). Pull it from either registry:

```bash
docker pull docker.io/coffeiz/gugu-web:latest
# or
docker pull ghcr.io/coffeiz/gugu-web:latest
```

For production, prefer a fixed release tag (`v<version>`) over `latest`. GHCR is an explicit alternative if Docker Hub is unavailable; to use it with Compose, set `GUGU_WEB_IMAGE=ghcr.io/coffeiz/gugu-web:<version>` in the project-root `.env`.

If your NAS cannot pull images directly, pull the image on a computer or server with Docker and export an uncompressed tar for import into fnOS:

```bash
docker save -o gugu-web.tar docker.io/coffeiz/gugu-web:latest
```

## Requirements

- Docker 20+ and a Linux `amd64` Docker Engine for the unified image
- Docker Compose v2.20+ for the Compose path
- Access to an LLM provider, or a BYOK configuration
- Network access to the image registries and model service

## Recommended: run the Docker Hub unified image

On a Linux host, create a deployment directory, then pull and run the official Docker Hub image:

```bash
mkdir -p gugu/Gugu-data gugu/Gugu-config
cd gugu
docker pull docker.io/coffeiz/gugu-web:latest
docker run -d --name gugu-web \
  --restart unless-stopped \
  --privileged \
  --publish 9595:9595 \
  --volume "$PWD/Gugu-data:/data" \
  --volume "$PWD/Gugu-config:/config" \
  docker.io/coffeiz/gugu-web:latest
```

Open <http://localhost:9595>; the Admin interface is at <http://localhost:9595/admin/>. On first start, the database is initialized and migrations are applied. If `ADMIN_PASSWORD` is omitted, a random password is saved to `Gugu-data/.env` and printed once in the container logs; retrieve and save it with `docker logs gugu-web`. `ADMIN_USERNAME` defaults to `admin`. Configure the model provider and API key in Admin after signing in.

`Gugu-data` stores user data and runtime configuration; `Gugu-config` stores Admin configuration. Back up both directories and the database before upgrading. To upgrade, pull the target image, stop and remove the old container, then run the new container with the same port and directory mappings. Keep the data directories. For production, use a fixed version tag or digest so `latest` cannot resolve to different versions across deployments.

The image includes the complete site, embedded PostgreSQL/Redis, an internal Rootless Docker runtime, the sandbox manager, and the Shell execution image. Shell is enabled by default; no separate `sandboxd`, execution-image import, or host Docker socket mount is needed. SearXNG is not included, so web search is unavailable in single-container mode.

> **Security:** privileged mode increases host risk if the outer app container is compromised. Internal Rootless only isolates the Shell execution containers; it does not remove the host risk of the outer app. This mode is intended for trusted personal, single-user deployments—not multi-tenant, public-facing, or business servers.

## Optional: Compose with web search

`docker-compose.yml` also uses the unified `coffeiz/gugu-web` app image and adds SearXNG for web search. It does not deploy an updater sidecar or mount the host Docker socket; the app runs Rootless Docker inside its privileged outer container.

To use this path, download the Compose file and environment template from GitHub, set `GUGU_DB_PASSWORD`, and start the stack:

```bash
mkdir -p gugu-compose && cd gugu-compose
curl -fsSL https://raw.githubusercontent.com/Coffeiz/Gugu-web/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/Coffeiz/Gugu-web/main/.env.example -o .env
# Edit .env and set GUGU_DB_PASSWORD
docker compose up -d
```

Compared with running the image directly, Compose adds web search and orchestration, but does not provide Admin image self-updates; use Docker/Compose to update the complete image stack. Shell still uses the runtime bundled in `gugu-web`. **This Compose file does not start a separate `updater` or `sandboxd` service or pull a separate `gugu-sandbox` execution image.** The first startup initializes the embedded database and runs migrations; user data is stored in `Gugu-data`.

Keep `docker-compose.yml` and the project-root `.env`, and set `GUGU_DB_PASSWORD`. You may also configure administrator credentials, port, and image version. If `ADMIN_PASSWORD` is omitted, a random password is generated and persisted at first startup, and the administrator username and password are printed in the app container logs (`docker compose logs app`). The username defaults to `admin` if `ADMIN_USERNAME` is omitted. `SECRET_KEY` can be omitted; it is generated and persisted on first startup. Open <http://localhost:9595>; the Admin interface is at <http://localhost:9595/admin/>. Do not delete `Gugu-data` or overwrite an existing `.env` with the template.

For a split frontend/backend deployment, use `docker-compose.prod.yml`; see the [operations deployment guide](ops/deploy.md) for its topology and additional services. Do not mix its configuration with the integrated Compose deployment.

## fnOS / Synology NAS configuration

In the NAS container's advanced settings, enable privileged mode, map port `9595`, and bind persistent host directories to `/data` and `/config`. This is equivalent to Docker's `--privileged` and is required for the internal Rootless Docker Shell sandbox; **do not mount the host's `/var/run/docker.sock`**. Ensure the mapped NAS folders are writable by the container.

- **fnOS:** in the Docker container's advanced settings, under “功能” (Capabilities), select “使用最高权限执行容器” (run container with highest privileges). See the [fnOS Help Center](https://help.fnnas.com/); the exact label is shown in the fnOS container UI.
- **Synology DSM 7:** in Container Manager's container creation/edit settings, under “Capability,” enable “Execute container using high privilege.” See [Synology's official container settings documentation](https://kb.synology.com/index.php/zh-hk/DSM/help/ContainerManager/docker_container?version=7).

The single-image Shell sandbox has been verified on fnOS. After deployment, open the host port actually mapped to this container; Admin should report the embedded Rootless daemon as ready.

## Configuration locations

The integrated Compose deployment reads Compose variables from the project-root `.env` and stores runtime configuration in `Gugu-data/.env`, mounted at `/data`. Split production deployments use `backend/.env`. Both deployment layouts can be supplemented or overridden at runtime by `config.override.json` in the Admin settings.

Common project-root `.env` settings:

```dotenv
GUGU_DB_PASSWORD=replace-with-a-database-password
GUGU_HTTP_PORT=9595
GUGU_PUBLIC_APP_URL=http://localhost:9595
GUGU_WEB_IMAGE=coffeiz/gugu-web:latest
```

`GUGU_PUBLIC_APP_URL` must be the public site URL used by people, such as `https://gugu.example.com`; do not set it to an internal container address. Email verification and password-reset links use this value.

After signing in, configure the model provider, BYOK, web search, email, and IM integrations in the Admin interface. Do not commit real passwords, tokens, or API keys.

## Production deployment

The integrated image is the recommended option for most production deployments. Use a fixed release tag or image digest instead of `latest`:

```dotenv
GUGU_WEB_IMAGE=coffeiz/gugu-web:v1.x.y
GUGU_DB_PASSWORD=replace-with-a-database-password
```

For Compose, start it with:

```bash
docker compose up -d
```

Prepare persistent storage and back up the database and user files before deploying.

For deployments that need separate frontend and backend images, use `docker-compose.prod.yml`. This is a separate deployment topology, not a required part of the quick deployment path:

```bash
export GUGU_BACKEND_IMAGE='docker.io/coffeiz/gugu-web-backend:v1.x.y'
export GUGU_FRONTEND_IMAGE='docker.io/coffeiz/gugu-web-frontend:v1.x.y'
export GUGU_DB_PASSWORD='replace-with-a-database-password'
docker compose -f docker-compose.prod.yml up -d
```

Back up the database and user files before production upgrades. Follow the operations deployment guide before switching between integrated and split layouts; their runtime configuration and database setup are not interchangeable as-is.

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
