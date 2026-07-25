#!/bin/bash
# start-cvm-kalman-server.sh — Start the ContextVM Kalman Data Server
# Runs as a persistent background process
set -e

cd ~/repos/cvm-kalman-server

export NODE_OPTIONS="--experimental-sqlite"

exec npx tsx server.ts
