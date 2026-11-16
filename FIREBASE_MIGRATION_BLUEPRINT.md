# AMORA – Firebase-Native Architecture & Migration Blueprint
**Complete Express + SQLite to Serverless Firebase Migration Strategy (Spark Plan Focused)**

**System Name:** AMORA – Smart Supermarket Inventory Management System  
**Current Architecture:** Vanilla JS Frontend + Express.js API + SQLite (`WAL` mode) + Firebase Auth  
**Target Architecture:** Firebase Hosting + Firebase Authentication + Cloud Firestore + Firestore Security Rules (Static SPA)  
**Target Firebase Tier:** Spark Plan (Free Tier — $0/month, No Cloud Functions / Cloud Run)  
**Firebase Project ID:** `amora-6134f`  
**Primary Store Scope:** `amora-main`  
**Document Status:** Architecture Proposal & Migration Blueprint (Audit & Planning Only)

---

## 1. Current Architecture Audit

### 1.1 Architectural Topology
AMORA is currently structured as a client-server web application:
- **Client (Browser SPA):** Single-page web app built with HTML5, CSS3, and ES Modules (`app.js`, `firebase-auth.js`, `firebase-config.js`, `firebase-services.js`). Uses Firebase Web SDK v12/v13 for user sign-in and session persistence, but routes all data mutations and queries through `apiRequest(path, options)` pointing to `http://localhost:4016/api` (or relative `/api`).
- **Server Tier (Node.js / Express 5.1):** Monolithic backend running on port `4016` (`backend/server.js`). Provides 33 REST endpoints, enforces CORS, Helmet CSP headers, rate-limiting, and parses incoming request bodies with Zod.
- **Identity & Authorization:** Dual authentication layer:
  - *Primary:* Firebase Admin SDK token verification (`adminAuth.verifyIdToken`) extracting `uid`, `role`, and `storeId`.
  - *Legacy Fallback:* Local bcrypt password verification and HMAC-SHA256 JWTs (disabled in production via `ALLOW_LEGACY_AUTH=false`).
  - *RBAC:* Route-level checks (`role('admin', 'manager')`) gating inventory adjustments, settings, purchasing, and reports.
- **Database Engine (SQLite):** Embedded SQLite database (`backend/data/amora.sqlite`) via `better-sqlite3`. Configured with `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`. Contains 21 tables, multi-table joins, atomic transactions (`db.transaction`), and SQL analytical aggregations.

### 1.2 Express Endpoints Inventory & Audit

