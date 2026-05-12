# Cash Moves Massive (Polygon) options-flow scanner — Deno on alpine.

FROM denoland/deno:alpine-1.46.3

WORKDIR /app

COPY deno.json ./
COPY src/ ./src/

RUN deno cache src/main.ts

CMD ["deno", "run", "--allow-net", "--allow-env", "src/main.ts"]
