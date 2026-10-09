# Railway Deployment Guide

## Quick Deploy

1. Go to https://railway.com and sign in with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your Wake repository
4. Railway will auto-detect the Dockerfile

## Configure Services

### Backend Service

1. Click on the backend service
2. Go to "Variables" tab
3. Add these environment variables:

```
WAKE_DRY_RUN=true
WAKE_LIGHTER_NETWORK=mainnet
WAKE_DB_PATH=/app/data/wake.db
WAKE_AUDIT_DB_PATH=/app/data/audit.db
WAKE_CORS_ORIGINS=https://wake-7k6.pages.dev
WAKE_SIGNING_SERVICE_URL=${SIGNING_SERVICE_URL}
WAKE_DATABASE_URL=${POSTGRES_DATABASE_URL}
WAKE_REDIS_URL=${REDIS_URL}
```

4. Go to "Settings" → "Networking" → "Generate Domain"
5. Copy the generated URL (e.g., `https://wake-backend.up.railway.app`)
6. Update `WAKE_CORS_ORIGINS` to include your frontend URL

### PostgreSQL Database

1. Click "+ New Service" → "Database" → "PostgreSQL"
2. Railway creates it automatically with connection string
3. The `WAKE_DATABASE_URL` variable is auto-linked

### Redis

1. Click "+ New Service" → "Database" → "Redis"
2. Railway creates it automatically
3. The `WAKE_REDIS_URL` variable is auto-linked

### Signing Service (Optional)

1. Duplicate the backend service
2. Change the command to: `uvicorn signing_service:app --host 0.0.0.0 --port $PORT`
3. Generate a domain for it
4. Update `WAKE_SIGNING_SERVICE_URL` in the backend service

## Update Frontend

After backend is deployed, update the frontend environment variable:

```bash
# In Cloudflare Pages dashboard
VITE_BACKEND_URL=https://your-backend.up.railway.app
```

Or update `src/lib/config.ts`:

```typescript
export const BACKEND_URL = "https://your-backend.up.railway.app";
```

## Health Check

Verify deployment:

```bash
curl https://your-backend.up.railway.app/health
# Should return: {"status":"ok","dry_run":true,"network":"mainnet"}
```

## Troubleshooting

- **Build fails**: Check Railway logs, ensure Dockerfile is correct
- **Database connection**: Verify POSTGRES_DATABASE_URL is set
- **CORS errors**: Add frontend URL to WAKE_CORS_ORIGINS
- **Port issues**: Railway auto-sets $PORT, Dockerfile exposes 8000