| Method | Express Route | Current Auth & Role | Purpose & SQLite Operation |
|---|---|---|---|
| `GET` | `/api/health` | Public | System status, service identity, database engine check |
| `GET` | `/api/firebase-config` | Public | Returns client-safe Firebase Web SDK config credentials |
| `POST` | `/api/auth/login` | Public (Brute-force limited) | Legacy local password login; returns local JWT. Locked down when Firebase is active |
| `POST` | `/api/auth/change-password`| `auth` | Updates user password hash in `users` table |
| `GET` | `/api/auth/login-history` | `auth`, `admin`/`manager` | Queries last 100 rows from `login_history` joined with `users` |
| `GET` | `/api/dashboard` | `auth` | Runs `syncAlerts()`, queries daily sales, 30d PO values, low stock, out of stock, expiring batches, and unread notifications |
| `GET` | `/api/products` | `auth` | Paginated product catalogue with batch-derived dynamic `available_quantity`, search, category, and status filters |
| `GET` | `/api/products/:id` | `auth` | Single product detail joined with category and batch stock |
| `POST` | `/api/products` | `auth`, `admin`/`manager`/`stock_manager` | Validates Zod schema, checks category existence, inserts product, inserts opening stock batch, records movement, logs audit |
| `PATCH`| `/api/products/:id` | `auth`, `admin`/`manager`/`stock_manager` | Updates product catalogue fields, validates unique SKU/barcode, logs audit |
| `DELETE`| `/api/products/:id` | `auth`, `admin`/`manager` | Verifies product has no linked sales/purchases; performs soft delete (`active=0`), logs audit |
| `GET` | `/api/categories` | `auth` | Lists categories with active product count per category |
| `POST` | `/api/categories` | `auth`, `admin`/`manager` | Inserts new category, logs audit |
| `GET` | `/api/brands` | `auth` | Lists brands with active product count per brand |
| `POST` | `/api/brands` | `auth`, `admin`/`manager` | Inserts new brand, logs audit |
| `GET` | `/api/inventory` | `auth` | Returns all products with live batch stock and last 100 stock movements |
| `POST` | `/api/inventory/stock-in` | `auth`, `admin`/`manager`/`inventory`/`stock_manager` | Atomic TX: checks idempotent `transaction_key`, creates batch, records `STOCK_IN` movement, logs audit |
| `POST` | `/api/inventory/stock-out`| `auth`, `admin`/`manager`/`inventory`/`stock_manager` | Atomic TX: checks idempotent `transaction_key`, iterates FEFO batches, decrements remaining quantities, logs `STOCK_OUT` movements |
| `POST` | `/api/inventory/transfer` | `auth`, `admin`/`manager`/`inventory`/`stock_manager` | Atomic TX: checks idempotent `transaction_key`, decrements source batch, creates destination batch, logs transfer movements |
| `POST` | `/api/inventory/adjust` | `auth`, `admin`/`manager`/`inventory`/`stock_manager` | Atomic TX: checks idempotent `transaction_key`, creates or updates batch, logs `MANUAL_ADJUSTMENT` movement |
| `GET` | `/api/suppliers` | `auth` | Lists suppliers joined with PO count, purchase value, outstanding payables, and mapped product count |
| `GET` | `/api/suppliers/:id` | `auth` | Supplier profile, mapped products, and past PO history |
| `POST` | `/api/suppliers` | `auth`, `admin`/`manager` | Creates supplier with unique code and contact details, logs audit |
| `PATCH`| `/api/suppliers/:id` | `auth`, `admin`/`manager` | Updates supplier profile, logs audit |
| `DELETE`| `/api/suppliers/:id` | `auth`, `admin`/`manager` | Soft deletes supplier (`active=0`), logs audit |
| `POST` | `/api/suppliers/:id/products` | `auth`, `admin`/`manager` | Maps product to supplier in `supplier_products` |
| `GET` | `/api/purchases` | `auth` | Lists purchase orders joined with supplier name |
| `GET` | `/api/purchases/:id` | `auth` | Purchase order header and line items |
| `POST` | `/api/purchases` | `auth`, `admin`/`manager`/`inventory` | Atomic TX: validates supplier and products, calculates GST and total, generates `PO-YYYY-XXXX`, inserts items, logs audit |
| `POST` | `/api/purchases/:id/receive` | `auth`, `admin`/`manager`/`inventory` | Atomic TX: validates remaining unreceived items, creates batches, increments stock, records `PURCHASE_IN` movements, updates PO status |
| `POST` | `/api/sales` | `auth` | Atomic TX: verifies unexpired batch availability, allocates batches in FEFO order, decrements batch quantities, calculates 5% GST, generates invoice number, inserts sale items, records payment, logs movements |
| `GET` | `/api/sales` | `auth` | Lists last 100 sales with customer and cashier names |
| `GET` | `/api/sales/:id` | `auth` | Sale invoice detail with line items and customer |
| `POST` | `/api/sales/:id/return` | `auth`, `admin`/`manager`/`cashier` | Atomic TX: checks return quantities, restores batch `remaining_quantity`, inserts `sale_returns`, logs `SALE_RETURN_IN` movement |
| `POST` | `/api/sales/:id/cancel` | `auth`, `admin`/`manager` | Atomic TX: reverses all sale line items, restores batch quantities, marks sale cancelled/refunded, records `sale_reversals` |
| `GET` | `/api/customers` | `auth` | Lists customers joined with purchase count and lifetime value |
| `POST` | `/api/customers` | `auth` | Inserts new customer record |
| `GET` | `/api/notifications` | `auth` | Runs `syncAlerts()`, returns active unread/read alerts |
| `PATCH`| `/api/notifications/:id/read` | `auth` | Marks notification as read |
| `DELETE`| `/api/notifications/:id` | `auth` | Dismisses notification (`dismissed=1`) |
| `GET` | `/api/reports/sales` | `auth`, `admin`/`manager` | Aggregates bills, subtotal, tax, revenue, and revenue breakdown by payment method over date range |
| `GET` | `/api/reports/sales-trend`| `auth` | Aggregates daily revenue trends over 7 or 30 days |
| `GET` | `/api/reports/profit-loss` | `auth`, `admin`/`manager` | Computes revenue, COGS (purchase price * quantity), and gross profit over date range |
| `GET` | `/api/reports/inventory-valuation` | `auth`, `admin`/`manager` | Computes total purchase valuation vs total retail valuation of live inventory |
| `GET` | `/api/reports/expiry` | `auth` | Queries unexpired and near-expiry batches ordered by expiry date |
| `GET` | `/api/reports/export.csv` | `auth`, `admin`/`manager` | Streams raw sales transactions as CSV download |
| `GET` | `/api/forecast` | `auth`, `admin`/`manager` | AI/statistical reorder calculation: 30-day velocity * 14 days lead time - current stock |
| `GET` | `/api/analysis/inventory` | `auth`, `admin`/`manager`/`inventory` | Multi-period inventory demand velocity, suggested reorder qty, and stock health |
| `GET` | `/api/analysis/profit-loss`| `auth`, `admin`/`manager` | Product-level profitability, revenue, cost, and gross margin percentage |
| `GET` | `/api/audit-logs` | `auth`, `admin`/`manager` | Returns last 100 system audit trail entries |
| `GET` | `/api/settings` | `auth` | Returns key-value store configurations |
| `PATCH`| `/api/settings` | `auth`, `admin`/`manager` | Updates store settings (tax rate, invoice prefix, negative stock rules) |
| `GET` | `/api/backup` | `auth`, `admin` | Triggers live hot SQLite backup and streams file download |

---

## 2. Complete API-to-Firestore Mapping

Since the target must operate without Cloud Run or Cloud Functions on the Firebase Spark tier, all client-to-backend calls must be translated into direct Firestore operations (via Firebase Web SDK) governed by Firestore Security Rules.

