# AMORA – Production Deployment & Architecture Guide

**System Name:** AMORA – Smart Supermarket Inventory Management System  
**Target Architecture:** Multi-Tier Web Application with Embedded/Persistent Storage  
**Primary Store ID:** `amora-main`  
**Authoritative Backend Port:** `4016` (configurable via `PORT` env)  
**Firebase Project:** `amora-6134f`

---

## 1. Production Architecture Overview

AMORA is built as a lightweight, high-performance web application consisting of:
1. **Frontend:** Static Single-Page Application (HTML, CSS, modular ES JavaScript).
2. **Backend API:** Node.js Express server handling business logic, inventory calculations, and data transactions.
3. **Database Tier:** Embedded SQLite with Write-Ahead Logging (`WAL`), running on persistent block storage.
4. **Identity Provider:** Google Firebase Authentication providing secure user management, multi-factor authentication, and JWT tokens.

```
                         [ Internet Users / POS Terminals ]
                                         │
                                         ▼ HTTPS (Port 443)
                         ┌───────────────────────────────┐
                         │   Reverse Proxy / TLS Edge    │
                         │   (Nginx / Caddy / Cloudflare)│
                         └───────────────┬───────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 │                                               │
                 ▼ Static Assets                                 ▼ /api/* Proxy
     ┌────────────────────────┐                      ┌────────────────────────┐
     │     Frontend Hosting   │                      │    Node.js Backend     │
     │  (Firebase / Nginx /   │                      │  (Docker / PM2 / VM)   │
     │   Cloudflare Pages)    │                      │  Port 4016             │
     └────────────────────────┘                      └───────────┬────────────┘
                                                                 │
                                                  ┌──────────────┴─────────────┐
                                                  │                            │
                                                  ▼ Local Filesystem           ▼ OAuth2 / HTTPS
                                       ┌──────────────────────┐    ┌──────────────────────┐
                                       │  SQLite Database     │    │  Firebase Admin SDK  │
                                       │  (Persistent Volume) │    │  (amora-6134f)       │
                                       │  WAL Mode + Backups  │    └──────────────────────┘
                                       └──────────────────────┘
```

---

## 2. Hosting Recommendations

### Option A: Unified Container / Single VM (Recommended for Supermarkets & Single Stores)
- **Host Platforms:** DigitalOcean Droplet, AWS Lightsail, Hetzner Cloud, or on-premise store server.
- **Why It Fits:**
  - Zero network latency between backend and SQLite database.
  - Simple operational model with minimal infrastructure overhead.
  - Nginx terminates SSL and serves static files; proxies `/api/` to `http://localhost:4016`.
- **Process Manager:** `pm2` or Docker Compose with volume mount for `/backend/data`.

### Option B: Decoupled Cloud Hosting (Recommended for Multi-Store Cloud Deployments)
- **Frontend:** Hosted on Firebase Hosting, Cloudflare Pages, or Netlify.
  - Configure rewrite rule: `/api/**` -> `https://api.yourstore.com/api/**`.
- **Backend:** Hosted on a Container Service with Persistent Volumes (e.g., Railway, Render, Fly.io, or AWS ECS with EFS).
- **Persistent Volume Requirement:** Must mount a persistent volume at `/app/backend/data` to ensure `amora.sqlite` persists across container redeployments and restarts.

---

## 3. SQLite Storage Persistence & Production Considerations

### 3.1 Write-Ahead Logging (WAL)
AMORA configures WAL mode at boot:
```javascript
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
```
- **Benefits:** Read operations do not block write operations, and write operations do not block read operations. This delivers high concurrency suitable for retail checkouts and reporting simultaneously.
- **File Artifacts:** SQLite in WAL mode generates two temporary auxiliary files next to `amora.sqlite`:
  - `amora.sqlite-wal` (write-ahead log)
  - `amora.sqlite-shm` (shared memory index)
- **Critical Rule:** Never delete or detach `-wal` or `-shm` files while the server is running. Ensure persistent volume storage mounts include the entire `backend/data` directory.

### 3.2 Automated Database Backups
AMORA provides a native hot backup endpoint:
```http
GET /api/backup
Authorization: Bearer <ADMIN_FIREBASE_ID_TOKEN>
```
This invokes `db.backup()`, creating an atomic, non-locking snapshot of the live database in `backend/data/amora-backup-*.sqlite` and streaming it as a download.

**Automated Backup Cron Job (Linux / macOS):**
```bash
# Add to crontab to run daily at 2:00 AM
0 2 * * * curl -s -H "Authorization: Bearer $(get_admin_token)" http://localhost:4016/api/backup -o /var/backups/amora/amora-$(date +\%F).sqlite
```

### 3.3 PostgreSQL Migration Path (For High-Scale Multi-Store Operations)
If the supermarket scales beyond 50+ simultaneous cashiers or requires multi-region active-active deployments:
1. Maintain table schemas as defined in `backend/server.js`.
2. Replace `better-sqlite3` queries with `pg` or Prisma / Kysely connection pool.
3. Transition `INTEGER PRIMARY KEY` to `SERIAL PRIMARY KEY` or `UUID`.

