# Cash Moves DXLink worker + Massive (Polygon) options scanner.
# Two Deno processes share this image; Fly's [processes] block in
# fly.toml picks the entrypoint per machine.
#
# We use the official denoland/deno image; it ships with deno
# binaries and certs. Both processes are small (~10 source files
# total, no bundled deps beyond what esm.sh ships at runtime).
#
# Fly.io spawns one instance per process and keeps each running;
# SIGTERM is sent during deploys so graceful shutdown in each
# main.ts matters.

FROM denoland/deno:alpine-1.46.3

WORKDIR /app

# Cache deps separately from source so a code edit doesn't bust the
# layer that fetches @supabase/supabase-js etc.
COPY deno.json ./
COPY src/ ./src/

# Cache both entry points so deno doesn't go to the network on cold
# start of either process.
RUN deno cache src/main.ts src/scanner/main.ts

# Default CMD is the dxlink worker — Fly's [processes] block in
# fly.toml overrides for the scanner machine. Local dev (`docker run`
# without override) still gets the worker.
CMD ["deno", "run", "--allow-net", "--allow-env", "src/main.ts"]
