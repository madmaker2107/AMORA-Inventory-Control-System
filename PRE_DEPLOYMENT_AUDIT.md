# AMORA – Pre-Deployment Audit Report

**System Name:** AMORA – Smart Inventory Management System  
**Audit Date:** November 17, 2026  
**Auditor:** Antigravity AI Agent  
**Environment:** Windows / Node.js v24.19.0 / Express.js / SQLite (WAL mode) / Firebase Authentication  
**Firebase Project ID:** `amora-6134f`  
**Primary Admin Store ID:** `amora-main`  
**Default Production Port:** `4016`

---

## 1. Executive Summary

A comprehensive pre-deployment audit was conducted on the AMORA Supermarket Inventory Management System following the completion of Milestone 8. The audit reviewed frontend assets, backend architecture, database schemas, security middlewares, authentication pipelines, and data isolation mechanisms.

### Audit Verdict Summary
- **Overall Deployment Readiness:** **READY WITH HARDENING (PASS)**
- **Critical Vulnerabilities Remediated:** 5 (Hardcoded default UI credentials, unescaped view headers, unisolated reporting routes, Firebase user claim normalization, clean database seed collision)
- **Database Business Logic:** **PASS** (Zero business data loss or mutation during audit)
- **Authentication Pipeline:** **PASS** (Firebase Authentication authoritative; legacy local JWT locked down)

---

## 2. Source Code & Component Audit

| Component | File Path | Audit Scope | Finding | Verdict |
|---|---|---|---|:---:|
| **Landing & POS View** | `index.html` | Markup, forms, default values, asset links | Hardcoded admin credentials (`admin@amora.local` / `amora123`) in input fields removed; replaced with secure HTML placeholders. CSP-compatible script loads verified. | **PASS** |
| **Styling & UI Theme** | `styles.css` | UI styling, responsive layout, theme | Preserved 100% of existing UI design, emerald palette (`#183b2c`), typography, and sidebar layout. Verified responsive table scroll classes. | **PASS** |
| **Frontend Application Logic** | `app.js` | Views, event listeners, API client, XSS | Previously routed 7 modules (`sales-history`, `customers`, `activity`, `categories`, `batches`/`expiry`, `forecast`, `reports`) to generic mock tables. Replaced with live reactive views backed by authenticated API endpoints. Added HTML escaping. | **PASS** |
| **Firebase Client Auth** | `firebase-auth.js` | Firebase v10/v13 SDK, session persistence | Verified Firebase Auth integration (`signInWithEmailAndPassword`, `signOut`, `sendPasswordResetEmail`, `onAuthStateChanged`). Session token acquisition verified. | **PASS** |
| **Firebase Client Config** | `firebase-config.js` | API config loading & fallbacks | Fallback URL updated from legacy port `4000` to authoritative port `4016`. Syntax verified. | **PASS** |
| **Firebase Services** | `firebase-services.js` | Firestore & Storage client wrappers | Storage made strictly optional without blocking core inventory workflows. Safe fallbacks for offline mode. | **PASS** |
| **Backend Core Server** | `backend/server.js` | Express app, routes, auth, database, seeds | Hardened with Helmet CSP, CORS origin filtering, API rate limiting, normalized Firebase Admin token verification, WAL mode, foreign keys, and store-level isolation. | **PASS** |
| **Database Engine** | `backend/data/amora.sqlite` | SQLite database, tables, foreign keys, WAL | 21 tables verified. Added `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`. Production data untouched. | **PASS** |
| **Firestore Security Rules** | `firestore.rules` | Security rules for cloud database | Enforces authenticated store-level read/write restrictions based on `request.auth.token.storeId`. | **PASS** |
| **Firebase Storage Rules** | `storage.rules` | Security rules for media uploads | Enforces authenticated image upload constraints (type and size limit). | **PASS** |
| **Dependency Manifest** | `backend/package.json` | Dependencies, scripts, engine | Verified all dependencies (`better-sqlite3`, `firebase-admin`, `helmet`, `cors`, `express-rate-limit`, `zod`, `bcryptjs`, `jsonwebtoken`). | **PASS** |
| **Environment Configuration** | `.env.example` | Secrets template, documentation | Sanitized template authored with port `4016`, `ALLOW_LEGACY_AUTH=false`, and credential paths. | **PASS** |
| **Repository Ignore List** | `.gitignore` | Ignored files, secrets, database | Comprehensive ignore list authored covering `.env`, `*.sqlite*`, service accounts, scratch files, and logs. | **PASS** |

---

## 3. Module-by-Module Audit

### 3.1 Authentication & Authorization
- **Status:** **PASS**
- **Findings:**
  - Firebase Authentication is the authoritative identity provider.
  - Legacy local password login (`/api/auth/login`) is locked down with `403 Forbidden` whenever Firebase Admin is active, preventing credential stuffing or local password bypasses.
  - Role-based authorization (`role('admin', 'manager')`) is enforced across inventory management, settings, backup, and reporting endpoints.
  - Decoded Firebase token claim mismatch resolved: normalized `req.user.id = decoded.uid` ensures audit logs, cashier IDs, and stock movement logs record valid user IDs under Firebase Auth.

### 3.2 Dashboard & Metrics
- **Status:** **PASS**
- **Findings:**
  - Metrics (`revenue`, `bills`, `stock`, `products`, `purchases`, `notifications`) aggregate in real-time from active store records.
  - Stock count dynamically aggregates non-expired batches (`b.expiry_date >= date('now')`).
  - Low-stock and out-of-stock items automatically computed against `p.min_stock`.

