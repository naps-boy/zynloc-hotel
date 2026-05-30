#!/bin/bash
set -e
echo "Deploying to staging..."
git checkout staging
git push origin staging
cd apps/web && VITE_API_URL=https://zynloc-hotel-api-staging.onrender.com npm run build
npx wrangler pages deploy dist --project-name zynloc-hotel-staging
echo "Staging deployment complete"