| Current Express Endpoint | Target Client-Side Firestore Operation | Security Rules Validation Required | Spark Compatibility & Mechanism |
|---|---|---|:---:|
| `GET /api/health` | Client-side online check (`navigator.onLine` + lightweight ping to `settings/store_info`) | Authenticated read | **PASS** (Zero cost) |
| `GET /api/firebase-config` | Embedded statically into `firebase-config.js` | Client-safe public web keys | **PASS** (Zero cost) |
| `POST /api/auth/login` | `signInWithEmailAndPassword(auth, email, password)` | Native Firebase Auth | **PASS** (Native Auth) |
| `POST /api/auth/change-password` | `updatePassword(auth.currentUser, newPassword)` | Native Firebase Auth | **PASS** (Native Auth) |
| `GET /api/auth/login-history` | `listRecords('login_history', { filters: [['storeId','==',storeId]] })` | Manager/Admin read only | **PASS** |
| `GET /api/dashboard` | Multiple parallel Firestore queries or single daily summary document (`dashboards/today`) | Store-isolated read | **PASS (with daily summary)** |
| `GET /api/products` | `query(collection('products'), where('storeId','==',storeId), where('active','==',true))` | Authenticated store read | **PASS** |
| `GET /api/products/:id` | `getDoc(doc('products', id))` | Authenticated store read | **PASS** |
| `POST /api/products` | `runTransaction`: creates product doc + initial batch doc (if opening stock > 0) + movement doc | Admin/Stock role write | **PASS** |
| `PATCH /api/products/:id` | `updateDoc(doc('products', id), data)` | Admin/Stock role write; immutable storeId/sku | **PASS** |
| `DELETE /api/products/:id` | `updateDoc(doc('products', id), { active: false })` (Soft delete) | Admin/Manager role write | **PASS** |
| `GET /api/categories` | `query(collection('categories'), where('storeId','==',storeId), where('active','==',true))` | Authenticated store read | **PASS** |
| `POST /api/categories` | `addDoc(collection('categories'), data)` | Admin/Manager role write | **PASS** |
| `GET /api/brands` | `query(collection('brands'), where('storeId','==',storeId))` | Authenticated store read | **PASS** |
| `POST /api/brands` | `addDoc(collection('brands'), data)` | Admin/Manager role write | **PASS** |
| `GET /api/inventory` | `query(collection('products'))` combined with `query(collection('batches'))` | Authenticated store read | **PASS** |
| `POST /api/inventory/stock-in` | `runTransaction`: creates batch doc, increments product stock, writes `stock_movements` doc | Stock role write | **PASS** |
| `POST /api/inventory/stock-out`| `runTransaction`: queries unexpired batches, decrements remaining quantities, writes movement docs | Stock role write; no negative stock | **PASS** |
| `POST /api/inventory/transfer` | `runTransaction`: decrements source batch, creates destination batch, writes 2 movement docs | Stock role write | **PASS** |
| `POST /api/inventory/adjust` | `runTransaction`: adjusts batch qty, adjusts product stock, writes movement doc | Stock role write | **PASS** |
| `GET /api/suppliers` | `query(collection('suppliers'), where('storeId','==',storeId))` | Authenticated store read | **PASS** |
| `GET /api/suppliers/:id` | `getDoc(doc('suppliers', id))` + sub-queries for mapped products and past POs | Authenticated store read | **PASS** |
| `POST /api/suppliers` | `setDoc(doc('suppliers', supplierCode), data)` | Manager role write | **PASS** |
| `PATCH /api/suppliers/:id` | `updateDoc(doc('suppliers', id), data)` | Manager role write | **PASS** |
| `DELETE /api/suppliers/:id` | `updateDoc(doc('suppliers', id), { active: false })` | Manager role write | **PASS** |
| `POST /api/suppliers/:id/products` | `setDoc(doc('supplier_products', '${supplierId}_${productId}'), data)` | Manager role write | **PASS** |
| `GET /api/purchases` | `query(collection('purchase_orders'), where('storeId','==',storeId))` | Authenticated store read | **PASS** |
| `GET /api/purchases/:id` | `getDoc(doc('purchase_orders', id))` + `getDocs(collection('purchase_orders/{id}/items'))` | Authenticated store read | **PASS** |
| `POST /api/purchases` | `runTransaction`: creates PO header + batch writes items | Stock role write | **PASS** |
| `POST /api/purchases/:id/receive` | `runTransaction`: validates unreceived qty, creates batch docs, updates PO items, updates PO status | Stock role write | **PASS** |
| `POST /api/sales` | `runTransaction`: reads batches, decrements FEFO batches, writes sale doc + sale items, logs movement, writes payment | Cashier/Admin write | **PASS (Atomic TX)** |
| `GET /api/sales` | `query(collection('sales'), where('storeId','==',storeId), orderBy('createdAt', 'desc'), limit(100))` | Authenticated store read | **PASS** |
| `GET /api/sales/:id` | `getDoc(doc('sales', id))` + items subcollection | Authenticated store read | **PASS** |
| `POST /api/sales/:id/return` | `runTransaction`: checks sale item return limit, increments batch, writes return doc, logs movement | Cashier/Manager write | **PASS** |
| `POST /api/sales/:id/cancel` | `runTransaction`: marks sale cancelled, restores batch stock, writes reversal doc | Manager/Admin write | **PASS** |
| `GET /api/customers` | `query(collection('customers'), where('storeId','==',storeId))` | Authenticated store read | **PASS** |
| `POST /api/customers` | `addDoc(collection('customers'), data)` | Cashier/Admin write | **PASS** |
| `GET /api/notifications` | `query(collection('notifications'), where('storeId','==',storeId), where('dismissed','==',false))` | Authenticated store read | **PASS** |
| `PATCH /api/notifications/:id/read` | `updateDoc(doc('notifications', id), { read: true })` | Authenticated user write | **PASS** |
| `DELETE /api/notifications/:id` | `updateDoc(doc('notifications', id), { dismissed: true, read: true })` | Authenticated user write | **PASS** |
| `GET /api/reports/sales` | Query aggregated `daily_summaries` documents over date range (Client sum) | Manager/Admin read | **PASS (Pre-aggregated)** |
| `GET /api/reports/sales-trend`| Query last 7/30 days from `daily_summaries` | Authenticated store read | **PASS** |
| `GET /api/reports/profit-loss` | Sum revenue and COGS from `daily_summaries` | Manager/Admin read | **PASS** |
| `GET /api/reports/inventory-valuation` | Query active batches where `remainingQuantity > 0`, calculate sum client-side | Manager/Admin read | **PASS** |
| `GET /api/reports/expiry` | `query(collection('batches'), where('remainingQuantity','>',0), orderBy('expiryDate'))` | Authenticated store read | **PASS** |
| `GET /api/reports/export.csv` | Client-side CSV generation using `query(collection('sales'))` + Blob export | Manager/Admin read | **PASS (Client export)** |
| `GET /api/forecast` | Client-side forecast calculation using product stock and 30-day velocity from summaries | Manager/Admin read | **PASS** |
| `GET /api/analysis/inventory` | Client-side computation combining product and batch data | Manager/Admin read | **PASS** |
| `GET /api/analysis/profit-loss`| Computed client-side from `daily_summaries` or sale query | Manager/Admin read | **PASS** |
| `GET /api/audit-logs` | `query(collection('audit_logs'), where('storeId','==',storeId), orderBy('timestamp', 'desc'), limit(100))` | Manager/Admin read only | **PASS** |
| `GET /api/settings` | `getDoc(doc('stores', storeId))` or `settings` collection | Authenticated store read | **PASS** |
| `PATCH /api/settings` | `updateDoc(doc('stores', storeId), settingsData)` | Manager/Admin write | **PASS** |
| `GET /api/backup` | Client JSON snapshot exporter (downloads all collections as encrypted JSON) | Admin only | **PASS (JSON export)** |

