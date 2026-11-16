<div align="center">

# AMORA — Smart Supermarket Inventory & POS Management System

[![Node.js Version](https://img.shields.io/badge/Node.js-v18%2B%20%7C%20v24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express-5.1.0-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL%20Mode-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Firebase Auth](https://img.shields.io/badge/Firebase-Authentication-FFCA28?logo=firebase&logoColor=black)](https://firebase.google.com/)
[![Build Status](https://img.shields.io/badge/Tests-19%2F19%20Passing-brightgreen)](#testing--quality-assurance)
[![License](https://img.shields.io/badge/License-Proprietary-red)](#license)

<p align="center">
  <strong>An enterprise-grade, lightweight supermarket retail management platform designed for rapid POS billing, automated FEFO batch tracking, procurement workflows, multi-tenant store isolation, and real-time business intelligence.</strong>
</p>

[Key Features](#key-features) •
[System Architecture](#system-architecture) •
[Tech Stack](#technology-stack) •
[Installation & Setup](#installation--setup) •
[Environment Variables](#environment-variables) •
[Database Architecture](#database-architecture) •
[API Reference](#api-reference) •
[Deployment Guide](#production-deployment-strategy)

---

</div>

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [System Architecture](#system-architecture)
- [Technology Stack](#technology-stack)
- [Directory Structure](#directory-structure)
- [Installation & Setup](#installation--setup)
- [Environment Variables](#environment-variables)
- [Database Architecture](#database-architecture)
- [API Reference](#api-reference)
- [Testing & Quality Assurance](#testing--quality-assurance)
- [Production Deployment Strategy](#production-deployment-strategy)
- [Security & Compliance](#security--compliance)
- [License](#license)

---

## Overview

**AMORA** solves the critical operational challenges faced by modern supermarket retailers:
1. **Perishable Waste Reduction:** Automated First-Expiring-First-Out (FEFO) batch tracking prevents stock spoilage before items reach the checkout counter.
2. **Lightning-Fast POS Billing:** Zero-dependency Single Page Application (SPA) architecture combined with sub-millisecond SQLite queries ensures high-throughput checkout lines without latency.
3. **Enterprise Security:** Authoritative Firebase Authentication paired with server-side Firebase Admin verification, strict role-based authorization (Admin, Manager, Cashier), and multi-tenant store isolation (`store_id`).
4. **Predictive Procurement:** Automated stock replenishment forecasts based on 30-day velocity, lead times, and configurable safety buffers.

---

## Key Features

### 🛒 Point of Sale (POS) & Billing
- **High-Velocity Checkout:** Rapid product search by name, SKU, or barcode with live batch availability checks.
- **Automated Tax & GST:** Real-time Indian GST breakdown (CGST, SGST, IGST) with standard 5% average calculation.
- **Flexible Payments:** Support for Cash, UPI, Credit/Debit Cards, and split payments.
- **Invoice & Receipt Generation:** Formatted invoice printing with customizable store prefixes (e.g., `#AM-20261117-001`).
- **Verified Sales Returns & Cancellations:** Reversible item returns with automated restocking to original inventory batches.

### 📦 FEFO Batch Management & Stock Control
- **First-Expiring-First-Out (FEFO):** Outgoing sales automatically consume batches with the nearest expiry dates first.
- **Expiry Watch Matrix:** Real-time visibility into expired, near-expiry (7-day window), and healthy inventory lots.
- **Four-Way Stock Operations:** Dedicated workflows for **Stock-In**, **Stock-Out**, **Manual Adjustments**, and **Store Transfers**.
- **Idempotent Movement Ledger:** Every stock change creates an immutable `stock_movements` record with previous/updated quantity balances and unique transaction keys.

### 📋 Procurement & Supplier Management
- **Purchase Order Workflow:** Multi-stage PO tracking (`draft` ➔ `approved` ➔ `partially_received` ➔ `received`).
- **Goods Receipt Verification:** Quantities received automatically create new inventory batches with manufacturing and expiry tracking.
- **Supplier Directory:** Contact management, GSTIN validation, payment terms, and historical on-time delivery ratings.
- **Supplier-Product Mapping:** Pre-configured supplier SKU and wholesale pricing relationships.

### 📊 Business Intelligence & Analytics
- **Live Sales Dashboard:** Today's revenue, active invoice counts, low-stock alerts, and expiring product counts.
- **Trend Visualizations:** Weekly and monthly interactive revenue performance trend charts.
- **AI/Statistical Demand Forecasting:** Reorder recommendation engine calculating:
  $$\text{Recommended Order} = \max\left(0, \left(\frac{\text{30-Day Sales}}{30} \times \text{Lead Time Days}\right) + \text{Min Stock} - \text{Current Stock}\right)$$
- **Inventory Valuation:** Real-time comparison between wholesale purchase valuation and retail market value.
- **Authenticated CSV Exports:** One-click financial and transaction export for accounting and audits.

---

## System Architecture

AMORA uses a **High-Performance Hybrid Architecture**: the frontend is deployed to a globally distributed CDN (Firebase Hosting), user identity is managed by Firebase Authentication, and business transactions are executed by an Express.js API communicating with an embedded SQLite engine operating in Write-Ahead Logging (WAL) mode.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             AMORA Client SPA                                │
│                   (index.html · app.js · styles.css)                        │
│                   Hosted on Firebase Hosting (CDN)                          │
└───────────────────────┬─────────────────────────────▲───────────────────────┘
                        │                             │
            Client Auth │ (Firebase ID Token)         │ Static CDN Assets
                        ▼                             │
        ┌─────────────────────────────┐               │
        │   Firebase Authentication   │               │
        │    (Project: amora-6134f)   │               │
        └───────────────┬─────────────┘               │
                        │                             │
                        │ Bearer Authorization Token  │
                        ▼                             │
┌─────────────────────────────────────────────────────┴───────────────────────┐
│                           AMORA Backend API                                 │
│                   (Node.js / Express 5.1 on Port 4016)                      │
│                                                                             │
│  - Helmet Strict Content Security Policy (CSP)                              │
│  - CORS Origin Whitelist Filtering (CORS_ORIGIN)                            │
│  - Express Rate Limiting (600 req/15m API, 60 req/15m Auth)                 │
│  - Firebase Admin SDK Token Verification (adminAuth.verifyIdToken)          │
│  - Role-Based Access Control Middleware (role('admin', 'manager'))          │
│  - Multi-Tenant Store Data Isolation (store_id = amora-main)                │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                               SQL Prepared Statements
                               (ACID Transactions)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SQLite Embedded Database                              │
│                   (backend/data/amora.sqlite)                               │
│                                                                             │
│  - PRAGMA journal_mode = WAL (Concurrent Non-Blocking Reads & Writes)       │
│  - PRAGMA foreign_keys = ON (Strict Referential Integrity)                  │
│  - 21 Normalized Relational Tables & Composite Indexes                      │
│  - Hot Online Non-Locking Snapshots via /api/backup                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| **Frontend UI** | HTML5 / CSS3 / Vanilla JS | ES2022 | Lightweight, zero-dependency SPA with responsive emerald palette (`#183b2c`) |
| **Client Auth** | Firebase Web SDK | v12.5.0 / v13.x | Client session persistence, login, and password recovery |
| **Backend API** | Node.js / Express | v24.x / v5.1.0 | RESTful API routing, rate limiting, and business logic execution |
| **Database Engine** | SQLite3 via `better-sqlite3` | v12.4.1 | High-throughput embedded SQL engine running in WAL mode |
| **Server Auth** | Firebase Admin SDK | v14.5.1 | Server-side ID token verification and claim extraction |
| **Validation** | Zod | v4.1.12 | Strict runtime schema parsing and payload boundary enforcement |
| **Security Headers** | Helmet | v8.1.0 | CSP directives, clickjacking protection, and HSTS headers |
| **Brute Force Defense**| Express Rate Limit | v8.2.1 | IP-based request throttling on API and authentication routes |
| **Password Hashing** | Bcrypt.js | v3.0.2 | Fallback password hashing (used only during initial seed) |

---

## Directory Structure

```
AMORA-Inventory-Control-System/
├── .env.example                 # Root environment template (placeholders only)
├── .gitignore                   # Comprehensive git exclusions (secrets, DBs, logs)
├── app.js                       # Frontend reactive application controller & views
├── index.html                   # Supermarket console layout & POS billing interface
├── styles.css                   # Custom supermarket UI styling and responsive tables
├── firebase-auth.js             # Firebase Web SDK client authentication adapter
├── firebase-config.js           # Dynamic Firebase client configuration loader
├── firebase-services.js         # Cloud Firestore & Storage client wrappers
├── firebase.json                # Firebase Hosting configuration & deployment rules
├── firestore.rules              # Cloud Firestore Security Rules
├── storage.rules                # Cloud Storage Security Rules
│
├── backend/
│   ├── .env.example             # Backend-specific environment template
│   ├── package.json             # Backend dependencies and run scripts
│   ├── package-lock.json        # Dependency lockfile
│   ├── server.js                # Core Express API server, SQLite schemas & seed
│   ├── provision-firebase-user.js # Admin utility for setting user roles and store claims
│   ├── README.md                # Backend quickstart guide
│   └── data/                    # Database storage directory (git-ignored)
│       └── amora.sqlite         # SQLite database file (WAL mode)
│
└── [Documentation]
    ├── README.md                # This comprehensive project documentation
    ├── DEPLOYMENT_GUIDE.md      # Production hosting, Nginx reverse proxy & backup guide
    ├── PRE_DEPLOYMENT_AUDIT.md  # Complete system and component pre-deployment audit
    ├── SECURITY_AUDIT.md        # 20-point comprehensive security and hardening report
    ├── TEST_RESULTS.md          # 19-point automated test execution results
    ├── FIREBASE_MIGRATION_BLUEPRINT.md # Theoretical serverless migration proposal
    └── FIREBASE_MIGRATION_REVIEW.md    # Critical review proving hybrid model is superior
```

---

## Installation & Setup

### 1. Prerequisites
- **Node.js:** v18.0.0 or higher (v24.x tested and recommended)
- **npm:** v9.0.0 or higher
- **Git:** v2.30 or higher
- **Firebase Project:** Google Firebase project (`amora-6134f` or your own)

### 2. Clone the Repository
```bash
git clone https://github.com/madmaker2107/AMORA-Inventory-Control-System.git
cd AMORA-Inventory-Control-System
```

### 3. Install Backend Dependencies
```bash
cd backend
npm install
cd ..
```

### 4. Configure Environment Variables
Copy the root `.env.example` file to create `.env`:
```bash
cp .env.example .env
```
Open `.env` and fill in your values (see [Environment Variables](#environment-variables) below).

### 5. Initialize & Seed the Database
Initialize the SQLite schema, migrations, and default catalog items:
```bash
cd backend
npm run seed
cd ..
```
*Creates the default store `amora-main`, categories, demo products, opening inventory batches, suppliers, and system settings.*

### 6. Start the Server
```bash
cd backend
npm start
```
The application will be live at:
```
http://localhost:4016
```

---

## Environment Variables

| Variable | Default Value | Description |
|---|---|---|
| `PORT` | `4016` | Port for the Express backend to listen on. Honors container provider port. |
| `NODE_ENV` | `production` | Environment mode (`development` or `production`). Disables stack traces in prod. |
| `CORS_ORIGIN` | `http://localhost:4016,http://localhost:4000` | Comma-separated whitelist of allowed web origins for CORS. |
| `DATABASE_PATH` | `backend/data/amora.sqlite` | Filepath to the SQLite database file. Supports absolute paths for persistent volume mounts. |
| `ALLOW_LEGACY_AUTH` | `false` | When `false`, blocks `/api/auth/login` with HTTP 403, enforcing Firebase Auth exclusively. |
| `JWT_SECRET` | *(64-char random)* | Fallback JWT secret key (active only if legacy auth is explicitly enabled). |
| `GOOGLE_APPLICATION_CREDENTIALS` | `/path/to/adminsdk.json` | Path to server-side Firebase service account private key file. |
| `FIREBASE_API_KEY` | *(Your Web Key)* | Firebase client Web API key (served to frontend via `/api/firebase-config`). |
| `FIREBASE_AUTH_DOMAIN` | `amora-6134f.firebaseapp.com` | Firebase authentication domain. |
| `FIREBASE_PROJECT_ID` | `amora-6134f` | Firebase Project Identifier. |
| `FIREBASE_STORAGE_BUCKET`| `amora-6134f.firebasestorage.app` | Firebase Storage bucket (optional). |
| `FIREBASE_MESSAGING_SENDER_ID` | *(Sender ID)* | Cloud messaging sender identifier. |
| `FIREBASE_APP_ID` | *(Web App ID)* | Firebase Web Application identifier. |

---

## Database Architecture

AMORA utilizes an embedded **SQLite 3** relational schema with **Write-Ahead Logging (WAL)**:
- **Zero Configuration:** No external database process required.
- **Non-Blocking Concurrency:** Readers do not block writers, and writers do not block readers.
- **Strict Referential Integrity:** `PRAGMA foreign_keys = ON` enforced on connection initialization.

### Schema Entity Relationship Overview (21 Tables)

```
stores (Store Metadata, GSTIN, Settings)
  ├── users (Employees, Roles, Password Hash, Store ID)
  ├── categories (Product Classification)
  ├── brands (Product Brands)
  ├── products (Catalog, Pricing, Barcodes, Min/Max Stock)
  │     ├── inventory_batches (Lots, Manufacturing/Expiry Dates, Remaining Qty)
  │     │     └── stock_movements (Immutable Ledger: IN, OUT, ADJUST, TRANSFER)
  │     ├── supplier_products (Supplier-Product Catalog Mapping)
  │     ├── purchase_items (PO Line Items)
  │     └── sale_items (Invoice Line Items & Batch Consumption)
  ├── suppliers (Vendor Directory, Contact Info, Payment Terms)
  │     └── purchase_orders (Procurement Headers, Status, Totals)
  │           └── payments (PO & Supplier Payments)
  ├── customers (Loyalty Points, Purchase History, Contact Info)
  │     └── sales (Invoice Headers, Cashier ID, Subtotal, GST, Total)
  │           ├── sale_returns (Restocked Item Returns)
  │           ├── sale_reversals (Cancelled Invoices & Restocking)
  │           └── payments (POS Payments: Cash, Card, UPI)
  ├── notifications (Dynamic Inventory, Expiry & Stock Alerts)
  ├── audit_logs (Immutable Administrative Audit Trail)
  ├── settings (Store Configuration Key-Value Store)
  ├── login_history (Security Access Log)
  └── backups (Hot Backup File History)
```

---

## API Reference

All protected API endpoints require an `Authorization: Bearer <FIREBASE_ID_TOKEN>` header.

### 🔐 Authentication & Session
- `GET /api/health` — System status and database engine verification (Public).
- `GET /api/firebase-config` — Client-safe public Firebase configuration (Public).
- `POST /api/auth/login` — Legacy local login (Disabled with HTTP 403 when Firebase is active).
- `POST /api/auth/change-password` — Change password for authenticated session.
- `GET /api/auth/login-history` — Access audit trail (`admin`, `manager`).

### 📦 Products & Catalogue
- `GET /api/products` — Paginated catalogue with dynamic batch-computed stock and search.
- `GET /api/products/:id` — Product detail joined with categories and live batches.
- `POST /api/products` — Create new product with opening stock batch (`admin`, `manager`, `stock_manager`).
- `PATCH /api/products/:id` — Update product catalogue details (`admin`, `manager`, `stock_manager`).
- `DELETE /api/products/:id` — Soft-delete product if no sales history exists (`admin`, `manager`).
- `GET|POST /api/categories` — List and create product categories (`admin`, `manager`).
- `GET|POST /api/brands` — List and create brands (`admin`, `manager`).

### 🔄 Stock Operations & Inventory
- `GET /api/inventory` — Live store inventory with last 100 stock movements.
- `POST /api/inventory/stock-in` — Receive stock into a new lot with FEFO expiry tracking.
- `POST /api/inventory/stock-out` — Consume stock in FEFO order (damage/write-off).
- `POST /api/inventory/transfer` — Transfer stock between products or store branches.
- `POST /api/inventory/adjust` — Reconcile physical inventory counts against system records.

### 🛒 Sales & Point of Sale (POS)
- `POST /api/sales` — Complete atomic POS checkout with FEFO deduction, 5% GST, and invoice generation.
- `GET /api/sales` — List recent store sales transactions.
- `GET /api/sales/:id` — Detailed sale invoice with line items, batches, and cashier name.
- `POST /api/sales/:id/return` — Process verified customer return and restock batches.
- `POST /api/sales/:id/cancel` — Void completed invoice and reverse all inventory movements (`admin`, `manager`).

### 🚚 Suppliers & Procurement
- `GET /api/suppliers` — Supplier directory with purchase metrics and outstanding payables.
- `GET /api/suppliers/:id` — Supplier profile, mapped items, and purchase order history.
- `POST|PATCH /api/suppliers` — Create or update supplier details (`admin`, `manager`).
- `POST /api/suppliers/:id/products` — Map product to vendor catalog (`admin`, `manager`).
- `GET /api/purchases` — List purchase orders.
- `POST /api/purchases` — Generate purchase order with calculated tax and items (`admin`, `manager`, `inventory`).
- `POST /api/purchases/:id/receive` — Receive goods, create inventory batches, and update stock (`admin`, `manager`, `inventory`).

### 📈 Reports & Analytics
- `GET /api/reports/sales` — Date-range sales performance summary and payment breakdown (`admin`, `manager`).
- `GET /api/reports/sales-trend` — 7-day or 30-day daily sales revenue trend.
- `GET /api/reports/profit-loss` — Revenue, Cost of Goods Sold (COGS), and gross profit calculation (`admin`, `manager`).
- `GET /api/reports/inventory-valuation` — Total wholesale cost vs retail market valuation (`admin`, `manager`).
- `GET /api/reports/expiry` — FEFO batch expiration watch list.
- `GET /api/reports/export.csv` — Stream raw transaction history as CSV download (`admin`, `manager`).
- `GET /api/forecast` — Demand forecast and suggested reorder quantities (`admin`, `manager`).
- `GET /api/audit-logs` — Immutable audit trail of system operations (`admin`, `manager`).
- `GET /api/backup` — Download hot SQLite database snapshot (`admin`).

---

## Testing & Quality Assurance

AMORA includes an automated pre-deployment test suite that verifies database constraints, FEFO logic, transactions, rate limiting, and security middlewares in an isolated test database without modifying production records.

Run the automated test suite:
```bash
node scratch/run_test_suite.mjs
```

Verify JavaScript syntax across all modules:
```bash
node --check backend/server.js
node --check app.js
node --check firebase-auth.js
node --check firebase-config.js
node --check firebase-services.js
```

### Test Suite Summary (19 Automated Tests)
- `STAT-01`: JavaScript AST Syntax Compliance across all 5 JS files — **PASS**
- `FIRE-01`: Firebase Admin SDK Initialization & Project Binding — **PASS**
- `DB-01`: SQLite Write-Ahead Logging (`PRAGMA journal_mode = WAL`) — **PASS**
- `DB-02`: Referential Integrity (`PRAGMA foreign_keys = ON`) — **PASS**
- `PROD-01`: Product Creation & Attribute Retrieval — **PASS**
- `PROD-02`: Unique SKU Constraint Enforcement — **PASS**
- `TX-01`: Atomic Transaction Rollback on Foreign Key Error — **PASS**
- `TX-02`: Transaction Idempotency & Duplicate Key Protection — **PASS**
- `FEFO-01`: First-Expiring-First-Out Batch Selection Logic — **PASS**
- `SALE-01`: POS Checkout, Batch Reduction & Movement Audit — **PASS**
- `NOTIF-01`: Automated Low-Stock Alert Generation — **PASS**
- `ISOL-01`: Multi-Tenant Store-Level Access Isolation — **PASS**
- `API-01`: Backend Health Check Endpoint (`/api/health`) — **PASS**
- `API-02`: Firebase Configuration Endpoint (`/api/firebase-config`) — **PASS**
- `API-03`: Helmet Security Headers (CSP, `nosniff`, `SAMEORIGIN`, HSTS) — **PASS**
- `API-04`: Route Authentication Protection (401 on unauthenticated access) — **PASS**
- `API-05`: Legacy Authentication Lockdown (403 on local login) — **PASS**
- `API-06`: API Rate Limiting Enforcement (Headers verified) — **PASS**
- `API-07`: CORS Origin Whitelist Isolation — **PASS**

---

## Production Deployment Strategy

The approved architecture decouples static frontend serving from the stateful backend API:

### 1. Frontend Deployment (Firebase Hosting — Free Tier)
Deploy the client SPA directly to Firebase Hosting:
```bash
firebase deploy --only hosting
```
The [firebase.json](file:///c:/Users/soumi/OneDrive/Desktop/New%20folder/firebase.json) file automatically excludes backend code, SQLite database files, scratch files, and internal documentation from the public hosting bundle.

### 2. Backend Deployment (Node.js Container with Persistent Storage)
Deploy the `backend/` directory to a cloud VM or container platform supporting persistent block storage (e.g., Docker on a Linux VM, DigitalOcean Droplet, Railway, Render, or Fly.io).

**Critical Rule:** Mount a persistent volume to `/app/backend/data` so that `amora.sqlite`, `amora.sqlite-wal`, and `amora.sqlite-shm` persist across restarts and redeployments.

### 3. Production Reverse Proxy Configuration (Nginx Example)
```nginx
server {
    listen 443 ssl http2;
    server_name store.amoraretail.com;

    # SSL configuration
    ssl_certificate /etc/letsencrypt/live/store.amoraretail.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/store.amoraretail.com/privkey.pem;

    # Proxy API requests to Node.js backend on Port 4016
    location /api/ {
        proxy_pass http://127.0.0.1:4016;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Serve static frontend files
    location / {
        root /var/www/amora;
        try_files $uri $uri/ /index.html;
    }
}
```

### 4. Automated Daily Backups
Set up an automated cron job to trigger hot database snapshots:
```bash
0 2 * * * curl -s -H "Authorization: Bearer $(cat /etc/amora/admin-token)" http://localhost:4016/api/backup -o /var/backups/amora/amora-$(date +\%F).sqlite
```

---

## Security & Compliance

- **Role-Based Access Control (RBAC):**
  - `admin`: Full administrative control across catalog, settings, backups, and reports.
  - `manager`: Store operational management, inventory transfers, and purchasing.
  - `cashier`: Point of Sale billing, sales returns, and customer registration. Cannot modify catalogue prices or store settings.
- **Content Security Policy (CSP):** Helmet strictly whitelists trusted domains (`fonts.googleapis.com`, `gstatic.com`, `firebaseio.com`, `unsplash.com`) and blocks inline script injections.
- **Store-Level Isolation:** All database queries partition records by `store_id = 'amora-main'`. Cross-tenant data leakage is prevented at the database layer.
- **SQL Injection Prevention:** 100% of queries use parameterized prepared statements via `better-sqlite3`. Zero dynamic string concatenation.
- **Immutability of Audit Trails:** Stock movements and administrative audit logs are append-only.

---

## License

Private & Proprietary — © 2026 **AMORA Retail Pvt. Ltd.** All rights reserved.  
Unauthorized copying, modification, distribution, or deployment of this software is strictly prohibited.
