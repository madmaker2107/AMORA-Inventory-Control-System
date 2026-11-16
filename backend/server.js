import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { cert, getApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });
const dataDir = path.join(__dirname, 'data');
const dbPath = process.env.DATABASE_PATH ? path.resolve(rootDir, process.env.DATABASE_PATH) : path.join(dataDir, 'amora.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const PORT = Number(process.env.PORT || 4016);
const JWT_SECRET = process.env.JWT_SECRET || 'amora-local-secret-change-me';
const app = express();
const publicFirebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.FIREBASE_APP_ID || ''
};
let adminAuth = null;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) : null;
  if (serviceAccount || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const adminApp = getApps()[0] || initializeAdminApp(serviceAccount ? { credential: cert(serviceAccount) } : undefined);
    adminAuth = getAdminAuth(adminApp);
  }
} catch (error) {
  console.warn('Firebase Admin verification is disabled:', error.message);
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.gstatic.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
      connectSrc: ["'self'", "https://*.firebaseio.com", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://firestore.googleapis.com", "http://localhost:4016", "http://127.0.0.1:4016"]
    }
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : ['http://localhost:4016', 'http://127.0.0.1:4016', 'http://localhost:4000', 'http://127.0.0.1:4000'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error('Blocked by CORS policy'));
  },
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
}));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 60 }));