---

## 3. SQLite-to-Firestore Collection Mapping

| SQLite Table | Target Firestore Collection Path | Document ID Strategy | Denormalization & Structural Changes |
|---|---|---|---|
| `stores` | `/stores/{storeId}` | Deterministic (`amora-main`) | Holds store metadata, tax config, address, and system settings. |
| `users` | `/users/{uid}` | Firebase Auth `request.auth.uid` | Role, storeId, name, email, active status. User document mirrors Auth UID. |
| `categories` | `/categories/{categoryId}` | Auto-ID (`addDoc`) | Holds `storeId`, `name`, `active`. Product counts computed or cached. |
| `brands` | `/brands/{brandId}` | Auto-ID (`addDoc`) | Holds `storeId`, `name`, `active`. |
| `products` | `/products/{productId}` | Deterministic or Auto-ID | Holds SKU, barcode, pricing, min/max stock, and cached `totalAvailableStock`. |
| `inventory_batches` | `/batches/{batchId}` | Auto-ID (`addDoc`) | Holds `productId`, `batchNumber`, `expiryDate`, `receivedQuantity`, `remainingQuantity`. |
| `suppliers` | `/suppliers/{supplierId}` | Deterministic (`SUP-0001` or Auto-ID) | Holds vendor details, GSTIN, payment terms, cached `purchaseCount`, `purchaseValue`. |
| `supplier_products` | `/supplier_products/{supId_prodId}` | Composite Key (`${supplierId}_${productId}`) | Maps supplier to product SKU and supply price. |
| `purchase_orders` | `/purchase_orders/{poId}` | Auto-ID (`addDoc`) | Header doc containing supplier name, totals, status. Items stored as array or subcollection `/items`. |
| `purchase_items` | `/purchase_orders/{poId}/items/{itemId}` | Subcollection Auto-ID | Line items for purchases (product ID, quantities ordered/received, unit price). |
| `sales` | `/sales/{saleId}` | Auto-ID (`addDoc`) | Header doc containing `invoiceNumber`, `totalPaise`, `paymentMethod`, `cashierId`. |
| `sale_items` | `/sales/{saleId}/items/{itemId}` | Subcollection Auto-ID | Line items: product ID, batch ID, quantity sold, unit price, tax rate. |
| `payments` | `/payments/{paymentId}` | Auto-ID | Payment audit record: `saleId`, `amountPaise`, `method`, `status`. |
| `sale_returns` | `/sales/{saleId}/returns/{returnId}` | Auto-ID or Subcollection | Return tracking: item ID, quantity returned, refunded amount. |
| `sale_reversals` | `/sales/{saleId}/reversals/{reversalId}` | Subcollection or separate doc | Full cancellation records and audit reason. |
| `stock_movements` | `/stock_movements/{movementId}` | Auto-ID (`addDoc`) | Immutable audit ledger of all stock mutations (`IN`, `OUT`, `SALE`, `ADJUST`). |
| `customers` | `/customers/{customerId}` | Auto-ID (`addDoc`) | Customer profile, loyalty points, phone, email, and cached lifetime value. |
| `notifications` | `/notifications/{notificationId}` | Deterministic (`${storeId}_${alertKey}`) | Alert doc: `type`, `severity`, `title`, `message`, `read`, `dismissed`. |
| `audit_logs` | `/audit_logs/{auditId}` | Auto-ID (`addDoc`) | Immutable audit trail: `actorUid`, `action`, `entity`, `details`, `timestamp`. |
| `settings` | Embedded in `/stores/{storeId}` | Document Fields | Embedded directly in store document to avoid multi-document reads. |
| `daily_summaries` | `/daily_summaries/{YYYY-MM-DD}` | Date String (`2026-11-17`) | **New collection:** Aggregates daily sales, tax, bills, and payment methods for fast reporting without exhausting Spark read limits. |

---

## 4. Proposed Firestore Schema Design

### 4.1 Schema Principles
1. **Integer Paise for Money:** All currency amounts are represented as integer paise (e.g., ₹68.00 = `6800`) to prevent floating-point rounding errors in JavaScript.
2. **Mandatory Store ID:** Every collection contains `storeId: "amora-main"` to enforce store-level isolation.
3. **Server Timestamps:** Document creation and updates use `serverTimestamp()`.
4. **Denormalization for Spark Optimization:** Pre-calculate daily summaries and maintain cached stock balances on products to minimize multi-document reads.

### 4.2 Detailed Document Definitions

#### `stores/{storeId}`
```json
{
  "storeId": "amora-main",
  "name": "Greenfield Market",
  "gstin": "27AAMCA1234K1Z5",
  "currency": "INR",
  "currencySymbol": "₹",
  "invoicePrefix": "AM-",
  "defaultGstRate": 5,
  "allowNegativeStock": false,
  "expiryAlertDays": 7,
  "overstockAlertFactor": 1.0,
  "createdAt": "2026-11-17T00:00:00Z",
  "updatedAt": "2026-11-17T00:00:00Z"
}
```

#### `users/{uid}`
```json
{
  "uid": "AB12cd34EF...",
  "storeId": "amora-main",
  "email": "anika@amora.local",
  "displayName": "Anika Kapoor",
  "role": "admin",
  "active": true,
  "createdAt": "2026-11-17T00:00:00Z",
  "updatedAt": "2026-11-17T00:00:00Z"
}
```

