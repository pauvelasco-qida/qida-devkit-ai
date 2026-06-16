# Docker Compose Patterns

## Production-Ready Compose

```yaml
# version key omitted — Compose Specification default (Docker Compose v2+)
services:
  app:
    build:
      context: .
      target: production
    restart: unless-stopped        # honored by `docker compose up`; deploy.restart_policy is Swarm-only
    depends_on:
      db:
        condition: service_healthy
    networks:
      - frontend
      - backend
    healthcheck:
      # wget (BusyBox) — alpine/distroless images have no curl; runs inside the container
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    deploy:                        # deploy.* only fully applies under Swarm / `docker stack deploy`
      resources:
        limits:                    # limits.memory IS honored by `docker compose up`
          cpus: '0.5'
          memory: 512M
        reservations:              # reservations are Swarm-only — ignored by plain `docker compose up`
          cpus: '0.25'
          memory: 256M
      restart_policy:              # Swarm-only — non-swarm uses top-level `restart:` (above)
        condition: on-failure
        delay: 5s
        max_attempts: 3
        window: 120s

  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB_FILE: /run/secrets/db_name
      POSTGRES_USER_FILE: /run/secrets/db_user
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_name
      - db_user
      - db_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - backend
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
    internal: true  # Backend services unreachable from host

volumes:
  postgres_data:

secrets:
  db_name:
    external: true
  db_user:
    external: true
  db_password:
    external: true
```

## Development Override

`docker-compose.override.yml` (auto-loaded with `docker compose up`):

```yaml
services:
  app:
    build:
      target: development
    volumes:
      - .:/app
      - /app/node_modules   # Anonymous volume prevents host node_modules overwrite
      - /app/dist
    environment:
      - NODE_ENV=development
      - DEBUG=app:*
    ports:
      - "9229:9229"  # Node.js debugger
    command: npm run dev
```

### Volume mount gotchas

- Always add anonymous volumes for directories that should NOT sync from host (`/app/node_modules`)
- Use named volumes for persistent data (databases) — never bind-mount DB data dirs
- Bind-mount source only; let container manage build artifacts

## Resource Management

> **Swarm vs plain Compose**: the `deploy:` block only *fully* applies under Swarm
> (`docker stack deploy`). With `docker compose up`, only `deploy.resources.limits` is
> honored — `reservations`, `restart_policy`, and `replicas` are **silently ignored**.
> For single-host Compose use the top-level `restart:` and CLI `--scale` instead.

```yaml
services:
  app:
    restart: unless-stopped     # non-swarm restart policy (or: on-failure)
    deploy:
      resources:
        limits:                 # honored by `docker compose up`
          cpus: '1.0'
          memory: 1G
        reservations:           # Swarm-only — ignored by plain `docker compose up`
          cpus: '0.5'
          memory: 512M
      restart_policy:           # Swarm-only — use top-level `restart:` for non-swarm
        condition: on-failure
        delay: 5s
        max_attempts: 3
        window: 120s
```

`limits` = hard ceiling (OOM kill if exceeded)
`reservations` = guaranteed minimum (scheduler hint, **Swarm only**)

Top-level `restart:` values (non-swarm): `no` | `always` | `on-failure[:max-retries]` |
`unless-stopped`.

## Networking Patterns

```yaml
networks:
  frontend:    # Exposed services (nginx, app)
    driver: bridge
  backend:     # Internal services (db, cache, queue)
    driver: bridge
    internal: true   # No external connectivity
  monitoring:  # Metrics collectors
    driver: bridge
    internal: true
```

Service placement rules:
- Web-facing: `frontend` only
- App servers: `frontend` + `backend`
- Databases, caches: `backend` only
- Monitoring: `monitoring` only, all services expose metrics there

## Secrets Management

### Docker secrets (Swarm-compatible)

```yaml
secrets:
  db_password:
    file: ./secrets/db_password.txt   # Development
    # external: true                  # Production (Swarm/managed)
```

Services access secrets at `/run/secrets/<name>` — read at startup, never in env vars.

### Build-time secrets (BuildKit)

```bash
DOCKER_BUILDKIT=1 docker compose build \
  --secret id=npm_token,src=$HOME/.npmrc
```

## Multi-Environment Config

Structure:
```
docker-compose.yml           # Base (shared)
docker-compose.override.yml  # Dev (auto-loaded)
docker-compose.prod.yml      # Production
docker-compose.test.yml      # CI/testing
```

Run specific env:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Common Service Patterns

### Redis

```yaml
redis:
  image: redis:7-alpine
  command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
  volumes:
    - redis_data:/data
  networks:
    - backend
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 10s
    timeout: 5s
    retries: 3
```

### Nginx reverse proxy

```yaml
nginx:
  image: nginx:alpine
  ports:
    - "80:80"
    - "443:443"
  volumes:
    - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    - ./nginx/certs:/etc/nginx/certs:ro
  depends_on:
    app:
      condition: service_healthy
  networks:
    - frontend
```

### Background worker (same image, different command)

```yaml
worker:
  build:
    context: .
    target: production
  command: npm run worker
  depends_on:
    db:
      condition: service_healthy
    redis:
      condition: service_healthy
  restart: unless-stopped
  networks:
    - backend
  deploy:
    replicas: 2   # Swarm-only — for plain Compose scale via CLI: `docker compose up --scale worker=2`
```