const schema = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'cashier', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, barcode TEXT UNIQUE, name TEXT NOT NULL, category_id INTEGER REFERENCES categories(id), brand TEXT, unit TEXT NOT NULL DEFAULT 'piece', purchase_price REAL NOT NULL DEFAULT 0, selling_price REAL NOT NULL DEFAULT 0, mrp REAL NOT NULL DEFAULT 0, gst_rate REAL NOT NULL DEFAULT 5, min_stock REAL NOT NULL DEFAULT 10, max_stock REAL NOT NULL DEFAULT 500, perishable INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, gstin TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS supplier_products (id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), product_id INTEGER NOT NULL REFERENCES products(id), store_id TEXT NOT NULL DEFAULT 'amora-main', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(supplier_id,product_id));
CREATE TABLE IF NOT EXISTS inventory_batches (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), supplier_id INTEGER REFERENCES suppliers(id), batch_number TEXT NOT NULL, manufacturing_date TEXT, expiry_date TEXT, received_quantity REAL NOT NULL DEFAULT 0, remaining_quantity REAL NOT NULL DEFAULT 0, purchase_price REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'available', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS stock_movements (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), batch_id INTEGER REFERENCES inventory_batches(id), type TEXT NOT NULL, quantity REAL NOT NULL, reference_id TEXT, reason TEXT, performed_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY, order_number TEXT UNIQUE NOT NULL, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), status TEXT NOT NULL DEFAULT 'draft', payment_status TEXT NOT NULL DEFAULT 'unpaid', total REAL NOT NULL DEFAULT 0, order_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expected_date TEXT);
CREATE TABLE IF NOT EXISTS purchase_items (id INTEGER PRIMARY KEY, purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id), product_id INTEGER NOT NULL REFERENCES products(id), quantity REAL NOT NULL, unit_price REAL NOT NULL, gst_rate REAL NOT NULL DEFAULT 5, received_quantity REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, loyalty_points INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY, invoice_number TEXT UNIQUE NOT NULL, customer_id INTEGER REFERENCES customers(id), subtotal REAL NOT NULL, tax REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', cashier_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sale_items (id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), product_id INTEGER NOT NULL REFERENCES products(id), batch_id INTEGER NOT NULL REFERENCES inventory_batches(id), quantity REAL NOT NULL, unit_price REAL NOT NULL, gst_rate REAL NOT NULL DEFAULT 5, line_total REAL NOT NULL);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, sale_id INTEGER REFERENCES sales(id), purchase_order_id INTEGER REFERENCES purchase_orders(id), method TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'paid', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sale_returns (id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), sale_item_id INTEGER NOT NULL REFERENCES sale_items(id), quantity REAL NOT NULL, store_id TEXT NOT NULL DEFAULT 'amora-main', transaction_key TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sale_reversals (id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), store_id TEXT NOT NULL DEFAULT 'amora-main', transaction_key TEXT UNIQUE NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS brands (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS login_history (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), ip_address TEXT, success INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by INTEGER REFERENCES users(id));
`;
db.exec(schema);
function ensureColumn(table, column, definition) { const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name); if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
ensureColumn('products', 'description', 'TEXT NOT NULL DEFAULT \'\'');
ensureColumn('products', 'subcategory', 'TEXT NOT NULL DEFAULT \'\'');
ensureColumn('products', 'image_url', 'TEXT NOT NULL DEFAULT \'\'');
ensureColumn('products', 'store_id', "TEXT NOT NULL DEFAULT 'amora-main'");
ensureColumn('suppliers', 'supplier_code', "TEXT NOT NULL DEFAULT ''");
ensureColumn('suppliers', 'contact_person', "TEXT NOT NULL DEFAULT ''");
ensureColumn('suppliers', 'store_id', "TEXT NOT NULL DEFAULT 'amora-main'");
ensureColumn('purchase_orders', 'store_id', "TEXT NOT NULL DEFAULT 'amora-main'");
ensureColumn('purchase_orders', 'subtotal', 'REAL NOT NULL DEFAULT 0');
ensureColumn('purchase_orders', 'tax', 'REAL NOT NULL DEFAULT 0');
ensureColumn('purchase_orders', 'discount', 'REAL NOT NULL DEFAULT 0');
ensureColumn('purchase_orders', 'transaction_key', 'TEXT');
ensureColumn('sales', 'store_id', "TEXT NOT NULL DEFAULT 'amora-main'");
ensureColumn('sales', 'payment_status', "TEXT NOT NULL DEFAULT 'paid'");
ensureColumn('sales', 'transaction_key', 'TEXT');
ensureColumn('payments', 'store_id', "TEXT NOT NULL DEFAULT 'amora-main'");
ensureColumn('notifications', 'store_id', "TEXT NOT NULL DEFAULT 'amora-main'");
ensureColumn('notifications', 'alert_key', "TEXT NOT NULL DEFAULT ''");
ensureColumn('notifications', 'severity', "TEXT NOT NULL DEFAULT 'warning'");
ensureColumn('notifications', 'dismissed', 'INTEGER NOT NULL DEFAULT 0');
db.prepare("UPDATE notifications SET alert_key='legacy:' || id WHERE alert_key='' OR alert_key IS NULL").run();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_store_alert ON notifications(store_id,alert_key)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_transaction_key ON purchase_orders(transaction_key) WHERE transaction_key IS NOT NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_transaction_key ON sales(transaction_key) WHERE transaction_key IS NOT NULL');
db.prepare("UPDATE suppliers SET supplier_code='SUP-' || printf('%04d', id) WHERE supplier_code='' OR supplier_code IS NULL").run();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_store_code ON suppliers(store_id,supplier_code)');
ensureColumn('stock_movements', 'store_id', "TEXT NOT NULL DEFAULT 'amora-main'");
ensureColumn('stock_movements', 'previous_quantity', 'REAL NOT NULL DEFAULT 0');
ensureColumn('stock_movements', 'updated_quantity', 'REAL NOT NULL DEFAULT 0');
ensureColumn('stock_movements', 'transaction_key', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_transaction_key ON stock_movements(transaction_key) WHERE transaction_key IS NOT NULL');

const seed = db.transaction(() => {
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) return;
  const password = bcrypt.hashSync('amora123', 10);
  db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)').run('Anika Kapoor', 'admin@amora.local', password, 'admin');
  db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)').run('Arjun Mehta', 'cashier@amora.local', bcrypt.hashSync('cashier123', 10), 'cashier');
  const category = db.prepare('INSERT INTO categories (name) VALUES (?)');
  ['Grocery & Staples', 'Dairy & Bakery', 'Fruits & Vegetables', 'Snacks & Chocolates', 'Beverages', 'Personal Care', 'Cleaning Supplies', 'Frozen Foods'].forEach((name) => category.run(name));
  const supplier = db.prepare('INSERT INTO suppliers (name,phone,email,gstin,supplier_code) VALUES (?,?,?,?,?)');
  const suppliers = ['Fresh Farms Co.', 'Metro Wholesale', 'Dairy Direct', 'Bright Home Supplies'];
  suppliers.forEach((name, index) => supplier.run(name, `98765000${index + 10}`, `${name.toLowerCase().replaceAll(' ', '.')}@local.test`, `27AMORA000${index}Z`, `SUP-${String(index + 1).padStart(4, '0')}`));
  const product = db.prepare('INSERT INTO products (sku,barcode,name,category_id,brand,unit,purchase_price,selling_price,mrp,gst_rate,min_stock,max_stock,perishable) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const products = [
    ['DAB-001', '890100000001', 'Amul Taaza Milk', 2, 'Amul', 'litre', 62, 68, 70, 5, 25, 300, 1],
    ['GRC-024', '890100000024', 'India Gate Basmati Rice', 1, 'India Gate', 'kg', 580, 645, 680, 5, 10, 100, 0],
    ['GRC-031', '890100000031', 'Fortune Sunflower Oil', 1, 'Fortune', 'litre', 128, 142, 150, 5, 10, 100, 0],
    ['SNC-118', '890100000118', "Lay's Magic Masala", 4, "Lay's", 'packet', 17, 20, 20, 12, 15, 150, 0],
    ['BEV-043', '890100000043', 'Tata Tea Gold', 5, 'Tata', 'packet', 255, 285, 300, 5, 10, 100, 0],
    ['CLN-055', '890100000055', 'Surf Excel Matic', 7, 'Surf Excel', 'packet', 365, 410, 430, 18, 12, 100, 0]
  ];
  products.forEach((item) => product.run(...item));
  const batch = db.prepare('INSERT INTO inventory_batches (product_id,supplier_id,batch_number,manufacturing_date,expiry_date,received_quantity,remaining_quantity,purchase_price) VALUES (?,?,?,?,?,?,?,?)');
  products.forEach((item, index) => { const quantity = [184, 42, 76, 12, 96, 0][index]; batch.run(index + 1, (index % 4) + 1, `AM-${440 + index}`, '2026-10-01', index === 0 ? '2026-11-17' : '2027-04-30', quantity, quantity, item[6]); if (quantity) db.prepare('INSERT INTO stock_movements (product_id,batch_id,store_id,type,quantity,previous_quantity,updated_quantity,reason) VALUES (?,?,?,?,?,?,?,?)').run(index + 1, index + 1, 'amora-main', 'OPENING_STOCK', quantity, 0, quantity, 'Seed opening stock'); });
  const customer = db.prepare('INSERT INTO customers (name,phone,loyalty_points) VALUES (?,?,?)');
  customer.run('Ravi Verma', '9876543210', 1240); customer.run('Meera Patel', '9876543211', 860); customer.run('Nisha Wadhwa', '9876543212', 420);
  const insertSeedNotif = db.prepare('INSERT INTO notifications (type,alert_key,title,message,severity,store_id) VALUES (?,?,?,?,?,?)');
  insertSeedNotif.run('LOW_STOCK', 'seed:low-stock', '8 products are low in stock', 'Restock items before they run out.', 'warning', 'amora-main');
  insertSeedNotif.run('EXPIRY', 'seed:expiry', '5 products expire this week', 'Review the expiry watch and apply FEFO.', 'warning', 'amora-main');
  insertSeedNotif.run('PURCHASE', 'seed:purchase', 'Purchase order #040 is pending', 'Confirm the expected delivery date.', 'info', 'amora-main');
  [['store_name', 'Greenfield Market'], ['currency', 'INR'], ['gstin', '27AAMCA1234K1Z5'], ['invoice_prefix', 'AM-']].forEach(([key, value]) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(key, value));
});
seed();
db.prepare("UPDATE suppliers SET supplier_code='SUP-' || printf('%04d', id) WHERE supplier_code='' OR supplier_code IS NULL").run();
db.prepare("INSERT OR IGNORE INTO brands (name) SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand <> ''").run();
db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('allow_negative_stock','false')").run();
db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('expiry_alert_days','7')").run();
db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('overstock_alert_factor','1')").run();
[['country', 'India'], ['currency_code', 'INR'], ['currency_symbol', '₹'], ['date_format', 'DD-MM-YYYY'], ['time_zone', 'Asia/Kolkata'], ['language', 'English'], ['tax_system', 'Indian GST'], ['gst_components', 'CGST,SGST,IGST'], ['store_state', 'West Bengal'], ['country_code', '+91']].forEach(([key, value]) => db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run(key, value));

async function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  if (adminAuth) {
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      req.user = {
        ...decoded,
        id: decoded.uid,
        uid: decoded.uid,
        name: decoded.name || decoded.email || decoded.uid,
        role: decoded.role || 'cashier',
        storeId: decoded.storeId || 'amora-main'
      };
      return next();
    } catch {
      if (process.env.ALLOW_LEGACY_AUTH === 'true') {
        try {
          req.user = jwt.verify(token, JWT_SECRET);
          return next();
        } catch {}
      }
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}
function role(...roles) { return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'This role cannot perform that action' }); }
function audit(userId, action, entity, entityId, details = '') { db.prepare('INSERT INTO audit_logs (user_id,action,entity,entity_id,details) VALUES (?,?,?,?,?)').run(userId, action, entity, String(entityId ?? ''), details); }
function nextInvoice() { const count = db.prepare("SELECT COUNT(*) AS count FROM sales WHERE date(created_at)=date('now')").get().count + 1; return `AM-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(count).padStart(3, '0')}`; }
function stockRows(storeId = '') { const filter = storeId ? 'WHERE p.store_id=?' : ''; return db.prepare(`SELECT p.*, c.name AS category, COALESCE(SUM(CASE WHEN b.expiry_date >= date('now') THEN b.remaining_quantity ELSE 0 END),0) AS available_quantity FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN inventory_batches b ON b.product_id=p.id AND b.status='available' ${filter} GROUP BY p.id ORDER BY p.name`).all(...(storeId ? [storeId] : [])); }
function productRows(storeId, { search = '', categoryId = '', status = '', sort = 'name', page = 1, pageSize = 10 } = {}) { const sortMap = { name: 'p.name COLLATE NOCASE', sku: 'p.sku COLLATE NOCASE', selling_price: 'p.selling_price', available_quantity: 'available_quantity' }; const conditions = ['p.store_id=?', 'p.active=1']; const params = [storeId]; if (search) { conditions.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)'); const term = `%${search}%`; params.push(term, term, term); } if (categoryId) { conditions.push('p.category_id=?'); params.push(Number(categoryId)); } const base = `FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN inventory_batches b ON b.product_id=p.id AND b.status='available' WHERE ${conditions.join(' AND ')} GROUP BY p.id`; const rows = db.prepare(`SELECT p.*, c.name AS category, COALESCE(SUM(CASE WHEN b.expiry_date >= date('now') THEN b.remaining_quantity ELSE 0 END),0) AS available_quantity ${base} ORDER BY ${sortMap[sort] || sortMap.name}`).all(...params); const filtered = status ? rows.filter((item) => status === 'out_of_stock' ? item.available_quantity <= 0 : status === 'low_stock' ? item.available_quantity > 0 && item.available_quantity <= item.min_stock : item.available_quantity > item.min_stock) : rows; const offset = (Math.max(1, Number(page)) - 1) * Math.max(1, Number(pageSize)); return { rows: filtered.slice(offset, offset + Math.max(1, Number(pageSize))), total: filtered.length, page: Math.max(1, Number(page)), pageSize: Math.max(1, Number(pageSize)) }; }
function storeFor(req) { return req.user.storeId || 'amora-main'; }
function recordMovement({ productId, batchId = null, type, quantity, previousQuantity, updatedQuantity, referenceId = '', reason = '', userId, storeId, transactionKey = null }) { const key = transactionKey && db.prepare('SELECT id FROM stock_movements WHERE transaction_key=?').get(transactionKey) ? `${transactionKey}-${productId}-${batchId ?? 'movement'}` : transactionKey; return db.prepare('INSERT INTO stock_movements (product_id,batch_id,store_id,type,quantity,previous_quantity,updated_quantity,reference_id,reason,performed_by,transaction_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(productId, batchId, storeId, type, quantity, previousQuantity, updatedQuantity, referenceId, reason, userId, key); }
function negativeStockAllowed(req) { return req.user.role === 'admin' && db.prepare("SELECT value FROM settings WHERE key='allow_negative_stock'").get()?.value === 'true'; }
function alertSetting(key, fallback) { const value = db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; return value === undefined ? fallback : Number(value); }
function syncAlerts(storeId) { const alerts = []; const products = stockRows(storeId); const expiryDays = alertSetting('expiry_alert_days', 7); const overstockFactor = alertSetting('overstock_alert_factor', 1); products.forEach((product) => { if (product.available_quantity <= 0) alerts.push(['OUT_OF_STOCK', `out:${product.id}`, `${product.name} is out of stock`, 'Restock this product before the next sale.', 'critical']); else if (product.available_quantity <= product.min_stock) alerts.push(['LOW_STOCK', `low:${product.id}`, `${product.name} is low in stock`, `${product.available_quantity} units remain against a minimum of ${product.min_stock}.`, 'warning']); if (product.available_quantity > product.max_stock * overstockFactor) alerts.push(['OVERSTOCK', `over:${product.id}`, `${product.name} is overstocked`, `${product.available_quantity} units exceed the maximum stock level of ${product.max_stock}.`, 'info']); }); db.prepare("SELECT p.id,p.name,b.batch_number,b.expiry_date FROM inventory_batches b JOIN products p ON p.id=b.product_id WHERE p.store_id=? AND b.status='available' AND b.remaining_quantity>0 AND b.expiry_date<=date('now',?)").all(storeId, `+${expiryDays} day`).forEach((batch) => alerts.push(['EXPIRY', `expiry:${batch.id}`, `${batch.name} is nearing expiry`, `Batch ${batch.batch_number} expires on ${batch.expiry_date}.`, 'warning'])); db.prepare("SELECT po.id,po.order_number,s.name FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id WHERE po.store_id=? AND po.status IN ('approved','partially_received')").all(storeId).forEach((order) => alerts.push(['PENDING_PURCHASE', `purchase:${order.id}`, `Purchase order ${order.order_number} is pending`, `${order.name} still requires receipt or completion.`, 'info'])); const keys = new Set(alerts.map((alert) => alert[1])); const remove = db.prepare('DELETE FROM notifications WHERE store_id=? AND alert_key NOT IN (' + (keys.size ? [...keys].map(() => '?').join(',') : "''") + ')'); remove.run(storeId, ...keys); const insert = db.prepare('INSERT INTO notifications (type,alert_key,title,message,severity,store_id) VALUES (?,?,?,?,?,?) ON CONFLICT(store_id,alert_key) DO UPDATE SET type=excluded.type,title=excluded.title,message=excluded.message,severity=excluded.severity'); const save = db.transaction(() => alerts.forEach((alert) => insert.run(alert[0], alert[1], alert[2], alert[3], alert[4], storeId))); save(); return alerts.length; }

app.post('/api/auth/login', (req, res) => {
  if (adminAuth && process.env.ALLOW_LEGACY_AUTH !== 'true') {
    return res.status(403).json({ error: 'Local password authentication is disabled. Please sign in with Firebase Authentication.' });
  }
  const parsed = z.object({ email: z.string().email(), password: z.string().min(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and password' });
  const user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(parsed.data.email);
  if (!user || !bcrypt.compareSync(parsed.data.password, user.password_hash)) {
    if (user) db.prepare('INSERT INTO login_history (user_id,ip_address,success) VALUES (?,?,0)').run(user.id, req.ip);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  db.prepare('INSERT INTO login_history (user_id,ip_address,success) VALUES (?,?,1)').run(user.id, req.ip);
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role, email: user.email, storeId: 'amora-main' }, JWT_SECRET, { expiresIn: '8h' });
  audit(user.id, 'LOGIN', 'user', user.id);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email } });
});
app.get('/api/firebase-config', (_req, res) => res.json(publicFirebaseConfig));
app.post('/api/auth/change-password', auth, (req, res) => { const parsed = z.object({ current_password: z.string().min(6), new_password: z.string().min(6) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Passwords must contain at least 6 characters' }); const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id); if (!bcrypt.compareSync(parsed.data.current_password, user.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' }); db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(parsed.data.new_password, 10), req.user.id); audit(req.user.id, 'PASSWORD_CHANGE', 'user', req.user.id); res.json({ ok: true }); });
app.get('/api/auth/login-history', auth, role('admin', 'manager'), (_req, res) => res.json(db.prepare('SELECT l.*,u.name,u.email FROM login_history l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 100').all()));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'AMORA API', database: 'sqlite' }));
app.get('/api/dashboard', auth, (req, res) => { const storeId = storeFor(req); syncAlerts(storeId); const products = stockRows(storeId); const sales = db.prepare("SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS bills FROM sales WHERE store_id=? AND date(created_at)=date('now') AND status='completed'").get(storeId); const purchases = db.prepare("SELECT COALESCE(SUM(total),0) AS value FROM purchase_orders WHERE store_id=? AND date(order_date)>=date('now','-30 day')").get(storeId); const lowStock = products.filter((p) => p.available_quantity > 0 && p.available_quantity <= p.min_stock); const outOfStock = products.filter((p) => p.available_quantity <= 0); const expiring = db.prepare("SELECT p.name,b.batch_number,b.expiry_date,b.remaining_quantity FROM inventory_batches b JOIN products p ON p.id=b.product_id WHERE p.store_id=? AND b.remaining_quantity>0 AND b.expiry_date<=date('now','+7 day') ORDER BY b.expiry_date").all(storeId); const unread = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE store_id=? AND read=0').get(storeId).count; res.json({ metrics: { revenue: sales.revenue, bills: sales.bills, products: products.length, stock: products.reduce((sum, p) => sum + p.available_quantity, 0), purchases: purchases.value, notifications: unread }, lowStock, outOfStock, expiring, recentSales: db.prepare('SELECT invoice_number,total,payment_method,created_at FROM sales WHERE store_id=? ORDER BY id DESC LIMIT 8').all(storeId) }); });
app.get('/api/products', auth, (req, res) => { const result = productRows(storeFor(req), req.query); res.json(result); });
app.get('/api/products/:id', auth, (req, res) => { const result = db.prepare(`SELECT p.*,c.name AS category,COALESCE(SUM(CASE WHEN b.expiry_date>=date('now') THEN b.remaining_quantity ELSE 0 END),0) AS available_quantity FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN inventory_batches b ON b.product_id=p.id AND b.status='available' WHERE p.id=? AND p.store_id=? AND p.active=1 GROUP BY p.id`).get(req.params.id, storeFor(req)); if (!result) return res.status(404).json({ error: 'Product not found' }); res.json(result); });
app.get('/api/categories', auth, (req, res) => {
  const storeId = storeFor(req);
  res.json(db.prepare('SELECT c.*,COUNT(p.id) AS product_count FROM categories c LEFT JOIN products p ON p.category_id=c.id AND p.store_id=? AND p.active=1 GROUP BY c.id ORDER BY c.name').all(storeId));
});
app.post('/api/categories', auth, role('admin', 'manager'), (req, res) => { const parsed = z.object({ name: z.string().min(2) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Category name is required' }); const result = db.prepare('INSERT INTO categories (name) VALUES (?)').run(parsed.data.name); audit(req.user.id, 'CREATE', 'category', result.lastInsertRowid, parsed.data.name); res.status(201).json({ id: result.lastInsertRowid }); });
app.get('/api/brands', auth, (_req, res) => res.json(db.prepare('SELECT b.*,COUNT(p.id) AS product_count FROM brands b LEFT JOIN products p ON p.brand=b.name GROUP BY b.id ORDER BY b.name').all()));
app.post('/api/brands', auth, role('admin', 'manager'), (req, res) => { const parsed = z.object({ name: z.string().min(2) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Brand name is required' }); const result = db.prepare('INSERT INTO brands (name) VALUES (?)').run(parsed.data.name); audit(req.user.id, 'CREATE', 'brand', result.lastInsertRowid, parsed.data.name); res.status(201).json({ id: result.lastInsertRowid }); });
const productInput = z.object({ sku: z.string().trim().min(2).max(40), barcode: z.string().trim().min(3).max(80).optional().or(z.literal('')), name: z.string().trim().min(2).max(120), description: z.string().trim().max(1000).default(''), category_id: z.number().int().positive(), subcategory: z.string().trim().max(80).default(''), brand: z.string().trim().max(80).default(''), unit: z.string().trim().min(1).max(30).default('piece'), selling_price: z.number().nonnegative(), purchase_price: z.number().nonnegative(), gst_rate: z.number().min(0).max(28).default(5), min_stock: z.number().int().nonnegative().default(10), current_stock: z.number().nonnegative().default(0), image_url: z.string().url().max(500).optional().or(z.literal('')) });
app.post('/api/products', auth, role('admin', 'manager', 'stock_manager'), (req, res) => {
  const parsed = productInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Product fields are invalid or incomplete' });
  const value = parsed.data;
  if (!db.prepare('SELECT id FROM categories WHERE id=?').get(value.category_id)) return res.status(400).json({ error: 'Selected category does not exist' });
  try {
    const storeId = storeFor(req);
    const result = db.transaction(() => {
      const insert = db.prepare('INSERT INTO products (sku,barcode,name,description,category_id,subcategory,brand,unit,purchase_price,selling_price,mrp,gst_rate,min_stock,image_url,store_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.sku, value.barcode || null, value.name, value.description, value.category_id, value.subcategory, value.brand, value.unit, value.purchase_price, value.selling_price, value.selling_price, value.gst_rate, value.min_stock, value.image_url || '', storeId);
      if (value.current_stock > 0) {
        const batch = db.prepare('INSERT INTO inventory_batches (product_id,batch_number,expiry_date,received_quantity,remaining_quantity,purchase_price) VALUES (?,?,?,?,?,?)').run(insert.lastInsertRowid, `OPENING-${value.sku}`, '2099-12-31', value.current_stock, value.current_stock, value.purchase_price);
        recordMovement({
          productId: insert.lastInsertRowid,
          batchId: batch.lastInsertRowid,
          storeId,
          type: 'OPENING_STOCK',
          quantity: value.current_stock,
          previousQuantity: 0,
          updatedQuantity: value.current_stock,
          reason: 'Opening stock',
          userId: req.user.id
        });
      }
      audit(req.user.id, 'CREATE', 'product', insert.lastInsertRowid, value.name);
      return insert;
    })();
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    res.status(409).json({ error: error.message.includes('UNIQUE') ? 'SKU or barcode already exists' : 'Unable to create product' });
  }
});
app.patch('/api/products/:id', auth, role('admin', 'manager', 'stock_manager'), (req, res) => { const parsed = productInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Product fields are invalid or incomplete' }); const existing = db.prepare('SELECT id FROM products WHERE id=? AND store_id=? AND active=1').get(req.params.id, storeFor(req)); if (!existing) return res.status(404).json({ error: 'Product not found' }); const value = parsed.data; try { db.prepare('UPDATE products SET sku=?,barcode=?,name=?,description=?,category_id=?,subcategory=?,brand=?,unit=?,purchase_price=?,selling_price=?,mrp=?,gst_rate=?,min_stock=?,image_url=? WHERE id=? AND store_id=?').run(value.sku, value.barcode || null, value.name, value.description, value.category_id, value.subcategory, value.brand, value.unit, value.purchase_price, value.selling_price, value.selling_price, value.gst_rate, value.min_stock, value.image_url || '', req.params.id, storeFor(req)); audit(req.user.id, 'UPDATE', 'product', req.params.id, value.name); res.json({ ok: true }); } catch (error) { res.status(409).json({ error: error.message.includes('UNIQUE') ? 'SKU or barcode already exists' : 'Unable to update product' }); } });
app.delete('/api/products/:id', auth, role('admin', 'manager'), (req, res) => { const existing = db.prepare('SELECT id,name FROM products WHERE id=? AND store_id=? AND active=1').get(req.params.id, storeFor(req)); if (!existing) return res.status(404).json({ error: 'Product not found' }); const linked = db.prepare('SELECT (SELECT COUNT(*) FROM sale_items WHERE product_id=?) + (SELECT COUNT(*) FROM purchase_items WHERE product_id=?) AS count').get(req.params.id, req.params.id); if (linked.count) return res.status(409).json({ error: 'Product has transaction history and cannot be deleted' }); db.prepare('UPDATE products SET active=0 WHERE id=? AND store_id=?').run(req.params.id, storeFor(req)); audit(req.user.id, 'DELETE', 'product', req.params.id, existing.name); res.json({ ok: true }); });
app.get('/api/inventory', auth, (req, res) => res.json({ products: stockRows(storeFor(req)), movements: db.prepare('SELECT sm.*,p.name,u.name AS performed_by FROM stock_movements sm JOIN products p ON p.id=sm.product_id LEFT JOIN users u ON u.id=sm.performed_by WHERE sm.store_id=? ORDER BY sm.id DESC LIMIT 100').all(storeFor(req)) }));
app.post('/api/inventory/stock-in', auth, role('admin', 'manager', 'inventory', 'stock_manager'), (req, res) => { const parsed = z.object({ product_id: z.number().int().positive(), quantity: z.number().positive(), batch_number: z.string().trim().min(1).max(80), expiry_date: z.string().optional(), purchase_price: z.number().nonnegative().default(0), reason: z.string().trim().min(3), transaction_key: z.string().trim().min(8).max(120) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Product, positive quantity, batch, reason and transaction key are required' }); try { const result = db.transaction(() => { if (db.prepare('SELECT id FROM stock_movements WHERE transaction_key=?').get(parsed.data.transaction_key)) throw new Error('Duplicate stock transaction'); const product = db.prepare('SELECT id FROM products WHERE id=? AND store_id=? AND active=1').get(parsed.data.product_id, storeFor(req)); if (!product) throw new Error('Product not found'); const previous = db.prepare("SELECT COALESCE(SUM(CASE WHEN expiry_date>=date('now') THEN remaining_quantity ELSE 0 END),0) AS stock FROM inventory_batches WHERE product_id=? AND status='available'").get(product.id).stock; const batch = db.prepare('INSERT INTO inventory_batches (product_id,batch_number,expiry_date,received_quantity,remaining_quantity,purchase_price) VALUES (?,?,?,?,?,?)').run(product.id, parsed.data.batch_number, parsed.data.expiry_date || '2099-12-31', parsed.data.quantity, parsed.data.quantity, parsed.data.purchase_price); const movement = recordMovement({ productId: product.id, batchId: batch.lastInsertRowid, storeId: storeFor(req), type: 'STOCK_IN', quantity: parsed.data.quantity, previousQuantity: previous, updatedQuantity: previous + parsed.data.quantity, reason: parsed.data.reason, userId: req.user.id, transactionKey: parsed.data.transaction_key }); audit(req.user.id, 'STOCK_IN', 'inventory', product.id, parsed.data.reason); return { id: movement.lastInsertRowid, previous_stock: previous, updated_stock: previous + parsed.data.quantity }; })(); res.status(201).json(result); } catch (error) { res.status(error.message === 'Duplicate stock transaction' ? 409 : 400).json({ error: error.message }); } });
app.post('/api/inventory/stock-out', auth, role('admin', 'manager', 'inventory', 'stock_manager'), (req, res) => { const parsed = z.object({ product_id: z.number().int().positive(), quantity: z.number().positive(), type: z.enum(['STOCK_OUT', 'DAMAGE_OUT', 'TRANSFER_OUT']), reason: z.string().trim().min(3), transaction_key: z.string().trim().min(8).max(120) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Product, positive quantity, type, reason and transaction key are required' }); try { const result = db.transaction(() => { if (db.prepare('SELECT id FROM stock_movements WHERE transaction_key=?').get(parsed.data.transaction_key)) throw new Error('Duplicate stock transaction'); const product = db.prepare('SELECT id FROM products WHERE id=? AND store_id=? AND active=1').get(parsed.data.product_id, storeFor(req)); if (!product) throw new Error('Product not found'); const batches = db.prepare("SELECT * FROM inventory_batches WHERE product_id=? AND status='available' AND remaining_quantity>0 AND expiry_date>=date('now') ORDER BY expiry_date,id").all(product.id); const previous = batches.reduce((sum, batch) => sum + batch.remaining_quantity, 0); if (parsed.data.quantity > previous && !negativeStockAllowed(req)) throw new Error('Transaction would create negative stock'); let remaining = parsed.data.quantity; let lastBatch = batches[0]; for (const batch of batches) { if (remaining <= 0) break; const quantity = Math.min(remaining, batch.remaining_quantity); db.prepare('UPDATE inventory_batches SET remaining_quantity=remaining_quantity-? WHERE id=?').run(quantity, batch.id); recordMovement({ productId: product.id, batchId: batch.id, storeId: storeFor(req), type: parsed.data.type, quantity, previousQuantity: previous - (parsed.data.quantity - remaining), updatedQuantity: previous - (parsed.data.quantity - remaining) - quantity, reason: parsed.data.reason, userId: req.user.id, transactionKey: remaining === parsed.data.quantity ? parsed.data.transaction_key : `${parsed.data.transaction_key}-${batch.id}` }); remaining -= quantity; lastBatch = batch; } if (remaining > 0) { if (!lastBatch) { lastBatch = db.prepare('INSERT INTO inventory_batches (product_id,batch_number,expiry_date,remaining_quantity) VALUES (?,?,?,0)').run(product.id, `NEGATIVE-${parsed.data.transaction_key}`, '2099-12-31'); } db.prepare('UPDATE inventory_batches SET remaining_quantity=remaining_quantity-? WHERE id=?').run(remaining, lastBatch.id || lastBatch.lastInsertRowid); recordMovement({ productId: product.id, batchId: lastBatch.id || lastBatch.lastInsertRowid, storeId: storeFor(req), type: parsed.data.type, quantity: remaining, previousQuantity: 0, updatedQuantity: -remaining, reason: parsed.data.reason, userId: req.user.id, transactionKey: `${parsed.data.transaction_key}-negative` }); } audit(req.user.id, parsed.data.type, 'inventory', product.id, parsed.data.reason); return { previous_stock: previous, updated_stock: previous - parsed.data.quantity }; })(); res.status(201).json(result); } catch (error) { res.status(error.message === 'Duplicate stock transaction' ? 409 : 400).json({ error: error.message }); } });
app.post('/api/inventory/transfer', auth, role('admin', 'manager', 'inventory', 'stock_manager'), (req, res) => { const parsed = z.object({ product_id: z.number().int().positive(), destination_product_id: z.number().int().positive().optional(), destination_store_id: z.string().trim().min(2).optional(), quantity: z.number().positive(), reason: z.string().trim().min(3), transaction_key: z.string().trim().min(8).max(120) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Products, quantity, reason and transaction key are required' }); try { const result = db.transaction(() => { if (db.prepare('SELECT id FROM stock_movements WHERE transaction_key=?').get(parsed.data.transaction_key)) throw new Error('Duplicate stock transaction'); const sourceStore = storeFor(req); const destinationStore = parsed.data.destination_store_id || sourceStore; const source = db.prepare('SELECT id FROM products WHERE id=? AND store_id=? AND active=1').get(parsed.data.product_id, sourceStore); const destination = db.prepare('SELECT id,sku,purchase_price FROM products WHERE id=? AND store_id=? AND active=1').get(parsed.data.destination_product_id || parsed.data.product_id, destinationStore); if (!source || !destination) throw new Error('Source or destination product not found'); const batch = db.prepare("SELECT * FROM inventory_batches WHERE product_id=? AND status='available' AND remaining_quantity>0 AND expiry_date>=date('now') ORDER BY expiry_date,id LIMIT 1").get(source.id); const previous = db.prepare("SELECT COALESCE(SUM(CASE WHEN expiry_date>=date('now') THEN remaining_quantity ELSE 0 END),0) AS stock FROM inventory_batches WHERE product_id=? AND status='available'").get(source.id).stock; if (!batch || parsed.data.quantity > previous) throw new Error('Transfer would create negative stock'); db.prepare('UPDATE inventory_batches SET remaining_quantity=remaining_quantity-? WHERE id=?').run(parsed.data.quantity, batch.id); recordMovement({ productId: source.id, batchId: batch.id, storeId: sourceStore, type: 'TRANSFER_OUT', quantity: parsed.data.quantity, previousQuantity: previous, updatedQuantity: previous - parsed.data.quantity, reason: parsed.data.reason, userId: req.user.id, transactionKey: parsed.data.transaction_key }); const destinationBatch = db.prepare('INSERT INTO inventory_batches (product_id,batch_number,expiry_date,received_quantity,remaining_quantity,purchase_price) VALUES (?,?,?,?,?,?)').run(destination.id, `TRANSFER-${parsed.data.transaction_key}`, '2099-12-31', parsed.data.quantity, parsed.data.quantity, destination.purchase_price); recordMovement({ productId: destination.id, batchId: destinationBatch.lastInsertRowid, storeId: destinationStore, type: 'TRANSFER_IN', quantity: parsed.data.quantity, previousQuantity: 0, updatedQuantity: parsed.data.quantity, referenceId: parsed.data.transaction_key, reason: parsed.data.reason, userId: req.user.id, transactionKey: `${parsed.data.transaction_key}-in` }); audit(req.user.id, 'TRANSFER', 'inventory', source.id, parsed.data.reason); return { previous_stock: previous, updated_stock: previous - parsed.data.quantity, destination_store_id: destinationStore }; })(); res.status(201).json(result); } catch (error) { res.status(error.message === 'Duplicate stock transaction' ? 409 : 400).json({ error: error.message }); } });
app.post('/api/inventory/adjust', auth, role('admin', 'manager', 'inventory', 'stock_manager'), (req, res) => { const parsed = z.object({ product_id: z.number().int().positive(), quantity: z.number().refine((value) => value !== 0), reason: z.string().trim().min(3), transaction_key: z.string().trim().min(8).max(120) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Product, non-zero quantity, reason and transaction key are required' }); try { const result = db.transaction(() => { if (db.prepare('SELECT id FROM stock_movements WHERE transaction_key=?').get(parsed.data.transaction_key)) throw new Error('Duplicate stock transaction'); const product = db.prepare('SELECT id,purchase_price FROM products WHERE id=? AND store_id=? AND active=1').get(parsed.data.product_id, storeFor(req)); if (!product) throw new Error('Product not found'); const previous = db.prepare("SELECT COALESCE(SUM(CASE WHEN expiry_date>=date('now') THEN remaining_quantity ELSE 0 END),0) AS stock FROM inventory_batches WHERE product_id=? AND status='available'").get(product.id).stock; const updated = previous + parsed.data.quantity; if (updated < 0 && !negativeStockAllowed(req)) throw new Error('Adjustment would create negative stock'); let batch = db.prepare("SELECT * FROM inventory_batches WHERE product_id=? AND status='available' ORDER BY expiry_date,id LIMIT 1").get(product.id); if (parsed.data.quantity > 0) { const created = db.prepare('INSERT INTO inventory_batches (product_id,batch_number,expiry_date,received_quantity,remaining_quantity,purchase_price) VALUES (?,?,?,?,?,?)').run(product.id, `ADJUST-${parsed.data.transaction_key}`, '2099-12-31', parsed.data.quantity, parsed.data.quantity, product.purchase_price); batch = { id: created.lastInsertRowid }; } else { if (!batch) throw new Error('No available batch for stock adjustment'); db.prepare('UPDATE inventory_batches SET remaining_quantity=remaining_quantity+? WHERE id=?').run(parsed.data.quantity, batch.id); } const movement = recordMovement({ productId: product.id, batchId: batch.id, storeId: storeFor(req), type: 'MANUAL_ADJUSTMENT', quantity: Math.abs(parsed.data.quantity), previousQuantity: previous, updatedQuantity: updated, reason: parsed.data.reason, userId: req.user.id, transactionKey: parsed.data.transaction_key }); audit(req.user.id, 'ADJUST', 'inventory', product.id, parsed.data.reason); return { id: movement.lastInsertRowid, previous_stock: previous, updated_stock: updated }; })(); res.status(201).json(result); } catch (error) { res.status(error.message === 'Duplicate stock transaction' ? 409 : 400).json({ error: error.message }); } });
const supplierInput = z.object({ supplier_code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9-]+$/), name: z.string().trim().min(2).max(120), contact_person: z.string().trim().max(120).default(''), phone: z.string().trim().min(7).max(25), email: z.string().trim().email(), address: z.string().trim().max(300).default(''), gstin: z.string().trim().max(20).default('') });
function supplierList(req) { const search = String(req.query.search || '').trim(); const status = req.query.status === 'archived' ? 0 : req.query.status === 'all' ? null : 1; const sortMap = { name: 's.name COLLATE NOCASE', code: 's.supplier_code COLLATE NOCASE', payable: 'outstanding_payable DESC', purchases: 'purchase_value DESC' }; const conditions = ['s.store_id=?']; const params = [storeFor(req)]; if (status !== null) { conditions.push('s.active=?'); params.push(status); } if (search) { conditions.push('(s.name LIKE ? OR s.supplier_code LIKE ? OR s.contact_person LIKE ? OR s.phone LIKE ? OR s.email LIKE ?)'); const term = `%${search}%`; params.push(term, term, term, term, term); } return db.prepare(`SELECT s.*,COUNT(DISTINCT po.id) AS purchase_count,COALESCE(SUM(DISTINCT po.total),0) AS purchase_value,COALESCE(SUM(DISTINCT CASE WHEN po.payment_status<>'paid' THEN po.total ELSE 0 END),0) AS outstanding_payable,COUNT(DISTINCT sp.product_id) AS mapped_products FROM suppliers s LEFT JOIN purchase_orders po ON po.supplier_id=s.id LEFT JOIN supplier_products sp ON sp.supplier_id=s.id AND sp.active=1 WHERE ${conditions.join(' AND ')} GROUP BY s.id ORDER BY ${sortMap[req.query.sort] || sortMap.name}`).all(...params); }
app.get('/api/suppliers', auth, (req, res) => { try { res.json(supplierList(req)); } catch (error) { res.status(500).json({ error: 'Unable to load suppliers' }); } });
app.get('/api/suppliers/:id', auth, (req, res) => { const supplier = db.prepare('SELECT s.*,COUNT(DISTINCT po.id) AS purchase_count,COALESCE(SUM(DISTINCT po.total),0) AS purchase_value,COALESCE(SUM(DISTINCT CASE WHEN po.payment_status<>\'paid\' THEN po.total ELSE 0 END),0) AS outstanding_payable FROM suppliers s LEFT JOIN purchase_orders po ON po.supplier_id=s.id WHERE s.id=? AND s.store_id=? GROUP BY s.id').get(req.params.id, storeFor(req)); if (!supplier) return res.status(404).json({ error: 'Supplier not found' }); const products = db.prepare('SELECT p.id,p.name,p.sku,p.unit FROM supplier_products sp JOIN products p ON p.id=sp.product_id WHERE sp.supplier_id=? AND sp.store_id=? AND sp.active=1 ORDER BY p.name').all(req.params.id, storeFor(req)); const purchases = db.prepare('SELECT po.id,po.order_number,po.status,po.payment_status,po.total,po.order_date,po.expected_date FROM purchase_orders po WHERE po.supplier_id=? ORDER BY po.id DESC').all(req.params.id); res.json({ ...supplier, products, purchases }); });
app.post('/api/suppliers', auth, role('admin', 'manager'), (req, res) => { const parsed = supplierInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Supplier code, name, phone and email are required' }); const value = parsed.data; if (db.prepare('SELECT id FROM suppliers WHERE store_id=? AND (lower(supplier_code)=lower(?) OR lower(name)=lower(?))').get(storeFor(req), value.supplier_code, value.name)) return res.status(409).json({ error: 'Supplier code or name already exists' }); try { const result = db.prepare('INSERT INTO suppliers (supplier_code,name,contact_person,phone,email,address,gstin,store_id) VALUES (?,?,?,?,?,?,?,?)').run(value.supplier_code, value.name, value.contact_person, value.phone, value.email, value.address, value.gstin, storeFor(req)); audit(req.user.id, 'CREATE', 'supplier', result.lastInsertRowid, value.name); res.status(201).json({ id: result.lastInsertRowid }); } catch (error) { res.status(409).json({ error: error.message.includes('UNIQUE') ? 'Supplier code or name already exists' : 'Unable to create supplier' }); } });
app.patch('/api/suppliers/:id', auth, role('admin', 'manager'), (req, res) => { const parsed = supplierInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Supplier code, name, phone and email are required' }); const existing = db.prepare('SELECT id FROM suppliers WHERE id=? AND store_id=?').get(req.params.id, storeFor(req)); if (!existing) return res.status(404).json({ error: 'Supplier not found' }); const value = parsed.data; if (db.prepare('SELECT id FROM suppliers WHERE store_id=? AND id<>? AND (lower(supplier_code)=lower(?) OR lower(name)=lower(?))').get(storeFor(req), req.params.id, value.supplier_code, value.name)) return res.status(409).json({ error: 'Supplier code or name already exists' }); try { db.prepare('UPDATE suppliers SET supplier_code=?,name=?,contact_person=?,phone=?,email=?,address=?,gstin=? WHERE id=? AND store_id=?').run(value.supplier_code, value.name, value.contact_person, value.phone, value.email, value.address, value.gstin, req.params.id, storeFor(req)); audit(req.user.id, 'UPDATE', 'supplier', req.params.id, value.name); res.json({ ok: true }); } catch (error) { res.status(409).json({ error: 'Unable to update supplier' }); } });
app.delete('/api/suppliers/:id', auth, role('admin', 'manager'), (req, res) => { const supplier = db.prepare('SELECT id,name FROM suppliers WHERE id=? AND store_id=? AND active=1').get(req.params.id, storeFor(req)); if (!supplier) return res.status(404).json({ error: 'Supplier not found' }); db.prepare('UPDATE suppliers SET active=0 WHERE id=? AND store_id=?').run(req.params.id, storeFor(req)); audit(req.user.id, 'ARCHIVE', 'supplier', req.params.id, supplier.name); res.json({ ok: true }); });
app.post('/api/suppliers/:id/products', auth, role('admin', 'manager'), (req, res) => { const parsed = z.object({ product_id: z.number().int().positive() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'A valid product is required' }); const supplier = db.prepare('SELECT id FROM suppliers WHERE id=? AND store_id=? AND active=1').get(req.params.id, storeFor(req)); const product = db.prepare('SELECT id FROM products WHERE id=? AND store_id=? AND active=1').get(parsed.data.product_id, storeFor(req)); if (!supplier || !product) return res.status(404).json({ error: 'Supplier or product not found' }); try { const result = db.prepare('INSERT INTO supplier_products (supplier_id,product_id,store_id) VALUES (?,?,?)').run(supplier.id, product.id, storeFor(req)); audit(req.user.id, 'MAP', 'supplier_product', result.lastInsertRowid, `${supplier.id}:${product.id}`); res.status(201).json({ id: result.lastInsertRowid }); } catch (error) { res.status(409).json({ error: 'Product is already mapped to this supplier' }); } });
const purchaseInput = z.object({ supplier_id: z.number().int().positive(), expected_date: z.string().optional(), discount: z.number().nonnegative().default(0), transaction_key: z.string().trim().min(8).max(120), items: z.array(z.object({ product_id: z.number().int().positive(), quantity: z.number().positive(), unit_price: z.number().nonnegative(), gst_rate: z.number().min(0).max(28).default(5) })).min(1) });
app.get('/api/purchases', auth, (req, res) => res.json(db.prepare('SELECT po.*,s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id WHERE po.store_id=? ORDER BY po.id DESC').all(storeFor(req))));
app.get('/api/purchases/:id', auth, (req, res) => { const order = db.prepare('SELECT po.*,s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id WHERE po.id=? AND po.store_id=?').get(req.params.id, storeFor(req)); if (!order) return res.status(404).json({ error: 'Purchase order not found' }); const items = db.prepare('SELECT pi.*,p.name,p.sku FROM purchase_items pi JOIN products p ON p.id=pi.product_id WHERE pi.purchase_order_id=?').all(order.id); res.json({ ...order, items }); });
app.post('/api/purchases', auth, role('admin', 'manager', 'inventory'), (req, res) => { const parsed = purchaseInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Supplier, transaction key and purchase items are required' }); try { const result = db.transaction(() => { const value = parsed.data; if (db.prepare('SELECT id FROM purchase_orders WHERE transaction_key=?').get(value.transaction_key)) throw new Error('Duplicate purchase submission'); const supplier = db.prepare('SELECT id FROM suppliers WHERE id=? AND store_id=? AND active=1').get(value.supplier_id, storeFor(req)); if (!supplier) throw new Error('Supplier not found'); for (const item of value.items) if (!db.prepare('SELECT id FROM products WHERE id=? AND store_id=? AND active=1').get(item.product_id, storeFor(req))) throw new Error('Product not found'); const subtotal = value.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0); const tax = value.items.reduce((sum, item) => sum + item.quantity * item.unit_price * item.gst_rate / 100, 0); const total = Math.max(0, subtotal + tax - value.discount); const orderNumber = `PO-${new Date().getFullYear()}-${String(db.prepare('SELECT COUNT(*) AS count FROM purchase_orders').get().count + 1).padStart(4, '0')}`; const order = db.prepare('INSERT INTO purchase_orders (order_number,supplier_id,status,payment_status,subtotal,tax,discount,total,expected_date,store_id,transaction_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(orderNumber, supplier.id, 'approved', 'unpaid', subtotal, tax, value.discount, total, value.expected_date || null, storeFor(req), value.transaction_key); const itemInsert = db.prepare('INSERT INTO purchase_items (purchase_order_id,product_id,quantity,unit_price,gst_rate) VALUES (?,?,?,?,?)'); value.items.forEach((item) => itemInsert.run(order.lastInsertRowid, item.product_id, item.quantity, item.unit_price, item.gst_rate)); audit(req.user.id, 'CREATE', 'purchase_order', order.lastInsertRowid, orderNumber); return { id: order.lastInsertRowid, order_number: orderNumber, subtotal, tax, discount: value.discount, total }; })(); res.status(201).json(result); } catch (error) { res.status(error.message === 'Duplicate purchase submission' ? 409 : 400).json({ error: error.message }); } });
app.post('/api/purchases/:id/receive', auth, role('admin', 'manager', 'inventory'), (req, res) => { const parsed = z.object({ transaction_key: z.string().trim().min(8).max(120), items: z.array(z.object({ product_id: z.number().int().positive(), received_quantity: z.number().positive(), batch_number: z.string().trim().min(1), manufacturing_date: z.string().optional(), expiry_date: z.string().optional(), purchase_price: z.number().nonnegative() })).min(1) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Receipt transaction key and batch details are required' }); try { const result = db.transaction(() => { if (db.prepare('SELECT id FROM stock_movements WHERE transaction_key=?').get(parsed.data.transaction_key)) throw new Error('Duplicate receipt submission'); const order = db.prepare('SELECT * FROM purchase_orders WHERE id=? AND store_id=?').get(req.params.id, storeFor(req)); if (!order) throw new Error('Purchase order not found'); if (order.status === 'cancelled' || order.status === 'received') throw new Error('Purchase order cannot be received again'); const itemLookup = db.prepare('SELECT * FROM purchase_items WHERE purchase_order_id=? AND product_id=?'); for (const item of parsed.data.items) { const ordered = itemLookup.get(order.id, item.product_id); if (!ordered || ordered.received_quantity + item.received_quantity > ordered.quantity) throw new Error('Received quantity exceeds ordered quantity'); const previous = db.prepare("SELECT COALESCE(SUM(CASE WHEN expiry_date>=date('now') THEN remaining_quantity ELSE 0 END),0) AS stock FROM inventory_batches WHERE product_id=? AND status='available'").get(item.product_id).stock; const batch = db.prepare('INSERT INTO inventory_batches (product_id,supplier_id,batch_number,manufacturing_date,expiry_date,received_quantity,remaining_quantity,purchase_price) VALUES (?,?,?,?,?,?,?,?)').run(item.product_id, order.supplier_id, item.batch_number, item.manufacturing_date || null, item.expiry_date || '2099-12-31', item.received_quantity, item.received_quantity, item.purchase_price); recordMovement({ productId: item.product_id, batchId: batch.lastInsertRowid, storeId: storeFor(req), type: 'PURCHASE_IN', quantity: item.received_quantity, previousQuantity: previous, updatedQuantity: previous + item.received_quantity, referenceId: order.order_number, reason: 'Purchase receipt', userId: req.user.id, transactionKey: parsed.data.transaction_key }); db.prepare('UPDATE purchase_items SET received_quantity=received_quantity+? WHERE purchase_order_id=? AND product_id=?').run(item.received_quantity, order.id, item.product_id); } const remaining = db.prepare('SELECT COUNT(*) AS count FROM purchase_items WHERE purchase_order_id=? AND received_quantity<quantity').get(order.id).count; db.prepare("UPDATE purchase_orders SET status=? WHERE id=?").run(remaining ? 'partially_received' : 'received', order.id); audit(req.user.id, 'RECEIVE', 'purchase_order', order.id, order.order_number); return { order_id: order.id, status: remaining ? 'partially_received' : 'received' }; })(); res.status(201).json(result); } catch (error) { res.status(error.message === 'Duplicate receipt submission' ? 409 : 400).json({ error: error.message }); } });
const saleInput = z.object({ customer_id: z.number().int().positive().nullable().optional(), payment_method: z.enum(['cash', 'upi', 'card', 'split']), payment_status: z.enum(['paid', 'pending', 'partial']).default('paid'), discount: z.number().nonnegative().default(0), transaction_key: z.string().trim().min(8).max(120).optional().default(() => `ui-sale-${Date.now()}-${Math.random().toString(36).slice(2)}`), items: z.array(z.object({ product_id: z.number().int().positive(), quantity: z.number().positive() })).min(1) });
app.post('/api/sales', auth, (req, res) => { const parsed = saleInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Payment, transaction key and sale items are required' }); try { const result = db.transaction(() => { const value = parsed.data; if (db.prepare('SELECT id FROM sales WHERE transaction_key=?').get(value.transaction_key)) throw new Error('Duplicate sale submission'); const lineItems = []; for (const item of value.items) { const product = db.prepare('SELECT * FROM products WHERE id=? AND store_id=? AND active=1').get(item.product_id, storeFor(req)); if (!product) throw new Error('Product not found'); const batches = db.prepare("SELECT * FROM inventory_batches WHERE product_id=? AND remaining_quantity>0 AND status='available' AND expiry_date>=date('now') ORDER BY expiry_date,id").all(product.id); let remaining = item.quantity; for (const batch of batches) { if (remaining <= 0) break; const quantity = Math.min(remaining, batch.remaining_quantity); lineItems.push({ product, batch, quantity }); remaining -= quantity; } if (remaining > 0) throw new Error(`${product.name} does not have enough unexpired stock`); } const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.product.selling_price, 0); const tax = lineItems.reduce((sum, item) => sum + item.quantity * item.product.selling_price * item.product.gst_rate / 100, 0); const total = Math.max(0, subtotal + tax - value.discount); const invoiceNumber = nextInvoice(); const sale = db.prepare('INSERT INTO sales (invoice_number,customer_id,subtotal,tax,discount,total,payment_method,payment_status,status,cashier_id,store_id,transaction_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(invoiceNumber, value.customer_id || null, subtotal, tax, value.discount, total, value.payment_method, value.payment_status, 'completed', req.user.id, storeFor(req), value.transaction_key); const saleItem = db.prepare('INSERT INTO sale_items (sale_id,product_id,batch_id,quantity,unit_price,gst_rate,line_total) VALUES (?,?,?,?,?,?,?)'); lineItems.forEach((item) => { saleItem.run(sale.lastInsertRowid, item.product.id, item.batch.id, item.quantity, item.product.selling_price, item.product.gst_rate, item.quantity * item.product.selling_price); const previous = item.batch.remaining_quantity; db.prepare('UPDATE inventory_batches SET remaining_quantity=remaining_quantity-? WHERE id=?').run(item.quantity, item.batch.id); recordMovement({ productId: item.product.id, batchId: item.batch.id, storeId: storeFor(req), type: 'SALE_OUT', quantity: item.quantity, previousQuantity: previous, updatedQuantity: previous - item.quantity, referenceId: invoiceNumber, reason: 'Sale', userId: req.user.id, transactionKey: `${value.transaction_key}-${item.product.id}-${item.batch.id}` }); }); db.prepare('INSERT INTO payments (sale_id,method,amount,status,store_id) VALUES (?,?,?,?,?)').run(sale.lastInsertRowid, value.payment_method, total, value.payment_status, storeFor(req)); audit(req.user.id, 'CREATE', 'sale', sale.lastInsertRowid, `Invoice ${invoiceNumber}`); return { id: sale.lastInsertRowid, invoice_number: invoiceNumber, subtotal, tax, discount: value.discount, total, payment_status: value.payment_status }; })(); res.status(201).json(result); } catch (error) { res.status(error.message === 'Duplicate sale submission' ? 409 : 409).json({ error: error.message }); } });
app.get('/api/sales', auth, (req, res) => res.json(db.prepare('SELECT s.*,c.name AS customer_name,u.name AS cashier_name FROM sales s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN users u ON u.id=s.cashier_id WHERE s.store_id=? ORDER BY s.id DESC LIMIT 100').all(storeFor(req))));
app.get('/api/sales/:id', auth, (req, res) => { const sale = db.prepare('SELECT s.*,c.name AS customer_name,u.name AS cashier_name FROM sales s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN users u ON u.id=s.cashier_id WHERE s.id=? AND s.store_id=?').get(req.params.id, storeFor(req)); if (!sale) return res.status(404).json({ error: 'Sale not found' }); const items = db.prepare('SELECT si.*,p.name,p.sku FROM sale_items si JOIN products p ON p.id=si.product_id WHERE si.sale_id=?').all(sale.id); res.json({ ...sale, items }); });
app.post('/api/sales/:id/return', auth, role('admin', 'manager', 'cashier'), (req, res) => { const parsed = z.object({ transaction_key: z.string().trim().min(8).max(120), items: z.array(z.object({ sale_item_id: z.number().int().positive(), quantity: z.number().positive() })).min(1) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Return transaction key and items are required' }); try { const result = db.transaction(() => { if (db.prepare('SELECT id FROM sale_returns WHERE transaction_key=?').get(parsed.data.transaction_key)) throw new Error('Duplicate return submission'); const sale = db.prepare('SELECT * FROM sales WHERE id=? AND store_id=? AND status<>\'cancelled\'').get(req.params.id, storeFor(req)); if (!sale) throw new Error('Sale not found'); for (const item of parsed.data.items) { const saleItem = db.prepare('SELECT * FROM sale_items WHERE id=? AND sale_id=?').get(item.sale_item_id, sale.id); const returned = db.prepare('SELECT COALESCE(SUM(quantity),0) AS quantity FROM sale_returns WHERE sale_item_id=?').get(item.sale_item_id).quantity; if (!saleItem || returned + item.quantity > saleItem.quantity) throw new Error('Return quantity exceeds the remaining sale quantity'); const batch = db.prepare('SELECT remaining_quantity FROM inventory_batches WHERE id=?').get(saleItem.batch_id); db.prepare('UPDATE inventory_batches SET remaining_quantity=remaining_quantity+? WHERE id=?').run(item.quantity, saleItem.batch_id); db.prepare('INSERT INTO sale_returns (sale_id,sale_item_id,quantity,store_id,transaction_key) VALUES (?,?,?,?,?)').run(sale.id, item.sale_item_id, item.quantity, storeFor(req), `${parsed.data.transaction_key}-${item.sale_item_id}`); recordMovement({ productId: saleItem.product_id, batchId: saleItem.batch_id, storeId: storeFor(req), type: 'SALE_RETURN_IN', quantity: item.quantity, previousQuantity: batch.remaining_quantity, updatedQuantity: batch.remaining_quantity + item.quantity, referenceId: sale.invoice_number, reason: 'Sale return', userId: req.user.id, transactionKey: `${parsed.data.transaction_key}-${item.sale_item_id}-movement` }); } audit(req.user.id, 'RETURN', 'sale', sale.id, sale.invoice_number); return { sale_id: sale.id, status: 'returned' }; })(); res.status(201).json(result); } catch (error) { res.status(error.message === 'Duplicate return submission' ? 409 : 400).json({ error: error.message }); } });
app.post('/api/sales/:id/cancel', auth, role('admin', 'manager'), (req, res) => { const parsed = z.object({ transaction_key: z.string().trim().min(8).max(120), reason: z.string().trim().min(3) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Cancellation transaction key and reason are required' }); try { const result = db.transaction(() => { if (db.prepare('SELECT id FROM sale_reversals WHERE transaction_key=?').get(parsed.data.transaction_key)) throw new Error('Duplicate cancellation submission'); const sale = db.prepare('SELECT * FROM sales WHERE id=? AND store_id=? AND status=\'completed\'').get(req.params.id, storeFor(req)); if (!sale) throw new Error('Only completed sales can be cancelled'); const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(sale.id); for (const item of items) { const batch = db.prepare('SELECT remaining_quantity FROM inventory_batches WHERE id=?').get(item.batch_id); db.prepare('UPDATE inventory_batches SET remaining_quantity=remaining_quantity+? WHERE id=?').run(item.quantity, item.batch_id); recordMovement({ productId: item.product_id, batchId: item.batch_id, storeId: storeFor(req), type: 'SALE_CANCEL_IN', quantity: item.quantity, previousQuantity: batch.remaining_quantity, updatedQuantity: batch.remaining_quantity + item.quantity, referenceId: sale.invoice_number, reason: parsed.data.reason, userId: req.user.id, transactionKey: `${parsed.data.transaction_key}-${item.id}` }); } db.prepare('INSERT INTO sale_reversals (sale_id,store_id,transaction_key,reason) VALUES (?,?,?,?)').run(sale.id, storeFor(req), parsed.data.transaction_key, parsed.data.reason); db.prepare("UPDATE sales SET status='cancelled',payment_status='refunded' WHERE id=?").run(sale.id); audit(req.user.id, 'CANCEL', 'sale', sale.id, parsed.data.reason); return { sale_id: sale.id, status: 'cancelled' }; })(); res.status(201).json(result); } catch (error) { res.status(error.message === 'Duplicate cancellation submission' ? 409 : 400).json({ error: error.message }); } });
app.get('/api/customers', auth, (req, res) => {
  const storeId = storeFor(req);
  res.json(db.prepare("SELECT c.*,COUNT(s.id) AS purchase_count,COALESCE(SUM(s.total),0) AS lifetime_value FROM customers c LEFT JOIN sales s ON s.customer_id=c.id AND s.store_id=? AND s.status='completed' GROUP BY c.id ORDER BY c.name").all(storeId));
});
app.post('/api/customers', auth, (req, res) => { const parsed = z.object({ name: z.string().min(2), phone: z.string().optional(), email: z.string().email().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Customer name is required' }); const result = db.prepare('INSERT INTO customers (name,phone,email) VALUES (?,?,?)').run(parsed.data.name, parsed.data.phone || '', parsed.data.email || ''); res.status(201).json({ id: result.lastInsertRowid }); });
app.get('/api/purchases-legacy', auth, (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  res.json(db.prepare('SELECT po.*,s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id WHERE po.store_id=? ORDER BY po.id DESC').all(storeFor(req)));
});
app.post('/api/purchases-legacy', auth, role('admin', 'manager', 'inventory'), (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  const parsed = z.object({ supplier_id: z.number().int(), expected_date: z.string().optional(), items: z.array(z.object({ product_id: z.number().int(), quantity: z.number().positive(), unit_price: z.number().nonnegative(), gst_rate: z.number().min(0).max(28).default(5) })).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Supplier and purchase items are required' });
  const storeId = storeFor(req);
  const create = db.transaction(() => {
    const orderNumber = `PO-${new Date().getFullYear()}-${String(db.prepare('SELECT COUNT(*) AS count FROM purchase_orders').get().count + 41).padStart(3, '0')}`;
    const total = parsed.data.items.reduce((sum, item) => sum + item.quantity * item.unit_price * (1 + item.gst_rate / 100), 0);
    const order = db.prepare('INSERT INTO purchase_orders (order_number,supplier_id,status,total,expected_date,store_id) VALUES (?,?,?,?,?,?)').run(orderNumber, parsed.data.supplier_id, 'approved', total, parsed.data.expected_date || null, storeId);
    const item = db.prepare('INSERT INTO purchase_items (purchase_order_id,product_id,quantity,unit_price,gst_rate) VALUES (?,?,?,?,?)');
    parsed.data.items.forEach((value) => item.run(order.lastInsertRowid, value.product_id, value.quantity, value.unit_price, value.gst_rate));
    audit(req.user.id, 'CREATE', 'purchase_order', order.lastInsertRowid, orderNumber);
    return { id: order.lastInsertRowid, orderNumber };
  });
  res.status(201).json(create());
});
app.post('/api/purchases/:id/receive-legacy', auth, role('admin', 'manager', 'inventory'), (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  const parsed = z.object({ items: z.array(z.object({ product_id: z.number().int(), received_quantity: z.number().positive(), batch_number: z.string().min(1), manufacturing_date: z.string().optional(), expiry_date: z.string().optional(), purchase_price: z.number().nonnegative() })).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Received batch details are required' });
  try {
    const storeId = storeFor(req);
    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM purchase_orders WHERE id=? AND store_id=?').get(req.params.id, storeId);
      if (!order) throw new Error('Purchase order not found');
      const batch = db.prepare('INSERT INTO inventory_batches (product_id,supplier_id,batch_number,manufacturing_date,expiry_date,received_quantity,remaining_quantity,purchase_price) VALUES (?,?,?,?,?,?,?,?)');
      const received = db.prepare('UPDATE purchase_items SET received_quantity=received_quantity+? WHERE purchase_order_id=? AND product_id=?');
      parsed.data.items.forEach((item) => {
        const previous = db.prepare("SELECT COALESCE(SUM(CASE WHEN expiry_date>=date('now') THEN remaining_quantity ELSE 0 END),0) AS stock FROM inventory_batches WHERE product_id=? AND status='available'").get(item.product_id).stock;
        const batchResult = batch.run(item.product_id, order.supplier_id, item.batch_number, item.manufacturing_date || null, item.expiry_date || null, item.received_quantity, item.received_quantity, item.purchase_price);
        recordMovement({ productId: item.product_id, batchId: batchResult.lastInsertRowid, storeId, type: 'PURCHASE_IN', quantity: item.received_quantity, previousQuantity: previous, updatedQuantity: previous + item.received_quantity, referenceId: order.order_number, reason: 'Goods received (legacy)', userId: req.user.id });
        received.run(item.received_quantity, order.id, item.product_id);
      });
      db.prepare("UPDATE purchase_orders SET status='received' WHERE id=?").run(order.id);
      audit(req.user.id, 'RECEIVE', 'purchase_order', order.id, order.order_number);
      return { orderId: order.id, status: 'received' };
    })();
    res.json(result);
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});
app.post('/api/sales-legacy', auth, (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  const parsed = z.object({ customer_id: z.number().int().nullable().optional(), payment_method: z.enum(['cash', 'upi', 'card', 'split']), discount: z.number().nonnegative().default(0), items: z.array(z.object({ product_id: z.number().int(), quantity: z.number().positive() })).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payment method and sale items are required' });
  try {
    const storeId = storeFor(req);
    const result = db.transaction(() => {
      const lineItems = [];
      for (const item of parsed.data.items) {
        const product = db.prepare('SELECT * FROM products WHERE id=? AND store_id=? AND active=1').get(item.product_id, storeId);
        if (!product) throw new Error('Product not found');
        const batches = db.prepare("SELECT * FROM inventory_batches WHERE product_id=? AND remaining_quantity>0 AND status='available' AND expiry_date>=date('now') ORDER BY expiry_date, id").all(item.product_id);
        let remaining = item.quantity;
        for (const batch of batches) {
          if (remaining <= 0) break;
          const quantity = Math.min(remaining, batch.remaining_quantity);
          lineItems.push({ product, batch, quantity });
          remaining -= quantity;
        }
        if (remaining > 0) throw new Error(`${product.name} does not have enough unexpired stock`);
      }
      const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.product.selling_price, 0);
      const tax = lineItems.reduce((sum, item) => sum + item.quantity * item.product.selling_price * item.product.gst_rate / 100, 0);
      const total = Math.max(0, subtotal + tax - parsed.data.discount);
      const invoiceNumber = nextInvoice();
      const sale = db.prepare('INSERT INTO sales (invoice_number,customer_id,subtotal,tax,discount,total,payment_method,cashier_id,store_id) VALUES (?,?,?,?,?,?,?,?,?)').run(invoiceNumber, parsed.data.customer_id || null, subtotal, tax, parsed.data.discount, total, parsed.data.payment_method, req.user.id, storeId);
      const saleItem = db.prepare('INSERT INTO sale_items (sale_id,product_id,batch_id,quantity,unit_price,gst_rate,line_total) VALUES (?,?,?,?,?,?,?)');
      lineItems.forEach((item) => {
        saleItem.run(sale.lastInsertRowid, item.product.id, item.batch.id, item.quantity, item.product.selling_price, item.product.gst_rate, item.quantity * item.product.selling_price);
        const previous = item.batch.remaining_quantity;
        db.prepare('UPDATE inventory_batches SET remaining_quantity=remaining_quantity-? WHERE id=?').run(item.quantity, item.batch.id);
        recordMovement({ productId: item.product.id, batchId: item.batch.id, storeId, type: 'SALE_OUT', quantity: item.quantity, previousQuantity: previous, updatedQuantity: previous - item.quantity, referenceId: String(sale.lastInsertRowid), reason: 'POS sale (legacy)', userId: req.user.id });
      });
      db.prepare('INSERT INTO payments (sale_id,method,amount,store_id) VALUES (?,?,?,?)').run(sale.lastInsertRowid, parsed.data.payment_method, total, storeId);
      audit(req.user.id, 'CREATE', 'sale', sale.lastInsertRowid, `Invoice ${invoiceNumber}`);
      return { id: sale.lastInsertRowid, invoice_number: invoiceNumber, subtotal, tax, total };
    })();
    res.status(201).json(result);
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});
app.get('/api/sales-legacy', auth, (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  res.json(db.prepare('SELECT s.*,c.name AS customer_name,u.name AS cashier_name FROM sales s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN users u ON u.id=s.cashier_id WHERE s.store_id=? ORDER BY s.id DESC LIMIT 100').all(storeFor(req)));
});
app.post('/api/sales/:id/return-legacy', auth, role('admin', 'manager', 'cashier'), (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  const parsed = z.object({ items: z.array(z.object({ sale_item_id: z.number().int(), quantity: z.number().positive() })).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Return items are required' });
  try {
    const storeId = storeFor(req);
    const result = db.transaction(() => {
      for (const item of parsed.data.items) {
        const saleItem = db.prepare('SELECT si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.id=? AND si.sale_id=? AND s.store_id=?').get(item.sale_item_id, req.params.id, storeId);
        if (!saleItem || item.quantity > saleItem.quantity) throw new Error('Return quantity exceeds the original sale');
        const batch = db.prepare('SELECT remaining_quantity FROM inventory_batches WHERE id=?').get(saleItem.batch_id);
        db.prepare('UPDATE inventory_batches SET remaining_quantity=remaining_quantity+? WHERE id=?').run(item.quantity, saleItem.batch_id);
        recordMovement({ productId: saleItem.product_id, batchId: saleItem.batch_id, storeId, type: 'SALE_RETURN_IN', quantity: item.quantity, previousQuantity: batch.remaining_quantity, updatedQuantity: batch.remaining_quantity + item.quantity, referenceId: req.params.id, reason: 'Customer return (legacy)', userId: req.user.id });
      }
      audit(req.user.id, 'RETURN', 'sale', req.params.id);
      return { saleId: req.params.id, status: 'returned' };
    })();
    res.json(result);
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});
app.get('/api/notifications', auth, (req, res) => { const storeId = storeFor(req); syncAlerts(storeId); const conditions = ['store_id=?', 'dismissed=0']; const params = [storeId]; if (req.query.type) { conditions.push('type=?'); params.push(req.query.type); } if (req.query.read === 'unread') conditions.push('read=0'); if (req.query.read === 'read') conditions.push('read=1'); res.json(db.prepare(`SELECT * FROM notifications WHERE ${conditions.join(' AND ')} ORDER BY datetime(created_at) DESC`).all(...params)); });
app.patch('/api/notifications/:id/read', auth, (req, res) => { const result = db.prepare('UPDATE notifications SET read=1 WHERE id=? AND store_id=?').run(req.params.id, storeFor(req)); if (!result.changes) return res.status(404).json({ error: 'Notification not found' }); res.json({ ok: true }); });
app.delete('/api/notifications/:id', auth, (req, res) => { const result = db.prepare('UPDATE notifications SET dismissed=1,read=1 WHERE id=? AND store_id=?').run(req.params.id, storeFor(req)); if (!result.changes) return res.status(404).json({ error: 'Notification not found' }); res.json({ ok: true }); });
app.get('/api/reports/sales', auth, role('admin', 'manager'), (req, res) => {
  const storeId = storeFor(req);
  const from = req.query.from || '2000-01-01';
  const to = req.query.to || '2999-12-31';
  res.json({
    from,
    to,
    summary: db.prepare("SELECT COUNT(*) AS bills,COALESCE(SUM(subtotal),0) AS subtotal,COALESCE(SUM(tax),0) AS tax,COALESCE(SUM(total),0) AS revenue FROM sales WHERE date(created_at) BETWEEN date(?) AND date(?) AND status='completed' AND store_id=?").get(from, to, storeId),
    byPayment: db.prepare("SELECT payment_method,COUNT(*) AS bills,SUM(total) AS amount FROM sales WHERE date(created_at) BETWEEN date(?) AND date(?) AND status='completed' AND store_id=? GROUP BY payment_method").all(from, to, storeId)
  });
});
app.get('/api/reports/sales-trend', auth, (req, res) => {
  const storeId = storeFor(req);
  const days = req.query.period === 'monthly' ? 30 : 7;
  const rows = db.prepare("SELECT date(created_at) AS date,COALESCE(SUM(total),0) AS revenue FROM sales WHERE status='completed' AND store_id=? AND date(created_at)>=date('now',?) GROUP BY date(created_at) ORDER BY date(created_at)").all(storeId, `-${days - 1} day`);
  res.json({ days, rows });
});
app.get('/api/reports/profit-loss', auth, role('admin', 'manager'), (req, res) => {
  const storeId = storeFor(req);
  const from = req.query.from || '2000-01-01';
  const to = req.query.to || '2999-12-31';
  res.json(db.prepare("SELECT COALESCE(SUM(si.line_total),0) AS revenue,COALESCE(SUM(si.quantity*p.purchase_price),0) AS cost,COALESCE(SUM(si.line_total-si.quantity*p.purchase_price),0) AS gross_profit FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id WHERE date(s.created_at) BETWEEN date(?) AND date(?) AND s.status='completed' AND s.store_id=?").get(from, to, storeId));
});
app.get('/api/reports/inventory-valuation', auth, role('admin', 'manager'), (req, res) => {
  const storeId = storeFor(req);
  res.json(db.prepare("SELECT COALESCE(SUM(b.remaining_quantity*b.purchase_price),0) AS purchase_value,COALESCE(SUM(b.remaining_quantity*p.selling_price),0) AS retail_value FROM inventory_batches b JOIN products p ON p.id=b.product_id WHERE b.remaining_quantity>0 AND p.store_id=?").get(storeId));
});
app.get('/api/reports/expiry', auth, (req, res) => {
  const storeId = storeFor(req);
  res.json(db.prepare("SELECT p.name,p.sku,b.batch_number,b.expiry_date,b.remaining_quantity,CASE WHEN b.expiry_date<date('now') THEN 'expired' ELSE 'near_expiry' END AS status FROM inventory_batches b JOIN products p ON p.id=b.product_id WHERE b.remaining_quantity>0 AND p.store_id=? ORDER BY b.expiry_date").all(storeId));
});
app.get('/api/reports/export.csv', auth, role('admin', 'manager'), (req, res) => {
  const storeId = storeFor(req);
  const rows = db.prepare('SELECT invoice_number,subtotal,tax,total,payment_method,status,created_at FROM sales WHERE store_id=? ORDER BY id DESC').all(storeId);
  const csv = ['invoice_number,subtotal,tax,total,payment_method,status,created_at', ...rows.map((row) => Object.values(row).map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="amora-sales.csv"');
  res.send(csv);
});
app.get('/api/forecast', auth, role('admin', 'manager'), (req, res) => {
  const storeId = storeFor(req);
  res.json(db.prepare("SELECT p.id,p.name,p.min_stock,COALESCE(SUM(si.quantity),0) AS units_sold,ROUND(COALESCE(SUM(si.quantity),0)/30.0,1) AS daily_velocity,MAX(0,ROUND(COALESCE(SUM(si.quantity),0)/30.0*14-COALESCE(SUM(b.remaining_quantity),0),0)) AS recommended_reorder FROM products p LEFT JOIN sale_items si ON si.product_id=p.id LEFT JOIN inventory_batches b ON b.product_id=p.id WHERE p.store_id=? AND p.active=1 GROUP BY p.id ORDER BY recommended_reorder DESC").all(storeId));
});
app.get('/api/analysis/inventory', auth, role('admin', 'manager', 'inventory', 'stock_manager'), (req, res) => {
  const storeId = storeFor(req);
  const period = req.query.period === 'daily' ? '-1 day' : req.query.period === 'yearly' ? '-1 year' : '-1 month';
  const rows = db.prepare("SELECT p.id,p.sku,p.barcode,p.name,p.unit,p.min_stock,p.selling_price,COALESCE((SELECT SUM(pi.quantity) FROM purchase_items pi JOIN purchase_orders po ON po.id=pi.purchase_order_id WHERE pi.product_id=p.id AND po.order_date>=datetime('now',?) AND po.store_id=?),0) AS purchased,COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.product_id=p.id AND s.created_at>=datetime('now',?) AND s.store_id=?),0) AS sold,COALESCE((SELECT SUM(b.remaining_quantity) FROM inventory_batches b WHERE b.product_id=p.id AND b.status='available' AND b.expiry_date>=date('now')),0) AS remaining FROM products p WHERE p.store_id=? AND p.active=1 ORDER BY p.name").all(period, storeId, period, storeId, storeId).map((item) => {
    const dailyDemand = item.sold / (req.query.period === 'daily' ? 1 : req.query.period === 'yearly' ? 365 : 30);
    const suggested = Math.max(0, Math.ceil(dailyDemand * 14 + item.min_stock - item.remaining));
    return { ...item, suggested_order: suggested, status: item.remaining <= 0 ? 'Out of stock' : suggested > 0 ? 'Reorder' : item.remaining <= item.min_stock ? 'Low' : 'Healthy' };
  });
  const summary = rows.reduce((result, item) => ({
    purchased: result.purchased + item.purchased,
    sold: result.sold + item.sold,
    remaining: result.remaining + item.remaining,
    reorder: result.reorder + (item.status === 'Reorder' || item.status === 'Out of stock' ? 1 : 0)
  }), { purchased: 0, sold: 0, remaining: 0, reorder: 0 });
  res.json({ period: req.query.period || 'monthly', summary, rows });
});
app.get('/api/analysis/profit-loss', auth, role('admin', 'manager'), (req, res) => {
  const storeId = storeFor(req);
  const period = req.query.period === 'daily' ? '-1 day' : req.query.period === 'yearly' ? '-1 year' : '-1 month';
  const rows = db.prepare("SELECT p.id,p.sku,p.name,COALESCE(SUM(si.quantity),0) AS quantity_sold,COALESCE(SUM(si.line_total),0) AS revenue,COALESCE(SUM(si.quantity*b.purchase_price),0) AS cost FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id JOIN inventory_batches b ON b.id=si.batch_id WHERE s.status='completed' AND s.store_id=? AND s.created_at>=datetime('now',?) GROUP BY p.id ORDER BY revenue DESC").all(storeId, period).map((item) => ({
    ...item,
    profit: item.revenue - item.cost,
    margin: item.revenue ? Number((((item.revenue - item.cost) / item.revenue) * 100).toFixed(2)) : 0
  }));
  const summary = rows.reduce((result, item) => ({
    revenue: result.revenue + item.revenue,
    cost: result.cost + item.cost,
    profit: result.profit + item.profit
  }), { revenue: 0, cost: 0, profit: 0 });
  summary.margin = summary.revenue ? Number(((summary.profit / summary.revenue) * 100).toFixed(2)) : 0;
  res.json({ period: req.query.period || 'monthly', summary, rows });
});
app.get('/api/audit-logs', auth, role('admin', 'manager'), (_req, res) => res.json(db.prepare('SELECT a.*,u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100').all()));
app.get('/api/settings', auth, (_req, res) => res.json(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((row) => [row.key, row.value]))));
app.patch('/api/settings', auth, role('admin', 'manager'), (req, res) => { const values = z.record(z.string(), z.string()).safeParse(req.body); if (!values.success) return res.status(400).json({ error: 'Settings must be key/value text' }); const update = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'); const save = db.transaction(() => Object.entries(values.data).forEach(([key, value]) => update.run(key, value))); save(); audit(req.user.id, 'UPDATE', 'settings', 'store', Object.keys(values.data).join(',')); res.json({ ok: true }); });
app.get('/api/backup', auth, role('admin'), (_req, res) => { const filename = `amora-backup-${new Date().toISOString().replaceAll(':', '-')}.sqlite`; const destination = path.join(dataDir, filename); db.backup(destination).then(() => res.download(destination, filename)).catch(() => res.status(500).json({ error: 'Backup failed' })); });
app.use(express.static(rootDir));
app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: 'Unexpected server error' }); });

export { app, db };

if (process.env.NODE_ENV !== 'test' && !process.argv.includes('--test')) {
  if (process.argv.includes('--seed')) { console.log('AMORA database is ready at', path.join(dataDir, 'amora.sqlite')); process.exit(0); }
  const server = app.listen(PORT, () => console.log(`AMORA running at http://localhost:${PORT}`));
  server.on('error', (error) => { if (error.code === 'EADDRINUSE') { console.error(`AMORA cannot start: port ${PORT} is already in use. Stop the existing AMORA process or choose another PORT explicitly.`); process.exitCode = 1; } else { console.error('AMORA server error:', error.message); process.exitCode = 1; } });
}