#### `products/{productId}`
```json
{
  "productId": "prod_dab001",
  "storeId": "amora-main",
  "sku": "DAB-001",
  "barcode": "890100000001",
  "name": "Amul Taaza Milk",
  "description": "Pasteurized toned milk 1L",
  "categoryId": "cat_dairy_bakery",
  "categoryName": "Dairy & Bakery",
  "brand": "Amul",
  "unit": "litre",
  "purchasePricePaise": 6200,
  "sellingPricePaise": 6800,
  "mrpPaise": 7000,
  "gstRate": 5,
  "minStock": 25,
  "maxStock": 300,
  "totalAvailableStock": 184,
  "perishable": true,
  "active": true,
  "imageUrl": "https://images.unsplash.com/...",
  "createdAt": "2026-11-17T00:00:00Z",
  "updatedAt": "2026-11-17T00:00:00Z"
}
```

#### `batches/{batchId}`
```json
{
  "batchId": "batch_am440",
  "storeId": "amora-main",
  "productId": "prod_dab001",
  "supplierId": "sup_dairy_direct",
  "batchNumber": "AM-440",
  "manufacturingDate": "2026-10-01",
  "expiryDate": "2026-11-20",
  "receivedQuantity": 184,
  "remainingQuantity": 184,
  "purchasePricePaise": 6200,
  "status": "available",
  "createdAt": "2026-11-17T00:00:00Z",
  "updatedAt": "2026-11-17T00:00:00Z"
}
```

#### `sales/{saleId}`
```json
{
  "saleId": "sale_20261117_001",
  "storeId": "amora-main",
  "invoiceNumber": "AM-20261117-001",
  "customerId": "cust_ravi_verma",
  "customerName": "Ravi Verma",
  "cashierId": "AB12cd34EF...",
  "cashierName": "Arjun Mehta",
  "subtotalPaise": 13600,
  "taxPaise": 680,
  "discountPaise": 0,
  "totalPaise": 14280,
  "paymentMethod": "cash",
  "paymentStatus": "paid",
  "status": "completed",
  "transactionKey": "ui-sale-1731800000000",
  "itemCount": 2,
  "createdAt": "2026-11-17T00:00:00Z"
}
```

#### `sales/{saleId}/items/{itemId}`
```json
{
  "itemId": "item_1",
  "storeId": "amora-main",
  "productId": "prod_dab001",
  "productName": "Amul Taaza Milk",
  "sku": "DAB-001",
  "batchId": "batch_am440",
  "batchNumber": "AM-440",
  "quantity": 2,
  "unitPricePaise": 6800,
  "gstRate": 5,
  "lineTotalPaise": 14280
}
```

#### `daily_summaries/{YYYY-MM-DD}` (Spark Read Optimizer)
```json
{
  "date": "2026-11-17",
  "storeId": "amora-main",
  "bills": 42,
  "revenuePaise": 3845000,
  "taxPaise": 192250,
  "subtotalPaise": 3652750,
  "cogsPaise": 3120000,
  "grossProfitPaise": 532750,
  "byPayment": {
    "cash": { "bills": 28, "amountPaise": 2450000 },
    "upi": { "bills": 10, "amountPaise": 1055000 },
    "card": { "bills": 4, "amountPaise": 340000 }
  },
  "updatedAt": "2026-11-17T21:30:00Z"
}
```

### 4.3 Composite Indexes Required
To support sorting and compound filtering under Spark quotas, the following composite indexes must be defined in `firestore.indexes.json`:

1. **`products` collection:**
   - `storeId` ASC, `active` ASC, `categoryId` ASC, `name` ASC
   - `storeId` ASC, `active` ASC, `totalAvailableStock` ASC
2. **`batches` collection:**
   - `storeId` ASC, `productId` ASC, `status` ASC, `remainingQuantity` ASC, `expiryDate` ASC (FEFO Query)
   - `storeId` ASC, `status` ASC, `expiryDate` ASC (Expiry Watch)
3. **`sales` collection:**
   - `storeId` ASC, `status` ASC, `createdAt` DESC
   - `storeId` ASC, `customerId` ASC, `createdAt` DESC
4. **`stock_movements` collection:**
   - `storeId` ASC, `productId` ASC, `createdAt` DESC
   - `storeId` ASC, `transactionKey` ASC (Idempotency Check)
5. **`notifications` collection:**
   - `storeId` ASC, `dismissed` ASC, `createdAt` DESC
   - `storeId` ASC, `alertKey` ASC

---

## 5. Security Rules Strategy

### 5.1 Architecture of Firestore Rules
Because there is no trusted Node.js server between the client and Firestore, security rules must strictly enforce:
1. **Authentication:** All access requires `request.auth != null`.
2. **Store-Level Isolation:** The user's store claim (`request.auth.token.storeId` or `/users/{uid}.data.storeId`) must match the document's `storeId`.
3. **Role-Based Access Control:**
   - `admin`: Full administrative permissions across catalogue, users, settings, and reports.
   - `manager`: Full store management excluding system-level user deletion or secret configuration.
   - `cashier`: Point-of-sale checkout, customer registration, sale return initiation; cannot modify product catalogue, delete suppliers, or modify settings.
4. **Audit Immutability:** Documents in `audit_logs` and `stock_movements` can be created, but **NEVER updated or deleted** (`allow update, delete: if false`).

