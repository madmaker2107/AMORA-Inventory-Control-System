# AMORA – Smart Supermarket Inventory Management System

AMORA is a modern, enterprise-grade supermarket inventory and retail management platform designed to streamline daily grocery retail operations, FEFO batch tracking, POS billing, procurement, supplier relations, and predictive analytics.

---

## Key Features

- **Real-Time POS Billing & Sales:** Fast barcode/item search, automated cart calculation, GST breakdown (5%), multiple payment methods (Cash, Card, UPI), and instant invoice generation.
- **FEFO Batch Tracking:** First-Expiring-First-Out batch allocation ensures products approaching expiry dates are prioritized during sales, dramatically reducing grocery waste.
- **Catalogue & Inventory Management:** Multi-category product management with unique SKU constraints, barcode tracking, safety thresholds, and real-time stock status (Healthy, Low Stock, Out of Stock).
- **Stock Operations & Auditing:** Full audit trail for Stock-In, Stock-Out, Stock Adjustments, and Transfers, with previous and updated quantity logging and unique transaction idempotency.
- **Procurement & Purchase Orders:** Purchase order workflow (Draft, Approved, Received), supplier catalog mapping, lead time tracking, and automated inventory replenishment upon receipt.
- **Supplier Relationship Management:** Centralized vendor directory with contact details, GSTIN, payment terms, and historical performance ratings.
- **Automated Alerts & Notifications:** Dynamic background alert generator for low stock, impending batch expiration (7-day window), overstock conditions, and pending purchase receipts.
- **Business Intelligence & Analytics:** Real-time revenue reporting, weekly/monthly sales trends, profit & loss analysis, demand forecasting based on sales velocity, and authenticated CSV exports.
- **Enterprise Security:** Hardened with Firebase Authentication, Firebase Admin SDK token verification, role-based authorization (Admin, Manager, Cashier), Content Security Policy (Helmet), CORS origin filtering, and API rate limiting.

---

## Technology Stack

### Frontend
- **HTML5 & Vanilla JavaScript (ES Modules):** Clean, modular single-page application (SPA) architecture with zero heavy frontend bundle dependencies.
- **Modern CSS3:** Responsive dashboard layout, dark/emerald supermarket theme (`#183b2c`), custom modal workflows, and responsive data tables.
- **Firebase Web SDK (v10 / v13):** Client authentication, token lifecycle management, and secure password recovery.

### Backend
- **Node.js (v18+) & Express.js (v5.1):** RESTful API with modular middleware architecture.
- **SQLite3 via `better-sqlite3`:** Embedded, zero-configuration database running in Write-Ahead Logging (`WAL`) mode with foreign key constraint enforcement.
- **Firebase Admin SDK (v14.5):** Server-side ID token verification, store-level claims assertion, and secure credential handling.
- **Security Middlewares:** `helmet` (CSP, HSTS, frame protection), `cors` (origin validation), `express-rate-limit` (brute-force defense), and `zod` (runtime schema validation).

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       AMORA Client                          │
│   (index.html · app.js · firebase-auth.js · styles.css)     │
└───────────────┬─────────────────────────────▲───────────────┘
                │                             │
    Client Auth │ (Firebase ID Token)         │ Server Config & Assets
                ▼                             │
┌─────────────────────────────┐               │
│   Firebase Authentication   │               │
│      (Project amora-6134f)  │               │
└───────────────┬─────────────┘               │
                │ Token Verification          │
                ▼                             │
