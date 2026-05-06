# Wiley Edge DXLink worker — Deno on alpine.
#
# We use the official denoland/deno image; it ships with deno
# binaries and certs. The worker is small (~5 source files, no
# bundled deps beyond what esm.sh ships at runtime).
#
# Fly.io spawns one instance and keeps it running; SIGTERM is sent
# during deploys so graceful shutdown in main.ts matters.

FROM denoland/deno:alpine-1.46.3

WORKDIR /app

# Cache deps separately from source so a code edit doesn't bust the
# layer that fetches @supabase/supabase-js etc.
COPY deno.json ./
COPY src/ ./src/

RUN deno cache src/main.ts

EXPOSE 8080
CMD ["deno", "run", "--allow-net", "--allow-env", "src/main.ts"]
