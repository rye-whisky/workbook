#!/usr/bin/env bash
set -euo pipefail

cd /opt/workbook
git pull --ff-only
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pm2 restart workbook-api || pm2 start apps/api/dist/server.js --name workbook-api
