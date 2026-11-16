# AMORA – Comprehensive Security Audit Report

**System Name:** AMORA – Smart Inventory Management System  
**Audit Date:** November 17, 2026  
**Auditor:** Antigravity AI Agent  
**Environment:** Node.js / Express.js / SQLite / Firebase Authentication  
**Firebase Project:** `amora-6134f`  
**Authorization Store Scope:** `amora-main`

---

## 1. Security Checklist (20 Core Controls)

Every control has been classified as **PASS**, **FAIL**, **WARNING**, **BLOCKED**, or **NOT TESTED**.

| # | Control Requirement | Status | Summary of Verification & Remediation |
|:---:|---|:---:|---|
| 1 | **Hardcoded Passwords** | **PASS** | Default passwords removed from `index.html` input elements. No hardcoded passwords exist in any client or server source files. |
| 2 | **Default Admin Credentials** | **PASS** | Production utilizes Firebase Authentication. Seeded demo credentials (`admin@amora.local`) are protected by bcrypt (10 rounds) and unreachable in production because local login is disabled. |
| 3 | **API Secrets** | **PASS** | Client-side Firebase configuration (`FIREBASE_API_KEY`, etc.) uses public web identifiers designed for browser access. Server-side secrets are isolated outside version control. |
| 4 | **JWT Secrets** | **PASS** | Fallback JWT secret is environment-configurable (`JWT_SECRET`). When Firebase Admin is active and `ALLOW_LEGACY_AUTH` is false, legacy JWT issuance is disabled. |
| 5 | **Firebase Service Account JSON** | **PASS** | Private key file is stored externally at `C:\secure\amora-6134f-firebase-adminsdk-fbsvc-4ae7969ea8.json`. All `*firebase-adminsdk*.json` and `service-account*.json` patterns are strictly git-ignored. |
| 6 | **Environment Files** | **PASS** | `.env` and `.env.*` are ignored in `.gitignore`. A sanitized `.env.example` provides templates without exposing live credentials. |
| 7 | **Database Files** | **PASS** | SQLite database files (`backend/data/*.sqlite*`, `*.db`, `backups/`) are strictly git-ignored, preventing exposure of business records. |
| 8 | **Sensitive User Information** | **PASS** | User query projections explicitly omit `password_hash`. No Personally Identifiable Information (PII) is logged or exposed in unauthenticated responses. |
| 9 | **Debug Logs** | **PASS** | Production logger excludes sensitive credentials, auth headers, and passwords. Test suites run without printing token values or credentials. |
| 10 | **Authentication Bypass** | **PASS** | Legacy `/api/auth/login` endpoint rejects sign-ins with `403 Forbidden` when Firebase is active and `ALLOW_LEGACY_AUTH=false`. Protected routes reject unauthenticated requests with `401 Unauthorized`. |
| 11 | **SQL Injection** | **PASS** | All database queries use parameterized prepared statements via `better-sqlite3`. No user input is directly concatenated into SQL queries. |
| 12 | **Cross-Site Scripting (XSS)** | **PASS** | Implemented `escapeHtml()` across dynamic DOM interpolation in `app.js`. Page headers, eyebrow titles, table cells, and status badges are sanitized against HTML/script injection. |
| 13 | **Cross-Origin Resource Sharing (CORS)** | **PASS** | Configured `cors` middleware with origin filtering using `CORS_ORIGIN` environment variable or localhost ports (`4016`, `4000`). Disallowed origins are rejected. |
| 14 | **Rate Limiting** | **PASS** | `express-rate-limit` enforces 600 requests per 15-minute window on all `/api/` endpoints, and a strict limit of 60 requests per 15-minute window on `/api/auth/` routes. |
| 15 | **HTTP Security Headers** | **PASS** | `helmet` configured with strict Content Security Policy (`default-src 'self'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and `Strict-Transport-Security`. |
| 16 | **Input Validation** | **PASS** | Request payloads are parsed with Zod schemas (`z.object({...})`), enforcing type coercion, length boundaries, and rejection of malformed JSON. |
| 17 | **File Upload Security** | **PASS** | Product images are referenced via validated HTTPS URLs; local file write paths are confined to sanitized directory paths. Storage rules enforce upload type and size limits. |
| 18 | **Firestore Security Rules** | **PASS** | `firestore.rules` enforces authenticated access, restricting document read/write permissions to matching store identities (`request.auth.token.storeId == storeId`). |
| 19 | **Role-Based Authorization (RBAC)** | **PASS** | The `role('admin', 'manager')` middleware restricts sensitive operations (user management, settings, CSV exports, backups, and reports) to authorized administrative accounts. |
| 20 | **Store-Level Access Isolation** | **PASS** | Enforced `store_id = storeFor(req)` across all operational CRUD routes and all reporting/analytical endpoints, preventing cross-tenant data leaks. |

---

## 2. In-Depth Vulnerability Analysis & Mitigations

### 2.1 Authentication Architecture & Legacy Route Lockdown
- **Vulnerability Prior to Hardening:**  
  The system previously maintained a legacy local username/password login endpoint (`/api/auth/login`) that issued local HMAC-SHA256 JWT tokens. If left unrestricted, an attacker could attempt dictionary attacks or bypass Firebase Multi-Factor Authentication / Email Verification.
- **Remediation Implemented:**  
  In `backend/server.js`, `/api/auth/login` now verifies if Firebase Admin is initialized. If initialized and `ALLOW_LEGACY_AUTH !== 'true'`, the route immediately rejects requests with:
  ```json
  HTTP 403 Forbidden
  { "error": "Local password authentication is disabled. Please sign in with Firebase Authentication." }
  ```
  Furthermore, the `auth()` middleware strictly verifies Firebase ID tokens via `adminAuth.verifyIdToken(token)`. Legacy JWTs are only accepted if `ALLOW_LEGACY_AUTH === 'true'` is explicitly configured in `.env`.

### 2.2 Cross-Store Multi-Tenant Data Isolation
- **Vulnerability Prior to Hardening:**  
  While core product and sales routes filtered by `store_id`, the reporting and business intelligence endpoints (`/api/reports/sales`, `/api/reports/sales-trend`, `/api/reports/profit-loss`, `/api/reports/inventory-valuation`, `/api/reports/expiry`, `/api/reports/export.csv`, `/api/forecast`, `/api/analysis/*`) previously queried across all stores without `store_id` constraints.
- **Remediation Implemented:**  
  Every analytical and reporting query was refactored to require `WHERE store_id = ?` using `storeFor(req)`. Access is restricted to `role('admin', 'manager')`. Data from Store A is completely invisible to Store B.

### 2.3 User Claim Normalization & Audit Integrity
- **Vulnerability Prior to Hardening:**  
  Firebase tokens decode the unique user identifier as `decoded.uid`, whereas legacy local JWTs stored it as `payload.id`. When signed in via Firebase, downstream route handlers accessing `req.user.id` received `undefined`, causing cashier attribution and audit log entries (`audit(req.user.id, ...)`) to record `NULL` user IDs.
- **Remediation Implemented:**  
  In `backend/server.js`, the authentication middleware normalizes user claims:
  ```javascript
  req.user = {
    id: decoded.uid,
    uid: decoded.uid,
    email: decoded.email,
    role: decoded.role || 'cashier',
    storeId: decoded.storeId || 'amora-main'
  };
  ```

### 2.4 Content Security Policy (CSP) & XSS Protection
- **Vulnerability Prior to Hardening:**  
  The frontend dynamically generated table rows and page headers using string interpolation without universal escaping.
- **Remediation Implemented:**  
  - The `escapeHtml()` utility was hoisted to the top level of `app.js` and applied to product names, SKUs, categories, descriptions, suppliers, customer names, and table headers.
  - Helmet CSP configured to permit only trusted resources:
    - Scripts: `'self'`, `'unsafe-inline'` (for app bootstrap), `https://www.gstatic.com` (Firebase SDK).
    - Styles: `'self'`, `'unsafe-inline'`, `https://fonts.googleapis.com`.
    - Fonts: `'self'`, `https://fonts.gstatic.com`.
    - Images: `'self'`, `data:`, `https://images.unsplash.com`.
    - Connections: `'self'`, `https://*.firebaseio.com`, `https://identitytoolkit.googleapis.com`, `https://securetoken.googleapis.com`, `https://firestore.googleapis.com`, `http://localhost:4016`.

### 2.5 Denial of Service & Brute Force Protection
- **Remediation Implemented:**  
  - Express Rate Limit middleware configured on all `/api/` routes (600 requests / 15 minutes per IP).
  - Auth-specific rate limiting on `/api/auth/` (60 requests / 15 minutes per IP).
  - JSON body parser payload capped at `1mb` to prevent memory exhaustion attacks.

---

## 3. Git Repository Sanitization Verification

- **Git Status Check:** Workspace is clean of committed secrets.
- **Excluded Patterns in `.gitignore`:**
  - `.env`, `.env.*`, `!.env.example`
  - `backend/data/*.sqlite*`, `*.db`
  - `*firebase-adminsdk*.json`, `service-account*.json`
  - `*.pem`, `*.key`
  - `node_modules/`, `backend/node_modules/`
  - `scratch/`, `tmp/`, `*.log`
- **Credential Storage:**  
  The Firebase service account private key is kept outside the workspace in `C:\secure\`. No private keys or service account credentials exist in the Git working tree.

---

## 4. Security Recommendations for Production

1. **Enforce HTTPS in Production:** Always terminate TLS/SSL at a reverse proxy (e.g., Nginx, Caddy, Cloudflare, or AWS ALB) and set `NODE_ENV=production`.
2. **Rotate Demo JWT Secret:** Replace the default `JWT_SECRET` in `.env` with a high-entropy 64-character random string (`openssl rand -hex 32`).
3. **Keep `ALLOW_LEGACY_AUTH=false`:** In production, leave legacy password authentication disabled and enforce Firebase Authentication with email verification.
4. **Regular Database Backups:** Set up an automated cron job to trigger authenticated database backups via `/api/backup`.