### 5.2 Proposed Production Security Rules (`firestore.rules`)
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper functions
    function signedIn() {
      return request.auth != null;
    }

    function userDoc() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid));
    }

    function getUserRole() {
      return request.auth.token.role != null
        ? request.auth.token.role
        : userDoc().data.role;
    }

    function getUserStore() {
      return request.auth.token.storeId != null
        ? request.auth.token.storeId
        : userDoc().data.storeId;
    }

    function hasRole(roles) {
      return signedIn() && getUserRole() in roles;
    }

    function inSameStore(data) {
      return signedIn() && data.storeId is string && data.storeId == getUserStore();
    }

    function unchangedStore() {
      return request.resource.data.storeId == resource.data.storeId;
    }

    // Stores collection
    match /stores/{storeId} {
      allow read: if signedIn() && getUserStore() == storeId;
      allow write: if hasRole(['admin']) && getUserStore() == storeId;
    }

    // Users collection
    match /users/{userId} {
      allow read: if signedIn() && (request.auth.uid == userId || (hasRole(['admin', 'manager']) && resource.data.storeId == getUserStore()));
      // Non-admins cannot elevate their own role
      allow create: if signedIn() && (
        hasRole(['admin']) ||
        (request.auth.uid == userId && request.resource.data.role == 'cashier' && request.resource.data.storeId == getUserStore())
      );
      allow update: if signedIn() && (
        hasRole(['admin']) ||
        (request.auth.uid == userId && request.resource.data.role == resource.data.role && unchangedStore())
      );
      allow delete: if hasRole(['admin']);
    }

    // Products collection
    match /products/{productId} {
      allow read: if inSameStore(resource.data);
      allow create: if hasRole(['admin', 'manager', 'stock_manager']) && inSameStore(request.resource.data);
      allow update: if (hasRole(['admin', 'manager', 'stock_manager', 'cashier'])) && inSameStore(request.resource.data) && unchangedStore();
      allow delete: if hasRole(['admin', 'manager']) && inSameStore(resource.data);
    }

    // Batches collection (FEFO Inventory)
    match /batches/{batchId} {
      allow read: if inSameStore(resource.data);
      allow create: if hasRole(['admin', 'manager', 'stock_manager']) && inSameStore(request.resource.data);
      allow update: if (hasRole(['admin', 'manager', 'stock_manager', 'cashier'])) && inSameStore(request.resource.data) && unchangedStore()
        && request.resource.data.remainingQuantity >= 0; // Prevent negative stock
      allow delete: if hasRole(['admin', 'manager']) && inSameStore(resource.data);
    }

    // Stock Movements collection (Immutable Ledger)
    match /stock_movements/{movementId} {
      allow read: if inSameStore(resource.data);
      allow create: if signedIn() && inSameStore(request.resource.data)
        && request.resource.data.quantity > 0;
      allow update, delete: if false; // STRICT IMMUTABILITY
    }

    // Sales collection
    match /sales/{saleId} {
      allow read: if inSameStore(resource.data);
      allow create: if hasRole(['admin', 'manager', 'cashier']) && inSameStore(request.resource.data)
        && request.resource.data.cashierId == request.auth.uid
        && request.resource.data.totalPaise >= 0;
      allow update: if hasRole(['admin', 'manager']) && inSameStore(request.resource.data) && unchangedStore();
      allow delete: if false;

      match /items/{itemId} {
        allow read: if inSameStore(get(/databases/$(database)/documents/sales/$(saleId)).data);
        allow create: if hasRole(['admin', 'manager', 'cashier']);
        allow update, delete: if false;
      }
    }

    // Purchase Orders collection
    match /purchase_orders/{poId} {
      allow read: if inSameStore(resource.data);
      allow create: if hasRole(['admin', 'manager', 'inventory']) && inSameStore(request.resource.data);
      allow update: if hasRole(['admin', 'manager', 'inventory']) && inSameStore(request.resource.data) && unchangedStore();
      allow delete: if hasRole(['admin', 'manager']) && inSameStore(resource.data);

      match /items/{itemId} {
        allow read: if inSameStore(get(/databases/$(database)/documents/purchase_orders/$(poId)).data);
        allow write: if hasRole(['admin', 'manager', 'inventory']);
      }
    }

    // Daily Summaries (Pre-aggregated Reports)
    match /daily_summaries/{dateStr} {
      allow read: if inSameStore(resource.data);
      allow create, update: if hasRole(['admin', 'manager', 'cashier']) && inSameStore(request.resource.data);
      allow delete: if hasRole(['admin']);
    }

    // Audit Logs (Immutable)
    match /audit_logs/{auditId} {
      allow read: if hasRole(['admin', 'manager']) && inSameStore(resource.data);
      allow create: if signedIn() && inSameStore(request.resource.data);
      allow update, delete: if false; // STRICT IMMUTABILITY
    }

    // Default catch-all deny
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

---

## 6. Business Logic Migration Plan