---

## 4. Firebase Authentication & Admin Configuration

### 4.1 Production Firebase Admin Setup
1. Open the [Firebase Console](https://console.firebase.google.com/) for project `amora-6134f`.
2. Navigate to **Project Settings > Service Accounts**.
3. Click **Generate New Private Key**.
4. Store the downloaded JSON file in a secure server path outside the web directory (e.g., `/etc/secrets/amora-firebase-key.json` or `C:\secure\...`).
5. Set `GOOGLE_APPLICATION_CREDENTIALS` in your production environment:
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/amora-firebase-key.json
   ```

### 4.2 Restricting Legacy Password Login
Ensure `ALLOW_LEGACY_AUTH` is explicitly set to `false` in `.env`:
```ini
ALLOW_LEGACY_AUTH=false
```
When set to `false`, the legacy `/api/auth/login` endpoint rejects requests with `403 Forbidden`, ensuring only verified Firebase users can access the store.

### 4.3 Custom Claims & Store Assignment
To assign admin and store claims to a Firebase user, run the provisioning utility or execute via Firebase Admin SDK:
```javascript
import { getAuth } from 'firebase-admin/auth';
await getAuth().setCustomUserClaims(uid, {
  role: 'admin',          // 'admin' | 'manager' | 'cashier'
  storeId: 'amora-main'   // target store ID
});
```

---

## 5. Reverse Proxy & HTTPS Configuration (Nginx Example)

Place the following configuration in `/etc/nginx/sites-available/amora.conf`:

```nginx
server {
    listen 80;
    server_name store.amoraretail.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name store.amoraretail.com;

    ssl_certificate /etc/letsencrypt/live/store.amoraretail.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/store.amoraretail.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Root of static frontend files
    root /var/www/amora;
    index index.html;

    # Static assets cache
    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff2)$ {
        expires 7d;
        add_header Cache-Control "public, no-transform";
    }

    # API Proxy to Node.js backend
    location /api/ {
        proxy_pass http://127.0.0.1:4016;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts for long queries / reports
        proxy_read_timeout 90;
        proxy_connect_timeout 90;
    }

    # Single-Page Application router fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

## 6. Production Environment Variables Checklist

Ensure the following variables are defined in your deployment environment:

| Variable | Recommended Production Value | Description |
|---|---|---|
| `PORT` | `4016` | Port for the Node.js backend to bind to |
| `NODE_ENV` | `production` | Enables production optimizations, disables stack traces |
| `CORS_ORIGIN` | `https://store.amoraretail.com` | Whitelist of permitted web origins for CORS |
| `DATABASE_PATH` | `/var/data/amora/amora.sqlite` | Absolute path to persistent SQLite database |
| `ALLOW_LEGACY_AUTH` | `false` | Locks down legacy username/password endpoint |
| `JWT_SECRET` | `64-character random string` | High-entropy random secret for fallback JWT |
| `GOOGLE_APPLICATION_CREDENTIALS` | `/etc/secrets/amora-firebase-key.json` | Path to server-side Firebase service account key |
| `FIREBASE_API_KEY` | *(Production Web API Key)* | Client-safe public Firebase Web API key |
| `FIREBASE_AUTH_DOMAIN` | `amora-6134f.firebaseapp.com` | Firebase authentication domain |
| `FIREBASE_PROJECT_ID` | `amora-6134f` | Firebase Project Identifier |
| `FIREBASE_STORAGE_BUCKET` | `amora-6134f.firebasestorage.app` | Firebase Storage bucket (optional) |
| `FIREBASE_MESSAGING_SENDER_ID` | *(Sender ID)* | Cloud messaging sender identifier |
| `FIREBASE_APP_ID` | *(Web App ID)* | Firebase Web Application identifier |

---

## 7. Post-Deployment Verification & Smoke Tests

After deploying to production, execute the following verification steps:

1. **Verify Backend Health:**
   ```bash
   curl -i https://store.amoraretail.com/api/health
   # Expected: HTTP 200 OK with {"ok":true,"service":"AMORA API","database":"sqlite"}
   ```
2. **Verify Security Headers:**
   ```bash
   curl -I https://store.amoraretail.com/api/health
   # Verify: Content-Security-Policy, X-Content-Type-Options: nosniff, X-Frame-Options: SAMEORIGIN
   ```
3. **Verify Route Authentication Protection:**
   ```bash
   curl -i https://store.amoraretail.com/api/products
   # Expected: HTTP 401 Unauthorized with {"error":"Authentication required"}
   ```
4. **Verify Legacy Auth Lockdown:**
   ```bash
   curl -i -X POST https://store.amoraretail.com/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@amora.local","password":"any"}'
   # Expected: HTTP 403 Forbidden with {"error":"Local password authentication is disabled..."}
   ```
5. **Verify POS Billing in Browser:**
   - Sign in using an authenticated Firebase user.
   - Add items to the cart, complete a cash sale, and verify receipt invoice and inventory reduction.
   - Navigate to Reports and download the Sales CSV export.
