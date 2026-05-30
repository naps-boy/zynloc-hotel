#!/bin/bash
set -e
echo "Deploying to production..."
git checkout main
git merge staging --no-edit
git push origin main
cd apps/web && npm run build
npx wrangler pages deploy dist --project-name zynloc-hotel
echo "Production deployment complete"