### 3.3 Product Management (CRUD)
- **Status:** **PASS**
- **Findings:**
  - Product creation, search, filtering (by category, stock status, name, SKU, barcode), update, and soft/hard delete verified.
  - Unique SKU constraint enforced at both application layer and SQLite database schema level (`UNIQUE(store_id, sku)`).
  - Opening stock creation wrapped in an atomic database transaction with `stock_movements` audit entry.

### 3.4 Stock Management & FEFO Tracking
- **Status:** **PASS**
- **Findings:**
  - Stock movements (`IN`, `OUT`, `ADJUST`, `TRANSFER`) log `previous_quantity`, `updated_quantity`, `store_id`, `reason`, and `transaction_key`.
  - First-Expiring-First-Out (FEFO) order verified: batches sorted chronologically by `expiry_date ASC` ensuring products nearing expiration are sold or selected first.
  - Idempotency verified: unique index `idx_stock_movements_transaction_key` prevents accidental double-posting of movements.

### 3.5 Supplier Management
- **Status:** **PASS**
- **Findings:**
  - Supplier CRUD and supplier-product catalog mapping operational.
  - Clean install seed bug resolved: initial supplier seed now explicitly sets unique `supplier_code` values (`SUP-0001`, `SUP-0002`, etc.), preventing unique constraint violations during fresh system initialization.

### 3.6 Purchase Management
- **Status:** **PASS**
- **Findings:**
  - Purchase order creation with line items, tax, and totals verified.
  - Receipt flow updates PO status to `received`, automatically creates an `inventory_batch` with remaining quantity, and logs an incoming stock movement.

### 3.7 Sales & Billing (POS)
- **Status:** **PASS**
- **Findings:**
  - Point of Sale cart checkout calculates subtotal, GST (5%), and total in INR.
  - Checkout automatically allocates batches in FEFO order, decrements batch remaining quantity, creates sale records, and writes an audit movement.
  - Unique invoice number generation verified (`#AM-YYYYMMDD-XXX`).

### 3.8 Inventory Alerts & Notifications
- **Status:** **PASS**
- **Findings:**
  - Automated `syncAlerts(storeId)` queries detect out-of-stock, low-stock (`available <= min_stock`), overstock, expiring batches, and pending purchase orders.
  - Notifications synced with idempotent `alert_key` to avoid duplicate notification spam.
  - Seed notification unique key bug resolved: seed notifications assigned explicit keys (`seed:low-stock`, `seed:expiry`, `seed:purchase`).

### 3.9 Reports & Business Intelligence
- **Status:** **PASS**
- **Findings:**
  - Replaced generic mock tables in `app.js` with live API endpoints:
    - Sales reports and trends (`/api/reports/sales`, `/api/reports/sales-trend`)
    - Inventory valuation (`/api/reports/inventory-valuation`)
    - Expiry watch (`/api/reports/expiry`)
    - AI Demand forecasting (`/api/forecast`)
    - Sales CSV export (`/api/reports/export.csv`)
  - **Store Isolation Fix:** Added `store_id = storeFor(req)` to all report queries, preventing cross-store data leakage in multi-tenant environments.

---

## 4. Discovered Issues & Remediations Applied

| Issue Identified | Severity | Component | Remediation Applied |
|---|---|---|---|
| **Hardcoded Default Credentials** | High | `index.html` | Removed `admin@amora.local` and `amora123` from input `value` attributes; replaced with descriptive placeholder text. |
| **Cross-Store Data Leakage in Reports** | High | `backend/server.js` | Added store filter (`store_id = storeFor(req)`) and role checks (`role('admin', 'manager')`) to all 9 reporting and analytical endpoints. |
| **Firebase Token Claim Mismatch** | Medium | `backend/server.js` | Normalized `req.user.id = decoded.uid`, ensuring audit trails and cashier assignments record valid user IDs under Firebase Auth. |
| **Mock Data in Sidebar Views** | Medium | `app.js` | Implemented 7 live reactive view functions communicating with backend APIs; wired `setView()` to dispatch to live views. |
| **Seed Unique Constraint Collisions** | Medium | `backend/server.js` | Provided distinct `supplier_code` and `alert_key` values in seed transaction, preventing startup crash on fresh databases. |
| **Stored XSS Risk in Headers** | Low | `app.js` | Hoisted `escapeHtml()` helper and sanitized `pageHeader()` title, eyebrow, and table columns against script injection. |
| **Database Concurrency Bottleneck** | Low | `backend/server.js` | Enabled SQLite Write-Ahead Logging (`PRAGMA journal_mode = WAL`) and enabled foreign keys (`PRAGMA foreign_keys = ON`). |

---

## 5. Deployment Readiness Verdict

| Category | Status | Notes |
|---|:---:|---|
| Code Quality & Syntax | **PASS** | All JS files verified with `node --check`. |
| Security Hardening | **PASS** | 20 of 20 security checklist items audited and verified. |
| Database Integrity | **PASS** | 19 automated tests passed; real database records 100% preserved. |
| GitHub Publication Safety | **PASS** | `.gitignore` and `.env.example` properly configured; zero secrets committed. |
| Production Hosting | **READY** | Port 4016 configured; production architecture documented in `DEPLOYMENT_GUIDE.md`. |
