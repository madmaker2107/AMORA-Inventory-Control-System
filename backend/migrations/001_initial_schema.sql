-- =============================================================================
-- AMORA Supermarket Management System - Migration 001: Initial Schema
-- Target: Neon PostgreSQL (Production Branch)
-- Compatible with PostgreSQL 15+
-- =============================================================================

-- Level 1: Root Tables (No Foreign Key Dependencies)

CREATE TABLE IF NOT EXISTS brands (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(25),
  email VARCHAR(255),
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  read SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  store_id VARCHAR(50) NOT NULL DEFAULT 'amora-main',
  alert_key VARCHAR(120) NOT NULL DEFAULT '',
  severity VARCHAR(30) NOT NULL DEFAULT 'warning',
  dismissed SMALLINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_store_alert ON notifications(store_id, alert_key);

CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(25),
  email VARCHAR(255),
  address TEXT,
  gstin VARCHAR(20),
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  supplier_code VARCHAR(30) NOT NULL DEFAULT '',
  contact_person VARCHAR(120) NOT NULL DEFAULT '',
  store_id VARCHAR(50) NOT NULL DEFAULT 'amora-main'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_store_code ON suppliers(store_id, supplier_code);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'cashier',
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Level 2: First-Degree Dependent Tables

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(40) UNIQUE NOT NULL,
  barcode VARCHAR(80) UNIQUE,
  name VARCHAR(120) NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  brand VARCHAR(80),
  unit VARCHAR(30) NOT NULL DEFAULT 'piece',
  purchase_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  selling_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  mrp NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 5,
  min_stock NUMERIC(10,2) NOT NULL DEFAULT 10,
  max_stock NUMERIC(10,2) NOT NULL DEFAULT 500,
  perishable SMALLINT NOT NULL DEFAULT 0,
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  description TEXT NOT NULL DEFAULT '',
  subcategory VARCHAR(80) NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  store_id VARCHAR(50) NOT NULL DEFAULT 'amora-main'
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  order_number VARCHAR(80) UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid',
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  order_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expected_date DATE,
  store_id VARCHAR(50) NOT NULL DEFAULT 'amora-main',
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  transaction_key VARCHAR(120)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_transaction_key ON purchase_orders(transaction_key) WHERE transaction_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  entity VARCHAR(50) NOT NULL,
  entity_id VARCHAR(100),
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS backups (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS login_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ip_address VARCHAR(50),
  success SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Level 3: Multi-Entity Dependent Tables

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  invoice_number VARCHAR(80) UNIQUE NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  subtotal NUMERIC(12,2) NOT NULL,
  tax NUMERIC(12,2) NOT NULL,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL,
  payment_method VARCHAR(50) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'completed',
  cashier_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  store_id VARCHAR(50) NOT NULL DEFAULT 'amora-main',
  payment_status VARCHAR(30) NOT NULL DEFAULT 'paid',
  transaction_key VARCHAR(120)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_transaction_key ON sales(transaction_key) WHERE transaction_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_batches (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  batch_number VARCHAR(80) NOT NULL,
  manufacturing_date DATE,
  expiry_date DATE,
  received_quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  remaining_quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  purchase_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'available',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supplier_products (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id VARCHAR(50) NOT NULL DEFAULT 'amora-main',
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, product_id)
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,2) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 5,
  received_quantity NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- Level 4: Financial & Settlement Tables

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  purchase_order_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
  method VARCHAR(50) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'paid',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  store_id VARCHAR(50) NOT NULL DEFAULT 'amora-main'
);

CREATE TABLE IF NOT EXISTS sale_reversals (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  store_id VARCHAR(50) NOT NULL DEFAULT 'amora-main',
  transaction_key VARCHAR(120) UNIQUE NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Level 5: Line Items & Stock Movements

CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id INTEGER NOT NULL REFERENCES inventory_batches(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,2) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 5,
  line_total NUMERIC(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id INTEGER REFERENCES inventory_batches(id) ON DELETE SET NULL,
  type VARCHAR(50) NOT NULL,
  quantity NUMERIC(12,2) NOT NULL,
  reference_id VARCHAR(100),
  reason TEXT,
  performed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  store_id VARCHAR(50) NOT NULL DEFAULT 'amora-main',
  previous_quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  transaction_key VARCHAR(120)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_transaction_key ON stock_movements(transaction_key) WHERE transaction_key IS NOT NULL;

-- Level 6: Dependent Returns

CREATE TABLE IF NOT EXISTS sale_returns (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,2) NOT NULL,
  store_id VARCHAR(50) NOT NULL DEFAULT 'amora-main',
  transaction_key VARCHAR(120) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