┌─────────────────────────────────────────────┴───────────────┐
│                    AMORA Backend API                        │
│                (Node.js / Express on Port 4016)             │
│  - Helmet Content Security Policy                           │
│  - CORS Origin Filtering                                    │
│  - Rate Limiting (600 req/15m API, 60 req/15m Auth)        │
│  - Store-Level Access Isolation (store_id = amora-main)     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                       SQL Prepared Statements
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 SQLite Embedded Database                    │
│             (backend/data/amora.sqlite - WAL Mode)          │
│   - Products & Inventory Batches (FEFO Tracking)            │
│   - Sales, Purchase Orders & Suppliers                      │
│   - Stock Movements & Audit Logs (Idempotent Keys)          │
└─────────────────────────────────────────────────────────────┘
```

---

## Installation & Setup

### 1. Prerequisites
- **Node.js:** v18.0.0 or higher (v24.x tested and supported)
- **npm:** v9.x or higher
- **Firebase Account:** Google Firebase project (`amora-6134f` or your own project)

### 2. Clone the Repository
```bash
git clone https://github.com/your-username/amora-inventory.git
cd amora-inventory
```

### 3. Install Dependencies
```bash
cd backend
npm install
cd ..
```

---

## Environment Configuration

Create a `.env` file in the project root directory by copying the provided template:

```bash
cp .env.example .env
```

Configure your environment variables in `.env`:

```ini
# Server Network Configuration
PORT=4016
NODE_ENV=development
CORS_ORIGIN=http://localhost:4016,http://localhost:4000

# Database Configuration (Relative to project root or absolute path)
DATABASE_PATH=backend/data/amora.sqlite

# Authentication & Legacy Fallback
# Set to 'false' in production. Firebase Authentication is the authoritative provider.
ALLOW_LEGACY_AUTH=false
JWT_SECRET=your-random-64-character-jwt-secret

# Firebase Admin SDK Configuration (Server-Side)
# File path to your service account key JSON file
GOOGLE_APPLICATION_CREDENTIALS=C:\secure\amora-6134f-firebase-adminsdk-fbsvc-4ae7969ea8.json

# Firebase Client SDK Configuration (Served to browser via /api/firebase-config)
FIREBASE_API_KEY=your-firebase-web-api-key
FIREBASE_AUTH_DOMAIN=amora-6134f.firebaseapp.com
FIREBASE_PROJECT_ID=amora-6134f
FIREBASE_STORAGE_BUCKET=amora-6134f.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=your-messaging-sender-id
FIREBASE_APP_ID=your-web-app-id
```

> **Security Notice:** Never commit `.env` or service account JSON files to version control. They are strictly ignored by `.gitignore`.

---

## Database Initialization & Seeding

The application automatically initializes its database tables, migrations, and default catalog on first boot. To manually seed a fresh database:

```bash
cd backend
npm run seed
```

This creates the default store `amora-main`, catalogue categories, demo products, opening inventory batches, suppliers, and system settings.

---

## Running the Application

### Development Mode (with file watching)
```bash
cd backend
npm run dev
```

### Production Mode
```bash
cd backend
npm start
```

The application will be accessible at:
```
http://localhost:4016
```

---

## Testing Instructions

AMORA includes an automated pre-deployment test suite that verifies database constraints, FEFO logic, transactions, rate limiting, and security middlewares in an isolated test database without modifying production records.

Execute the test suite:
```bash
node scratch/run_test_suite.mjs
```

Verify syntax across all files:
```bash
node --check backend/server.js
node --check app.js
node --check firebase-auth.js
node --check firebase-config.js
node --check firebase-services.js
```

---

## Security Best Practices

1. **Keep `ALLOW_LEGACY_AUTH=false`:** Disables local password endpoints, ensuring Firebase Authentication with email verification remains the only entry point.
2. **Service Account Protection:** Keep your Firebase service account private key in a secure external directory (`C:\secure\` or system secret manager).
3. **Database Write-Ahead Logging:** SQLite runs with `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON` for data integrity under concurrent transactions.
4. **Automated Backups:** Trigger authenticated database backups periodically via `/api/backup` using an admin token.

---

## License

Private / Proprietary – AMORA Retail Pvt. Ltd. All rights reserved.
#   A M O R A - I n v e n t o r y - C o n t r o l - S y s t e m  
 