#!/usr/bin/env bash
# Deploy this checkout to a host that runs the bridge as services of a Docker
# Compose project (the Forkluck host runs it beside Ghost in /opt/ghost).
#
#   deploy/deploy-to-compose.sh            sync, build, restart, verify
#   deploy/deploy-to-compose.sh rollback   restart the previously deployed image
#
# Every deploy first tags the running image as <image>:rollback, so rollback
# needs no rebuild. Settings come from the environment:
#   BRIDGE_DEPLOY_HOST  ssh destination (default: chefclaw)
#   BRIDGE_SOURCE_DIR   where the tree is synced (default: /opt/ghost-mail-bridge)
#   BRIDGE_COMPOSE_DIR  the compose project (default: /opt/ghost)
#   BRIDGE_SERVICES     compose services to restart (default: api and worker)
#   BRIDGE_IMAGE        the image the compose file builds (default: ghost-mail-bridge:local)
set -euo pipefail

host="${BRIDGE_DEPLOY_HOST:-chefclaw}"
source_dir="${BRIDGE_SOURCE_DIR:-/opt/ghost-mail-bridge}"
compose_dir="${BRIDGE_COMPOSE_DIR:-/opt/ghost}"
services="${BRIDGE_SERVICES:-ghost-mail-bridge ghost-mail-bridge-worker}"
image="${BRIDGE_IMAGE:-ghost-mail-bridge:local}"
rollback_image="${image%%:*}:rollback"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" "$@"; }

wait_healthy() {
    # Waits for every service's container to report a healthy check.
    remote "cd '$compose_dir' && for i in \$(seq 1 40); do ok=1; for s in $services; do \
        c=\$(docker compose ps -q \$s); st=\$(docker inspect --format '{{.State.Health.Status}}' \"\$c\" 2>/dev/null || echo none); \
        [ \"\$st\" = healthy ] || ok=0; done; [ \$ok = 1 ] && exit 0; sleep 3; done; \
        echo 'containers did not become healthy' >&2; docker compose ps; exit 1"
}

case "${1:-deploy}" in
    deploy)
        if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
            echo "Working tree has uncommitted changes; deploy from a clean checkout." >&2
            exit 1
        fi
        commit="$(git -C "$repo_root" rev-parse --short HEAD)"
        echo "Deploying $commit to $host ($compose_dir: $services)"

        remote "docker image inspect '$image' >/dev/null 2>&1 && docker tag '$image' '$rollback_image' && echo 'rollback image tagged' || echo 'no running image to tag'"

        # .env files and data on the host are never touched; --delete removes
        # files that left the repository.
        rsync -a --delete \
            --exclude node_modules --exclude .git --exclude '.env' --exclude '.env.*' \
            --exclude data --exclude '*.db' \
            "$repo_root/" "$host:$source_dir/"

        remote "cd '$compose_dir' && docker compose build -q $(echo "$services" | cut -d' ' -f1) && docker compose up -d $services"
        wait_healthy
        remote "cd '$compose_dir' && docker compose exec -T $(echo "$services" | cut -d' ' -f1) sh -c \
            'node -e \"console.log(\\\"express \\\" + require(\\\"express/package.json\\\").version)\" && wget -qO- http://localhost:3003/health | head -c 160'; echo"
        echo "Deployed $commit. Roll back with: $0 rollback"
        ;;
    rollback)
        remote "docker image inspect '$rollback_image' >/dev/null 2>&1" || {
            echo "No $rollback_image on $host; nothing to roll back to." >&2; exit 1; }
        remote "docker tag '$rollback_image' '$image' && cd '$compose_dir' && docker compose up -d $services"
        wait_healthy
        echo "Rolled back to the previous image."
        ;;
    *)
        echo "usage: $0 [deploy|rollback]" >&2; exit 2 ;;
esac
