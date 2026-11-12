#!/usr/bin/env bash
# Verifikasi image `nstax` secara nyata (jalankan di mesin yang punya Docker):  bash docker/verify.sh
set -euo pipefail
IMG="${IMG:-nstax:latest}"; PORT="${PORT:-3000}"; NAME="nstax-verify-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }; trap cleanup EXIT
pass() { echo "  ✔ $1"; }; die() { echo "  ✘ $1"; exit 1; }

echo "[1/6] build"; docker build -t "$IMG" .
echo "[2/6] tes kode V1 (vitest)"; docker build --target test . >/dev/null && pass "vitest lulus"
echo "[3/6] jalankan container"; docker run -d --name "$NAME" -p "$PORT:3000" "$IMG" >/dev/null
for i in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 1; [ "$i" = 30 ] && { docker logs "$NAME"; die "container tidak merespons"; }; done
pass "halaman utama merespons di port $PORT"
[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] && pass "proses tetap berjalan"
echo "[4/6] route & aset"
curl -fs "http://127.0.0.1:$PORT/" | grep -q '<div id="root">' && pass "index.html V1 disajikan"
ASSET=$(curl -fs "http://127.0.0.1:$PORT/" | grep -oE '/assets/[^"]+\.js' | head -1); [ -n "$ASSET" ] && curl -fs -o /dev/null "http://127.0.0.1:$PORT$ASSET" && pass "aset JS $ASSET dapat diunduh"
curl -fs -o /dev/null "http://127.0.0.1:$PORT/favicon.svg" && pass "file statis /favicon.svg"
echo "[5/6] isi image tidak memuat V2"
docker run --rm --entrypoint sh "$IMG" -c '
  ! find /app -path /app/node_modules -prune -o \( -ipath "*/v2/*" -o -iname "*v2*" \) -print | grep -q . &&
  ! grep -rlE "v2-btn|v2-banner|v2-embed|v2-root|V2App|LegacyEmbed" /app/dist' && pass "tidak ada berkas/penanda V2 di /app (dist)"
docker run --rm --entrypoint sh "$IMG" -c 'ls /app/.env* 2>/dev/null | grep -q .' && die ".env ditemukan di image" || pass "tidak ada .env di image"
echo "[6/6] log startup"; docker logs "$NAME" 2>&1 | grep -q "Server running" && pass "server start tanpa error"
echo "SEMUA PEMERIKSAAN LULUS"
