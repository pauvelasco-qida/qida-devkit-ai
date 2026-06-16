# Docker Diagnostics

## Build Performance Issues

**Symptoms**: Slow builds (10+ minutes), frequent full rebuilds

**Root causes & fixes:**

| Root Cause | Diagnosis | Fix |
|-----------|-----------|-----|
| Poor layer ordering | `COPY . .` before `npm install` | Move COPY source after dependency install |
| Large build context | `docker build` hangs on "Sending build context" | Add `.dockerignore`, check `docker build --no-cache 2>&1 \| head -3` |
| No package cache | Every build re-downloads dependencies | Use `--mount=type=cache` (BuildKit) |
| No layer reuse | Cache miss on every run | Check `docker history <image>` for unexpected changes |

**Debug commands:**
```bash
DOCKER_BUILDKIT=1 docker build --progress=plain . 2>&1 | grep -E "CACHED|RUN"
docker system df  # Check disk/cache usage
docker builder prune  # Clear build cache if corrupted
```

## Security Vulnerabilities

**Symptoms**: Security scan failures, root execution, credential exposure

**Diagnosis:**
```bash
docker inspect <container> | grep -i user   # Check running user
docker history <image> --no-trunc | grep -i "secret\|password\|key\|token"
docker scout cves <image> 2>/dev/null
```

**Common issues:**
- `USER root` (implicit or explicit) — add non-root user, set `USER 1001`
- Secrets in ENV: `ENV API_KEY=xxx` — use `--mount=type=secret` or runtime env injection
- Outdated base: `FROM node:14`/`node:18` (EOL) — update to a current LTS: `node:22-alpine`
- Setuid binaries: run `find / -perm /4000` inside container to detect

## Image Size Problems

**Symptoms**: Images >1GB, slow pushes/pulls

**Diagnosis:**
```bash
docker history <image> --no-trunc --format "{{.Size}}\t{{.CreatedBy}}" | sort -rh | head -10
docker image inspect <image> | jq '.[0].RootFS.Layers | length'
```

**Common causes:**
- Build tools in production (`gcc`, `make`, `git`) — use multi-stage, copy only artifacts
- Package manager cache not cleaned — add `&& npm cache clean --force` or `rm -rf /var/cache/apk/*`
- `.git` in build context — add to `.dockerignore`
- `apt-get install` without cleanup — add `&& rm -rf /var/lib/apt/lists/*`
- Test dependencies in production — use `npm ci --omit=dev` (not `npm install`)

## Networking Issues

**Symptoms**: Services can't reach each other, DNS failures

**Diagnosis:**
```bash
docker network ls
docker network inspect <network-name>
docker exec <container> nslookup <service-name>  # DNS check
docker exec <container> nc -zv <service-name> <port>  # TCP check
```

**Common causes:**

| Issue | Symptom | Fix |
|-------|---------|-----|
| Services on different networks | `nslookup` fails | Add both services to same network |
| Using `localhost` instead of service name | Connection refused | Use Compose service name as hostname |
| Port not exposed | TCP check fails | Add `expose:` or `ports:` to service |
| `internal: true` blocking external | Intended service unreachable from host | Move service to non-internal network |

## Development Workflow Problems

**Symptoms**: Hot reload not working, changes not reflected

**Diagnosis:**
```bash
docker exec <container> ls -la /app/src  # Check bind mount
docker inspect <container> | jq '.[0].Mounts'  # Verify mount config
```

**Common causes:**
- Missing bind mount: `volumes: - .:/app` not in dev override
- `node_modules` override: container's `node_modules` overwritten by host — add anonymous volume `/app/node_modules`
- File watcher not detecting cross-filesystem changes (macOS): use `CHOKIDAR_USEPOLLING=true`
- Dev stage inherits production CMD — override `command: npm run dev` in override file

## Container Startup Failures

**Symptoms**: Container exits immediately, restarts in loop

**Diagnosis:**
```bash
docker logs <container> --tail 50
docker inspect <container> | jq '.[0].State'
docker run --rm -it --entrypoint sh <image>  # Debug interactively
```

**Common patterns:**
- Missing env vars: check `docker inspect` for required env vars
- File permission errors: check if non-root user can read copied files (missing `--chown`)
- `depends_on` timing: service starts before DB ready — use health check condition
- Signal handling: app doesn't respond to SIGTERM — use `CMD ["node", "index.js"]` (exec form, not shell form)

## Compose Config Validation

```bash
docker compose config --quiet && echo "Valid"
docker compose config 2>&1 | grep -i "error\|warning"

# Check service resolution
docker compose ps
docker compose logs --tail=20 <service>

# Network/volume inspection
docker compose down && docker compose up --build  # Full reset
```
