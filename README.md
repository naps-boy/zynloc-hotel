# Zynloc Hotel

Full-stack hotel management SaaS starter for multi-hotel operations, guest QR access, Stripe payments, messaging, notifications, analytics, and branded manager dashboards.

## Stack

- React + Vite frontend
- Node.js + Express backend
- PostgreSQL with SQL migrations
- JWT authentication
- Stripe Checkout and webhooks
- Dynamic QR codes
- Socket.IO realtime dashboard updates
- Railway/Vercel ready
- Cloudflare Pages frontend configuration
- Cloudflare Workers API gateway configuration

## Run Locally

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

API: `http://localhost:4000`

Web: `http://localhost:5173`

For the instant local demo on a machine without PostgreSQL, use:

```env
DATABASE_URL=memory
```

That mode is for local previews only. Use PostgreSQL for durable production data.

## First Account

Create a hotel manager with:

```bash
curl -X POST http://localhost:4000/api/auth/register-manager \
  -H "Content-Type: application/json" \
  -d "{\"hotelName\":\"Zynloc Demo\",\"email\":\"manager@example.com\",\"password\":\"password123\"}"
```

## Development Workflow

- Feature development: work on `staging` branch
- Test on: https://zynloc-hotel-staging.pages.dev
- When confirmed working: merge `staging` to `main`
- Production deploys automatically to: https://zynloc-hotel.pages.dev

```bash
# Deploy to staging
bash scripts/deploy-staging.sh

# Deploy to production (merges staging → main)
bash scripts/deploy-production.sh
```

## Deployment

### Cloudflare Pages Frontend

1. In Cloudflare Pages, create a project from this repo.
2. Set root directory to `apps/web`.
3. Build command: `npm install && npm run build`.
4. Build output directory: `dist`.
5. Set `VITE_API_URL` to your API URL, for example `https://zynloc-hotel-api.YOUR_WORKERS_SUBDOMAIN.workers.dev`.
6. Update `apps/web/public/_redirects` with your real Workers subdomain.

### Cloudflare Workers API

The file `apps/api/wrangler.toml` is configured for a Workers API gateway under account `255506fe40e991eadaf19ab2d90dd426`.

Do not commit API tokens. Authenticate locally with:

```bash
cd apps/api
npx wrangler login
```

Then set production secrets:

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put JWT_SECRET
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_PRICE_ID
npx wrangler deploy
```

Important: the current production API is an Express/Socket.IO Node service. Cloudflare Workers do not run `app.listen()` Express servers directly, and PostgreSQL requires Cloudflare Hyperdrive or an HTTP-accessible database driver. The included Worker is a deployment gateway scaffold. For full production today, deploy `apps/api` on Railway with PostgreSQL, then point Cloudflare Pages `VITE_API_URL` at that API. A full edge-native Workers port would move each Express route into Worker request handlers and use Hyperdrive for PostgreSQL.

### Railway API

1. Deploy the root project.
2. Provision PostgreSQL.
3. Set `DATABASE_URL`, `JWT_SECRET`, Stripe keys, SMTP settings, and `CLIENT_URL`.
4. Run `npm run db:migrate`.
5. Start command: `npm start`.

WebSockets: Socket.IO works locally and on Railway. Through Cloudflare, keep WebSockets enabled in the Cloudflare Network settings and make sure the API host supports WebSocket upgrade requests.

## Notes

This codebase is production-oriented but still needs real hotel floor-plan data, SMTP credentials, Stripe products/prices, a real PostgreSQL database, and monitoring/secrets rotation before live launch.