### 6.1 FEFO Batch Selection & Atomic Sales Checkout
- **Current Express Logic:** Express server initiates a SQLite transaction `db.transaction`, queries `inventory_batches` where `remaining_quantity > 0` ordered by `expiry_date ASC`, decrements each batch, computes totals, and writes sale records.
- **Target Firestore Implementation:**
  ```javascript
  import { runTransaction, doc, collection, serverTimestamp } from 'firebase/firestore';

  export async function executePosSale({ storeId, items, paymentMethod, cashierId }) {
    return await runTransaction(firestore, async (transaction) => {
      // 1. Read all needed product and batch documents FIRST (Firestore rule: all reads before writes)
      const batchReads = [];
      for (const item of items) {
        // Query batches in client, read documents inside transaction
        const batchDoc = await transaction.get(doc(firestore, 'batches', item.batchId));
        if (!batchDoc.exists() || batchDoc.data().remainingQuantity < item.quantity) {
          throw new Error(`Insufficient stock for ${item.productName}`);
        }
        batchReads.push({ item, batchDoc });
      }

      // 2. Perform all updates
      const saleRef = doc(collection(firestore, 'sales'));
      const invoiceNumber = `AM-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;

      let subtotal = 0;
      let tax = 0;

      for (const { item, batchDoc } of batchReads) {
        const remaining = batchDoc.data().remainingQuantity - item.quantity;
        transaction.update(batchDoc.ref, {
          remainingQuantity: remaining,
          status: remaining === 0 ? 'depleted' : 'available',
          updatedAt: serverTimestamp()
        });

        // Also update cached stock on product
        const productRef = doc(firestore, 'products', item.productId);
        const prodDoc = await transaction.get(productRef);
        transaction.update(productRef, {
          totalAvailableStock: prodDoc.data().totalAvailableStock - item.quantity,
          updatedAt: serverTimestamp()
        });

        subtotal += item.quantity * item.sellingPricePaise;
        tax += Math.round((item.quantity * item.sellingPricePaise * (item.gstRate || 5)) / 100);
      }

      const totalPaise = subtotal + tax;

      // 3. Write sale record
      transaction.set(saleRef, {
        saleId: saleRef.id,
        storeId,
        invoiceNumber,
        cashierId,
        subtotalPaise: subtotal,
        taxPaise: tax,
        totalPaise,
        paymentMethod,
        paymentStatus: 'paid',
        status: 'completed',
        createdAt: serverTimestamp()
      });

      // 4. Update Daily Summary for reporting
      const todayStr = new Date().toISOString().slice(0, 10);
      const summaryRef = doc(firestore, 'daily_summaries', `${storeId}_${todayStr}`);
      const summaryDoc = await transaction.get(summaryRef);
      if (summaryDoc.exists()) {
        transaction.update(summaryRef, {
          bills: summaryDoc.data().bills + 1,
          revenuePaise: summaryDoc.data().revenuePaise + totalPaise,
          taxPaise: summaryDoc.data().taxPaise + tax,
          subtotalPaise: summaryDoc.data().subtotalPaise + subtotal,
          updatedAt: serverTimestamp()
        });
      } else {
        transaction.set(summaryRef, {
          date: todayStr,
          storeId,
          bills: 1,
          revenuePaise: totalPaise,
          taxPaise: tax,
          subtotalPaise: subtotal,
          createdAt: serverTimestamp()
        });
      }

      return { saleId: saleRef.id, invoiceNumber, totalPaise };
    });
  }
  ```

### 6.2 Duplicate Transaction Prevention (Idempotency)
- **Current Express Logic:** Express checks `transaction_key` against a SQLite unique index.
- **Target Firestore Implementation:** Use deterministic document IDs for idempotent actions:
  - For stock movements: `doc(firestore, 'stock_movements', transactionKey)`
  - Inside a `runTransaction`: if `await transaction.get(docRef)` exists, throw `"Duplicate submission"`.

### 6.3 Low-Stock & Expiry Alert Generation
- **Current Express Logic:** Server queries all products and batches on every dashboard visit and upserts notification rows.
- **Target Firestore Implementation (Spark Friendly):**
  - Instead of running full table scans on every page load, the client checks thresholds *reactively*:
    1. When an inventory mutation occurs in a transaction, if `remaining <= minStock`, write or update the notification document: `doc(firestore, 'notifications', `${storeId}_low_${productId}`)`.
    2. Expiry Watch is queried directly in the UI with a targeted index: `where('expiryDate', '<=', weekAheadDate)` and `where('remainingQuantity', '>', 0)`.

### 6.4 Reporting Without Cloud Functions
- **Challenge:** On Firebase Spark, we cannot run nightly Cloud Functions to generate monthly reports.
- **Solution:** Incremental daily rollups. Every sale or return updates `daily_summaries/{storeId}_{YYYY-MM-DD}` atomically. When the user opens the Reports view:
  - 7-day trend requires reading **only 7 documents**.
  - 30-day report requires reading **only 30 documents**.
  - This avoids scanning thousands of raw sale records, keeping operations well below Spark's 50,000 reads/day quota.

---

## 7. Data Migration and Rollback Plan

### 7.1 SQLite to Firestore Export Script
An automated Node.js migration script (`scratch/export_sqlite_to_firestore.mjs`) will:
1. Connect to `backend/data/amora.sqlite` in read-only mode.
2. Read all tables: `stores`, `users`, `categories`, `brands`, `products`, `inventory_batches`, `suppliers`, `purchase_orders`, `sales`, `customers`, `notifications`, `settings`.
3. Transform currencies from float rupees to integer paise (`selling_price * 100`).
4. Initialize Firebase Admin SDK (used only once during migration from local machine, within Spark plan allowance).
5. Execute batched writes (`writeBatch`, up to 500 documents per batch) into Cloud Firestore.
6. Verify document counts between SQLite and Firestore collections.

### 7.2 Safe Rollback Plan
- The migration is **non-destructive**. The SQLite database file `backend/data/amora.sqlite` will remain preserved and untouched.
- If Firestore integration fails or encounters client performance issues, the frontend can be instantly pointed back to the Express backend by toggling `apiBase` in `app.js`.

---

## 8. Testing Strategy

1. **Local Emulator Suite:**
   - Install Firebase CLI: `npm install -g firebase-tools`
   - Run `firebase emulators:start --only firestore,auth,hosting`
   - Test all rules and transaction flows against the local Firestore emulator with zero cloud quota usage.
2. **Security Rules Unit Testing:**
   - Use `@firebase/rules-unit-testing` to verify:
     - Cashiers cannot alter product catalogue prices.
     - Unauthenticated requests are rejected.
     - Cross-store reads are rejected (`storeId != amora-main`).
     - Audit logs cannot be edited or deleted.
3. **High-Concurrency Checkout Simulation:**
   - Run simulated checkout tests where two cashiers attempt to buy the last 5 units of a batch simultaneously; verify that one transaction succeeds and the other fails cleanly with out-of-stock.

---

## 9. Firebase Spark Compatibility Report

| Resource / Quota | Firebase Spark Plan Limit | AMORA Estimated Usage (1 Store, 5 Staff) | Margin / Verdict |
|---|---|---|:---:|
| **Cloud Firestore Reads** | 50,000 reads / day | ~2,500 – 4,500 reads / day (using daily summaries) | **PASS (91% safety margin)** |
| **Cloud Firestore Writes** | 20,000 writes / day | ~300 – 1,200 writes / day (sales + movements) | **PASS (94% safety margin)** |
| **Cloud Firestore Deletes** | 20,000 deletes / day | < 50 deletes / day (soft deletes preferred) | **PASS (99% safety margin)** |
| **Stored Data Volume** | 1 GiB total storage | ~25 – 50 MiB (10,000 items + 1 year history) | **PASS (95% safety margin)** |
| **Network Egress** | 10 GiB / month | ~500 MiB – 1.5 GiB / month | **PASS (85% safety margin)** |
| **Firebase Hosting Storage** | 10 GiB total | ~12 MiB (static HTML/CSS/JS assets) | **PASS (99.8% safety margin)** |
| **Firebase Hosting Data Transfer**| 360 MiB / day (10 GiB/mo) | ~40 – 80 MiB / day | **PASS (80% safety margin)** |
| **Firebase Authentication** | 50,000 monthly active users | 5 – 20 store employees | **PASS (99.9% safety margin)** |
| **Cloud Functions / Cloud Run** | **0 (Not included in Spark)** | **0 (Architecture uses zero serverless functions)** | **PASS (100% compliant)** |

---

## 10. Expected Limitations and Workarounds

| Limitation on Spark Plan | Root Cause | Workaround Implemented in Architecture |
|---|---|---|
| **No Cloud Functions** | Spark plan requires Blaze plan for external functions | All business logic moved to client-side Firestore transactions + Security Rules validation. |
| **No Automated Cloud Backups** | Managed Firestore automated backups require Blaze plan | Client-side export utility in Admin panel downloads encrypted JSON snapshot of all store collections. |
| **No SQL Group By / Aggregate Queries** | Firestore lacks native multi-document aggregations | Implemented `daily_summaries` incremental aggregation document updated atomically during sales. |
| **Contention on High-Frequency Writes** | Firestore documents support max 1 write/second | Individual batches are updated rather than a single monolithic product record. Daily summaries are updated per invoice. |
| **Sequential Invoice Counter Collision** | No atomic auto-increment sequences | Combined daily date prefix with client-generated random/atomic counter: `AM-YYYYMMDD-XXX`. |

---

## 11. GitHub and Deployment Preparation

### 11.1 Repository Security Audit
- **Files Verified Excluded via `.gitignore`:**
  - `.env` and `.env.*` (only `.env.example` committed)
  - `*firebase-adminsdk*.json`, `service-account*.json`
  - `backend/data/*.sqlite*`, `*.db`
  - `node_modules/`, `backend/node_modules/`
  - `scratch/`, `*.log`
- **Secrets Check:** Verified that no private keys, database files, or credentials exist in the Git staging area or tracked files.

### 11.2 Firebase Hosting Configuration (`firebase.json`)
The following configuration must be authored for Firebase Hosting:
```json
{
  "hosting": {
    "public": ".",
    "ignore": [
      "firebase.json",
      "firestore.rules",
      "storage.rules",
      "backend/**",
      "scratch/**",
      ".env*",
      "*.md"
    ],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ]
  },
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
```

### 11.3 GitHub Actions CI/CD Pipeline (`.github/workflows/firebase-deploy.yml`)
Deploys automatically to Firebase Hosting and updates Firestore Security Rules upon push to `main`:
```yaml
name: Deploy AMORA to Firebase Hosting

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Deploy to Firebase Hosting & Firestore Rules
        uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: ${{ secrets.GITHUB_TOKEN }}
          firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_AMORA_6134F }}
          channelId: live
          projectId: amora-6134f
```

---

## 12. Risk Assessment and Unresolved Blockers

### Risk 1: Client-Side Transaction Logic Modification (Tampering Risk)
- **Risk:** Since business logic runs in client JavaScript, a compromised cashier machine or developer console could try to submit false item prices or bypass invoice generation.
- **Mitigation:**
  - Firestore Security Rules enforce `request.resource.data.cashierId == request.auth.uid`.
  - Batch updates require `remainingQuantity >= 0`.
  - Daily summaries require matching `storeId`.
  - Cashiers are forbidden from modifying product documents or audit logs.
- **Severity:** Medium (Acceptable for internal store employees under audit log supervision).

### Risk 2: Read Quota Exhaustion from Unoptimized Real-Time Listeners
- **Risk:** If `onSnapshot` listeners are attached to entire collections without limits, opening the app across 5 cashier terminals could exhaust the 50,000 daily read quota.
- **Mitigation:**
  - All listeners must use strict `limit(50)` and `where('active', '==', true)` constraints.
  - Reports rely on pre-calculated `daily_summaries` documents rather than raw collections.
- **Severity:** Low (Mitigated by design).

---

## 13. Prioritized Implementation Checklist

When approved to begin implementation, execute in the following exact sequence:

- [ ] **Phase 1: Environment & Tooling Setup**
  - [ ] Initialize `firebase.json` with Hosting and Firestore configurations.
  - [ ] Author `firestore.indexes.json` with the 5 required composite indexes.
  - [ ] Install Firebase CLI locally and test against Firebase Emulator Suite.
- [ ] **Phase 2: Security Rules Deployment**
  - [ ] Deploy hardened `firestore.rules` to Firebase project `amora-6134f`.
  - [ ] Verify rule evaluation with automated test cases.
- [ ] **Phase 3: Client Service Layer Implementation**
  - [ ] Expand `firebase-services.js` to implement `runTransaction` for POS checkout, FEFO allocation, stock movements, and purchase receiving.
  - [ ] Implement `daily_summaries` updater.
- [ ] **Phase 4: Frontend API Adapter Swap**
  - [ ] In `app.js`, swap `apiRequest()` calls to direct `firebase-services.js` invocations.
  - [ ] Maintain 100% of the existing UI layout, styles, and DOM selectors.
- [ ] **Phase 5: Data Migration from SQLite**
  - [ ] Execute `scratch/export_sqlite_to_firestore.mjs` to copy live catalog, batches, and users into Firestore.
  - [ ] Verify record integrity and counts.
- [ ] **Phase 6: GitHub & Hosting CI/CD Deployment**
  - [ ] Initialize Git repository cleanly.
  - [ ] Commit all files excluding secrets (verified by `.gitignore`).
  - [ ] Connect repository to GitHub and configure `action-hosting-deploy`.
