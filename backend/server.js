import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { cert, getApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getDb, withTransaction, query, queryOne, queryMany } from './db-postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const pool = getDb();
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

// ==============================================================================
// AUTHENTICATION & ACCESS CONTROL MIDDLEWARE
// ==============================================================================

async function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  if (adminAuth) {
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      const uid = decoded.uid;
      const email = typeof decoded.email === 'string' ? decoded.email.trim().toLowerCase() : '';
      const emailVerified = Boolean(decoded.email_verified);

      // 1. First, search if a database user already possesses this exact firebase_uid
      const uidRes = await pool.query(
        'SELECT id, name, email, role, active, firebase_uid FROM users WHERE firebase_uid = $1',
        [uid]
      );

      // 2. Also search if a database user possesses this normalized email
      const emailRes = email
        ? await pool.query(
            'SELECT id, name, email, role, active, firebase_uid FROM users WHERE LOWER(TRIM(email)) = $1',
            [email]
          )
        : { rows: [] };

      const userByUid = uidRes.rows[0] || null;
      const userByEmail = emailRes.rows[0] || null;

      // Conflict Check: UID and Email resolve to two distinct database user accounts
      if (userByUid && userByEmail && userByUid.id !== userByEmail.id) {
        return res.status(403).json({ error: 'Identity conflict between UID and email mapping' });
      }

      // Check for ambiguous duplicate email accounts in DB
      if (emailRes.rows.length > 1) {
        return res.status(403).json({ error: 'Ambiguous user identity: multiple accounts match email' });
      }

      let dbUser = userByUid;

      // If user is not yet linked by UID, evaluate first-time linking via verified email
      if (!dbUser) {
        if (!userByEmail) {
          return res.status(401).json({ error: 'User account not provisioned in database' });
        }

        // Mandatory Security Check: Reject linking if email is unverified
        if (!emailVerified) {
          return res.status(403).json({ error: 'Email address must be verified before account linking' });
        }

        // Prevent overwriting an existing UID mapping on that account
        if (userByEmail.firebase_uid && userByEmail.firebase_uid !== uid) {
          return res.status(403).json({ error: 'Target account is already mapped to a different Firebase identity' });
        }

        // Atomically link firebase_uid to the verified email account
        const linkRes = await pool.query(
          'UPDATE users SET firebase_uid = $1 WHERE id = $2 AND firebase_uid IS NULL RETURNING id, name, email, role, active, firebase_uid',
          [uid, userByEmail.id]
        );

        if (linkRes.rows.length === 0) {
          // Concurrency or already mapped check
          const recheck = await pool.query('SELECT id, name, email, role, active, firebase_uid FROM users WHERE id = $1', [userByEmail.id]);
          if (recheck.rows[0]?.firebase_uid !== uid) {
            return res.status(403).json({ error: 'Failed to safely link account: concurrent conflict detected' });
          }
          dbUser = recheck.rows[0];
        } else {
          dbUser = linkRes.rows[0];
        }
      }

      // Reject inactive users
      if (!dbUser || Number(dbUser.active) !== 1) {
        return res.status(401).json({ error: 'User account is inactive or disabled' });
      }

      req.user = {
        ...decoded,
        id: dbUser.id,
        dbId: dbUser.id,
        uid: uid,
        firebaseUid: uid,
        name: dbUser.name || decoded.name || dbUser.email,
        role: dbUser.role || 'cashier',
        storeId: 'amora-main'
      };
      return next();
    } catch (authError) {
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

function role(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'This role cannot perform that action' });
}

function storeFor(req) {
  return req.user.storeId || 'amora-main';
}

// ==============================================================================
// SHARED DATABASE HELPERS
// ==============================================================================

async function audit(userId, action, entity, entityId, details = '', client = null) {
  const q = client || pool;
  try {
    await q.query(
      'INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
      [userId ? Number(userId) || null : null, action, entity, String(entityId ?? ''), details]
    );
  } catch (err) {
    console.error('Audit logging error:', err.message);
  }
}

async function nextInvoice(client = null) {
  const q = client || pool;
  const res = await q.query("SELECT COUNT(*) AS count FROM sales WHERE created_at::date = CURRENT_DATE");
  const count = Number(res.rows[0].count) + 1;
  return `AM-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(count).padStart(3, '0')}`;
}

async function stockRows(storeId = '', client = null) {
  const q = client || pool;
  const filter = storeId ? 'WHERE p.store_id = $1' : '';
  const params = storeId ? [storeId] : [];
  const res = await q.query(`
    SELECT p.*, c.name AS category,
      COALESCE(SUM(CASE WHEN b.expiry_date >= CURRENT_DATE THEN b.remaining_quantity ELSE 0 END), 0) AS available_quantity
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory_batches b ON b.product_id = p.id AND b.status = 'available'
    ${filter}
    GROUP BY p.id, c.name
    ORDER BY LOWER(p.name)
  `, params);
  return res.rows;
}

async function productRows(storeId, { search = '', categoryId = '', status = '', sort = 'name', page = 1, pageSize = 10 } = {}, client = null) {
  const q = client || pool;
  const sortMap = {
    name: 'LOWER(p.name)',
    sku: 'LOWER(p.sku)',
    selling_price: 'p.selling_price',
    available_quantity: 'available_quantity'
  };
  const conditions = ['p.store_id = $1', 'p.active = 1'];
  const params = [storeId];
  let paramIdx = 2;

  if (search) {
    conditions.push(`(p.name ILIKE $${paramIdx} OR p.sku ILIKE $${paramIdx} OR p.barcode ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }
  if (categoryId) {
    conditions.push(`p.category_id = $${paramIdx}`);
    params.push(Number(categoryId));
    paramIdx++;
  }

  const base = `
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory_batches b ON b.product_id = p.id AND b.status = 'available'
    WHERE ${conditions.join(' AND ')}
    GROUP BY p.id, c.name
  `;

  const sql = `
    SELECT p.*, c.name AS category,
      COALESCE(SUM(CASE WHEN b.expiry_date >= CURRENT_DATE THEN b.remaining_quantity ELSE 0 END), 0) AS available_quantity
    ${base}
    ORDER BY ${sortMap[sort] || sortMap.name}
  `;

  const res = await q.query(sql, params);
  const rows = res.rows;
  const filtered = status
    ? rows.filter((item) =>
        status === 'out_of_stock'
          ? item.available_quantity <= 0
          : status === 'low_stock'
          ? item.available_quantity > 0 && item.available_quantity <= item.min_stock
          : item.available_quantity > item.min_stock
      )
    : rows;

  const offset = (Math.max(1, Number(page)) - 1) * Math.max(1, Number(pageSize));
  return {
    rows: filtered.slice(offset, offset + Math.max(1, Number(pageSize))),
    total: filtered.length,
    page: Math.max(1, Number(page)),
    pageSize: Math.max(1, Number(pageSize))
  };
}

async function recordMovement({ productId, batchId = null, type, quantity, previousQuantity, updatedQuantity, referenceId = '', reason = '', userId, storeId, transactionKey = null }, client = null) {
  const q = client || pool;
  let key = transactionKey;
  if (transactionKey) {
    const existing = await q.query('SELECT id FROM stock_movements WHERE transaction_key = $1', [transactionKey]);
    if (existing.rows.length > 0) {
      key = `${transactionKey}-${productId}-${batchId ?? 'movement'}`;
    }
  }
  const res = await q.query(`
    INSERT INTO stock_movements (product_id, batch_id, store_id, type, quantity, previous_quantity, updated_quantity, reference_id, reason, performed_by, transaction_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
  `, [productId, batchId, storeId, type, quantity, previousQuantity, updatedQuantity, referenceId, reason, userId ? Number(userId) || null : null, key]);
  return { id: res.rows[0].id, lastInsertRowid: res.rows[0].id };
}

async function negativeStockAllowed(req, client = null) {
  if (req.user.role !== 'admin') return false;
  const q = client || pool;
  const res = await q.query("SELECT value FROM settings WHERE key = 'allow_negative_stock'");
  return res.rows[0]?.value === 'true';
}

async function alertSetting(key, fallback, client = null) {
  const q = client || pool;
  const res = await q.query('SELECT value FROM settings WHERE key = $1', [key]);
  const val = res.rows[0]?.value;
  return val === undefined ? fallback : Number(val);
}

async function syncAlerts(storeId) {
  const alerts = [];
  const products = await stockRows(storeId);
  const expiryDays = await alertSetting('expiry_alert_days', 7);
  const overstockFactor = await alertSetting('overstock_alert_factor', 1);

  products.forEach((product) => {
    if (product.available_quantity <= 0) {
      alerts.push(['OUT_OF_STOCK', `out:${product.id}`, `${product.name} is out of stock`, 'Restock this product before the next sale.', 'critical']);
    } else if (product.available_quantity <= product.min_stock) {
      alerts.push(['LOW_STOCK', `low:${product.id}`, `${product.name} is low in stock`, `${product.available_quantity} units remain against a minimum of ${product.min_stock}.`, 'warning']);
    }
    if (product.available_quantity > product.max_stock * overstockFactor) {
      alerts.push(['OVERSTOCK', `over:${product.id}`, `${product.name} is overstocked`, `${product.available_quantity} units exceed the maximum stock level of ${product.max_stock}.`, 'info']);
    }
  });

  const expiringRes = await pool.query(`
    SELECT p.id, p.name, b.batch_number, b.expiry_date
    FROM inventory_batches b
    JOIN products p ON p.id = b.product_id
    WHERE p.store_id = $1
      AND b.status = 'available'
      AND b.remaining_quantity > 0
      AND b.expiry_date <= (CURRENT_DATE + ($2 || ' days')::interval)
  `, [storeId, expiryDays]);

  expiringRes.rows.forEach((batch) => {
    alerts.push(['EXPIRY', `expiry:${batch.id}`, `${batch.name} is nearing expiry`, `Batch ${batch.batch_number} expires on ${batch.expiry_date}.`, 'warning']);
  });

  const pendingPoRes = await pool.query(`
    SELECT po.id, po.order_number, s.name
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.store_id = $1 AND po.status IN ('approved', 'partially_received')
  `, [storeId]);

  pendingPoRes.rows.forEach((order) => {
    alerts.push(['PENDING_PURCHASE', `purchase:${order.id}`, `Purchase order ${order.order_number} is pending`, `${order.name} still requires receipt or completion.`, 'info']);
  });

  const keys = new Set(alerts.map((a) => a[1]));

  await withTransaction(async (client) => {
    if (keys.size > 0) {
      const keyArray = Array.from(keys);
      await client.query(
        'DELETE FROM notifications WHERE store_id = $1 AND NOT (alert_key = ANY($2::text[]))',
        [storeId, keyArray]
      );
    } else {
      await client.query('DELETE FROM notifications WHERE store_id = $1', [storeId]);
    }

    for (const alert of alerts) {
      await client.query(`
        INSERT INTO notifications (type, alert_key, title, message, severity, store_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (store_id, alert_key)
        DO UPDATE SET type = EXCLUDED.type, title = EXCLUDED.title, message = EXCLUDED.message, severity = EXCLUDED.severity
      `, [alert[0], alert[1], alert[2], alert[3], alert[4], storeId]);
    }
  });

  return alerts.length;
}

async function supplierList(req) {
  const search = String(req.query.search || '').trim();
  const status = req.query.status === 'archived' ? 0 : req.query.status === 'all' ? null : 1;
  const sortMap = {
    name: 'LOWER(s.name)',
    code: 'LOWER(s.supplier_code)',
    payable: 'outstanding_payable DESC',
    purchases: 'purchase_value DESC'
  };
  const conditions = ['s.store_id = $1'];
  const params = [storeFor(req)];
  let paramIdx = 2;

  if (status !== null) {
    conditions.push(`s.active = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  }
  if (search) {
    conditions.push(`(s.name ILIKE $${paramIdx} OR s.supplier_code ILIKE $${paramIdx} OR s.contact_person ILIKE $${paramIdx} OR s.phone ILIKE $${paramIdx} OR s.email ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  const sql = `
    SELECT s.*,
      COUNT(DISTINCT po.id) AS purchase_count,
      COALESCE(SUM(DISTINCT po.total), 0) AS purchase_value,
      COALESCE(SUM(DISTINCT CASE WHEN po.payment_status <> 'paid' THEN po.total ELSE 0 END), 0) AS outstanding_payable,
      COUNT(DISTINCT sp.product_id) AS mapped_products
    FROM suppliers s
    LEFT JOIN purchase_orders po ON po.supplier_id = s.id
    LEFT JOIN supplier_products sp ON sp.supplier_id = s.id AND sp.active = 1
    WHERE ${conditions.join(' AND ')}
    GROUP BY s.id
    ORDER BY ${sortMap[req.query.sort] || sortMap.name}
  `;
  const res = await pool.query(sql, params);
  return res.rows;
}

// ==============================================================================
// AUTHENTICATION ROUTES
// ==============================================================================

app.post('/api/auth/login', async (req, res) => {
  if (adminAuth && process.env.ALLOW_LEGACY_AUTH !== 'true') {
    return res.status(403).json({ error: 'Local password authentication is disabled. Please sign in with Firebase Authentication.' });
  }
  const parsed = z.object({ email: z.string().email(), password: z.string().min(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and password' });

  const userRes = await pool.query('SELECT * FROM users WHERE email = $1 AND active = 1', [parsed.data.email]);
  const user = userRes.rows[0];

  if (!user || !bcrypt.compareSync(parsed.data.password, user.password_hash)) {
    if (user) {
      await pool.query('INSERT INTO login_history (user_id, ip_address, success) VALUES ($1, $2, 0)', [user.id, req.ip]);
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  await pool.query('INSERT INTO login_history (user_id, ip_address, success) VALUES ($1, $2, 1)', [user.id, req.ip]);
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role, email: user.email, storeId: 'amora-main' }, JWT_SECRET, { expiresIn: '8h' });
  await audit(user.id, 'LOGIN', 'user', user.id);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email } });
});

app.get('/api/firebase-config', (_req, res) => res.json(publicFirebaseConfig));

app.post('/api/auth/change-password', auth, async (req, res) => {
  const parsed = z.object({ current_password: z.string().min(6), new_password: z.string().min(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Passwords must contain at least 6 characters' });

  const userRes = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const user = userRes.rows[0];
  if (!user || !bcrypt.compareSync(parsed.data.current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(parsed.data.new_password, 10), req.user.id]);
  await audit(req.user.id, 'PASSWORD_CHANGE', 'user', req.user.id);
  res.json({ ok: true });
});

app.get('/api/auth/login-history', auth, role('admin', 'manager'), async (_req, res) => {
  const history = await queryMany('SELECT l.*, u.name, u.email FROM login_history l JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 100');
  res.json(history);
});

// ==============================================================================
// SYSTEM & DASHBOARD ROUTES
// ==============================================================================

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'AMORA API', database: 'postgresql' }));

app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const storeId = storeFor(req);
    await syncAlerts(storeId);
    const products = await stockRows(storeId);

    const salesRes = await pool.query(
      "SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS bills FROM sales WHERE store_id = $1 AND created_at::date = CURRENT_DATE AND status = 'completed'",
      [storeId]
    );
    const sales = salesRes.rows[0];

    const purchasesRes = await pool.query(
      "SELECT COALESCE(SUM(total), 0) AS value FROM purchase_orders WHERE store_id = $1 AND order_date::date >= (CURRENT_DATE - INTERVAL '30 days')",
      [storeId]
    );
    const purchases = purchasesRes.rows[0];

    const lowStock = products.filter((p) => p.available_quantity > 0 && p.available_quantity <= p.min_stock);
    const outOfStock = products.filter((p) => p.available_quantity <= 0);

    const expiringRes = await pool.query(`
      SELECT p.name, b.batch_number, b.expiry_date, b.remaining_quantity
      FROM inventory_batches b
      JOIN products p ON p.id = b.product_id
      WHERE p.store_id = $1
        AND b.remaining_quantity > 0
        AND b.expiry_date <= (CURRENT_DATE + INTERVAL '7 days')
      ORDER BY b.expiry_date
    `, [storeId]);

    const unreadRes = await pool.query('SELECT COUNT(*) AS count FROM notifications WHERE store_id = $1 AND read = 0', [storeId]);
    const unread = Number(unreadRes.rows[0].count);

    const recentSalesRes = await pool.query(
      'SELECT invoice_number, total, payment_method, created_at FROM sales WHERE store_id = $1 ORDER BY id DESC LIMIT 8',
      [storeId]
    );

    res.json({
      metrics: {
        revenue: Number(sales.revenue),
        bills: Number(sales.bills),
        products: products.length,
        stock: products.reduce((sum, p) => sum + Number(p.available_quantity), 0),
        purchases: Number(purchases.value),
        notifications: unread
      },
      lowStock,
      outOfStock,
      expiring: expiringRes.rows,
      recentSales: recentSalesRes.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==============================================================================
// PRODUCTS, CATEGORIES & BRANDS ROUTES
// ==============================================================================

app.get('/api/products', auth, async (req, res) => {
  try {
    const result = await productRows(storeFor(req), req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/products/:id', auth, async (req, res) => {
  try {
    const resProduct = await pool.query(`
      SELECT p.*, c.name AS category,
        COALESCE(SUM(CASE WHEN b.expiry_date >= CURRENT_DATE THEN b.remaining_quantity ELSE 0 END), 0) AS available_quantity
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN inventory_batches b ON b.product_id = p.id AND b.status = 'available'
      WHERE p.id = $1 AND p.store_id = $2 AND p.active = 1
      GROUP BY p.id, c.name
    `, [req.params.id, storeFor(req)]);

    if (resProduct.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(resProduct.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/categories', auth, async (req, res) => {
  try {
    const storeId = storeFor(req);
    const rows = await queryMany(`
      SELECT c.*, COUNT(p.id) AS product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.store_id = $1 AND p.active = 1
      GROUP BY c.id
      ORDER BY c.name
    `, [storeId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/categories', auth, role('admin', 'manager'), async (req, res) => {
  const parsed = z.object({ name: z.string().min(2) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Category name is required' });

  try {
    const resInsert = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [parsed.data.name]);
    const id = resInsert.rows[0].id;
    await audit(req.user.id, 'CREATE', 'category', id, parsed.data.name);
    res.status(201).json({ id });
  } catch (error) {
    res.status(409).json({ error: error.message.includes('unique') || error.code === '23505' ? 'Category already exists' : 'Unable to create category' });
  }
});

app.get('/api/brands', auth, async (_req, res) => {
  try {
    const rows = await queryMany(`
      SELECT b.*, COUNT(p.id) AS product_count
      FROM brands b
      LEFT JOIN products p ON p.brand = b.name
      GROUP BY b.id
      ORDER BY b.name
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/brands', auth, role('admin', 'manager'), async (req, res) => {
  const parsed = z.object({ name: z.string().min(2) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Brand name is required' });

  try {
    const resInsert = await pool.query('INSERT INTO brands (name) VALUES ($1) RETURNING id', [parsed.data.name]);
    const id = resInsert.rows[0].id;
    await audit(req.user.id, 'CREATE', 'brand', id, parsed.data.name);
    res.status(201).json({ id });
  } catch (error) {
    res.status(409).json({ error: error.message.includes('unique') || error.code === '23505' ? 'Brand already exists' : 'Unable to create brand' });
  }
});

const productInput = z.object({
  sku: z.string().trim().min(2).max(40),
  barcode: z.string().trim().min(3).max(80).optional().or(z.literal('')),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(''),
  category_id: z.number().int().positive(),
  subcategory: z.string().trim().max(80).default(''),
  brand: z.string().trim().max(80).default(''),
  unit: z.string().trim().min(1).max(30).default('piece'),
  selling_price: z.number().nonnegative(),
  purchase_price: z.number().nonnegative(),
  gst_rate: z.number().min(0).max(28).default(5),
  min_stock: z.number().int().nonnegative().default(10),
  current_stock: z.number().nonnegative().default(0),
  image_url: z.string().url().max(500).optional().or(z.literal(''))
});

app.post('/api/products', auth, role('admin', 'manager', 'stock_manager'), async (req, res) => {
  const parsed = productInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Product fields are invalid or incomplete' });
  const value = parsed.data;

  const catCheck = await pool.query('SELECT id FROM categories WHERE id = $1', [value.category_id]);
  if (catCheck.rows.length === 0) return res.status(400).json({ error: 'Selected category does not exist' });

  try {
    const storeId = storeFor(req);
    const createdId = await withTransaction(async (client) => {
      const insert = await client.query(`
        INSERT INTO products (sku, barcode, name, description, category_id, subcategory, brand, unit, purchase_price, selling_price, mrp, gst_rate, min_stock, image_url, store_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id
      `, [value.sku, value.barcode || null, value.name, value.description, value.category_id, value.subcategory, value.brand, value.unit, value.purchase_price, value.selling_price, value.selling_price, value.gst_rate, value.min_stock, value.image_url || '', storeId]);

      const productId = insert.rows[0].id;

      if (value.current_stock > 0) {
        const batch = await client.query(`
          INSERT INTO inventory_batches (product_id, batch_number, expiry_date, received_quantity, remaining_quantity, purchase_price)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `, [productId, `OPENING-${value.sku}`, '2099-12-31', value.current_stock, value.current_stock, value.purchase_price]);

        await recordMovement({
          productId,
          batchId: batch.rows[0].id,
          storeId,
          type: 'OPENING_STOCK',
          quantity: value.current_stock,
          previousQuantity: 0,
          updatedQuantity: value.current_stock,
          reason: 'Opening stock',
          userId: req.user.id
        }, client);
      }

      await audit(req.user.id, 'CREATE', 'product', productId, value.name, client);
      return productId;
    });

    res.status(201).json({ id: createdId });
  } catch (error) {
    const isUnique = error.code === '23505' || error.message.includes('UNIQUE') || error.message.includes('unique');
    res.status(409).json({ error: isUnique ? 'SKU or barcode already exists' : 'Unable to create product' });
  }
});

app.patch('/api/products/:id', auth, role('admin', 'manager', 'stock_manager'), async (req, res) => {
  const parsed = productInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Product fields are invalid or incomplete' });

  const existingRes = await pool.query('SELECT id FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [req.params.id, storeFor(req)]);
  if (existingRes.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

  const value = parsed.data;
  try {
    await pool.query(`
      UPDATE products
      SET sku = $1, barcode = $2, name = $3, description = $4, category_id = $5, subcategory = $6, brand = $7, unit = $8,
          purchase_price = $9, selling_price = $10, mrp = $11, gst_rate = $12, min_stock = $13, image_url = $14
      WHERE id = $15 AND store_id = $16
    `, [value.sku, value.barcode || null, value.name, value.description, value.category_id, value.subcategory, value.brand, value.unit, value.purchase_price, value.selling_price, value.selling_price, value.gst_rate, value.min_stock, value.image_url || '', req.params.id, storeFor(req)]);

    await audit(req.user.id, 'UPDATE', 'product', req.params.id, value.name);
    res.json({ ok: true });
  } catch (error) {
    const isUnique = error.code === '23505' || error.message.includes('UNIQUE') || error.message.includes('unique');
    res.status(409).json({ error: isUnique ? 'SKU or barcode already exists' : 'Unable to update product' });
  }
});

app.delete('/api/products/:id', auth, role('admin', 'manager'), async (req, res) => {
  const existingRes = await pool.query('SELECT id, name FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [req.params.id, storeFor(req)]);
  if (existingRes.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
  const existing = existingRes.rows[0];

  const linkedRes = await pool.query(
    'SELECT (SELECT COUNT(*) FROM sale_items WHERE product_id = $1) + (SELECT COUNT(*) FROM purchase_items WHERE product_id = $1) AS count',
    [req.params.id]
  );
  if (Number(linkedRes.rows[0].count) > 0) {
    return res.status(409).json({ error: 'Product has transaction history and cannot be deleted' });
  }

  await pool.query('UPDATE products SET active = 0 WHERE id = $1 AND store_id = $2', [req.params.id, storeFor(req)]);
  await audit(req.user.id, 'DELETE', 'product', req.params.id, existing.name);
  res.json({ ok: true });
});

// ==============================================================================
// INVENTORY MANAGEMENT ROUTES
// ==============================================================================

app.get('/api/inventory', auth, async (req, res) => {
  try {
    const storeId = storeFor(req);
    const products = await stockRows(storeId);
    const movementsRes = await pool.query(`
      SELECT sm.*, p.name, u.name AS performed_by
      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      LEFT JOIN users u ON u.id = sm.performed_by
      WHERE sm.store_id = $1
      ORDER BY sm.id DESC LIMIT 100
    `, [storeId]);
    res.json({ products, movements: movementsRes.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/inventory/stock-in', auth, role('admin', 'manager', 'inventory', 'stock_manager'), async (req, res) => {
  const parsed = z.object({
    product_id: z.number().int().positive(),
    quantity: z.number().positive(),
    batch_number: z.string().trim().min(1).max(80),
    expiry_date: z.string().optional(),
    purchase_price: z.number().nonnegative().default(0),
    reason: z.string().trim().min(3),
    transaction_key: z.string().trim().min(8).max(120)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Product, positive quantity, batch, reason and transaction key are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      const dupCheck = await client.query('SELECT id FROM stock_movements WHERE transaction_key = $1', [parsed.data.transaction_key]);
      if (dupCheck.rows.length > 0) throw new Error('Duplicate stock transaction');

      const prodRes = await client.query('SELECT id FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [parsed.data.product_id, storeId]);
      if (prodRes.rows.length === 0) throw new Error('Product not found');
      const product = prodRes.rows[0];

      const prevRes = await client.query(
        "SELECT COALESCE(SUM(CASE WHEN expiry_date >= CURRENT_DATE THEN remaining_quantity ELSE 0 END), 0) AS stock FROM inventory_batches WHERE product_id = $1 AND status = 'available'",
        [product.id]
      );
      const previous = Number(prevRes.rows[0].stock);

      const batchRes = await client.query(`
        INSERT INTO inventory_batches (product_id, batch_number, expiry_date, received_quantity, remaining_quantity, purchase_price)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [product.id, parsed.data.batch_number, parsed.data.expiry_date || '2099-12-31', parsed.data.quantity, parsed.data.quantity, parsed.data.purchase_price]);

      const movement = await recordMovement({
        productId: product.id,
        batchId: batchRes.rows[0].id,
        storeId,
        type: 'STOCK_IN',
        quantity: parsed.data.quantity,
        previousQuantity: previous,
        updatedQuantity: previous + parsed.data.quantity,
        reason: parsed.data.reason,
        userId: req.user.id,
        transactionKey: parsed.data.transaction_key
      }, client);

      await audit(req.user.id, 'STOCK_IN', 'inventory', product.id, parsed.data.reason, client);
      return { id: movement.id, previous_stock: previous, updated_stock: previous + parsed.data.quantity };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.message === 'Duplicate stock transaction' ? 409 : 400).json({ error: error.message });
  }
});

app.post('/api/inventory/stock-out', auth, role('admin', 'manager', 'inventory', 'stock_manager'), async (req, res) => {
  const parsed = z.object({
    product_id: z.number().int().positive(),
    quantity: z.number().positive(),
    type: z.enum(['STOCK_OUT', 'DAMAGE_OUT', 'TRANSFER_OUT']),
    reason: z.string().trim().min(3),
    transaction_key: z.string().trim().min(8).max(120)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Product, positive quantity, type, reason and transaction key are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      const dupCheck = await client.query('SELECT id FROM stock_movements WHERE transaction_key = $1', [parsed.data.transaction_key]);
      if (dupCheck.rows.length > 0) throw new Error('Duplicate stock transaction');

      const prodRes = await client.query('SELECT id FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [parsed.data.product_id, storeId]);
      if (prodRes.rows.length === 0) throw new Error('Product not found');
      const product = prodRes.rows[0];

      // Lock available batches to prevent race conditions & overselling
      const batchesRes = await client.query(`
        SELECT * FROM inventory_batches
        WHERE product_id = $1 AND status = 'available' AND remaining_quantity > 0 AND expiry_date >= CURRENT_DATE
        ORDER BY expiry_date, id
        FOR UPDATE
      `, [product.id]);
      const batches = batchesRes.rows;

      const previous = batches.reduce((sum, batch) => sum + Number(batch.remaining_quantity), 0);
      const allowNegative = await negativeStockAllowed(req, client);
      if (parsed.data.quantity > previous && !allowNegative) {
        throw new Error('Transaction would create negative stock');
      }

      let remaining = parsed.data.quantity;
      let lastBatch = batches[0];

      for (const batch of batches) {
        if (remaining <= 0) break;
        const batchRem = Number(batch.remaining_quantity);
        const quantity = Math.min(remaining, batchRem);

        await client.query('UPDATE inventory_batches SET remaining_quantity = remaining_quantity - $1 WHERE id = $2', [quantity, batch.id]);

        await recordMovement({
          productId: product.id,
          batchId: batch.id,
          storeId,
          type: parsed.data.type,
          quantity,
          previousQuantity: previous - (parsed.data.quantity - remaining),
          updatedQuantity: previous - (parsed.data.quantity - remaining) - quantity,
          reason: parsed.data.reason,
          userId: req.user.id,
          transactionKey: remaining === parsed.data.quantity ? parsed.data.transaction_key : `${parsed.data.transaction_key}-${batch.id}`
        }, client);

        remaining -= quantity;
        lastBatch = batch;
      }

      if (remaining > 0) {
        if (!lastBatch) {
          const insertNegative = await client.query(`
            INSERT INTO inventory_batches (product_id, batch_number, expiry_date, remaining_quantity)
            VALUES ($1, $2, '2099-12-31', 0)
            RETURNING id
          `, [product.id, `NEGATIVE-${parsed.data.transaction_key}`]);
          lastBatch = { id: insertNegative.rows[0].id };
        }

        await client.query('UPDATE inventory_batches SET remaining_quantity = remaining_quantity - $1 WHERE id = $2', [remaining, lastBatch.id]);

        await recordMovement({
          productId: product.id,
          batchId: lastBatch.id,
          storeId,
          type: parsed.data.type,
          quantity: remaining,
          previousQuantity: 0,
          updatedQuantity: -remaining,
          reason: parsed.data.reason,
          userId: req.user.id,
          transactionKey: `${parsed.data.transaction_key}-negative`
        }, client);
      }

      await audit(req.user.id, parsed.data.type, 'inventory', product.id, parsed.data.reason, client);
      return { previous_stock: previous, updated_stock: previous - parsed.data.quantity };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.message === 'Duplicate stock transaction' ? 409 : 400).json({ error: error.message });
  }
});

app.post('/api/inventory/transfer', auth, role('admin', 'manager', 'inventory', 'stock_manager'), async (req, res) => {
  const parsed = z.object({
    product_id: z.number().int().positive(),
    destination_product_id: z.number().int().positive().optional(),
    destination_store_id: z.string().trim().min(2).optional(),
    quantity: z.number().positive(),
    reason: z.string().trim().min(3),
    transaction_key: z.string().trim().min(8).max(120)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Products, quantity, reason and transaction key are required' });

  try {
    const result = await withTransaction(async (client) => {
      const dupCheck = await client.query('SELECT id FROM stock_movements WHERE transaction_key = $1', [parsed.data.transaction_key]);
      if (dupCheck.rows.length > 0) throw new Error('Duplicate stock transaction');

      const sourceStore = storeFor(req);
      const destinationStore = parsed.data.destination_store_id || sourceStore;

      const srcRes = await client.query('SELECT id FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [parsed.data.product_id, sourceStore]);
      const destRes = await client.query('SELECT id, sku, purchase_price FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [parsed.data.destination_product_id || parsed.data.product_id, destinationStore]);

      if (srcRes.rows.length === 0 || destRes.rows.length === 0) throw new Error('Source or destination product not found');
      const source = srcRes.rows[0];
      const destination = destRes.rows[0];

      const batchRes = await client.query(`
        SELECT * FROM inventory_batches
        WHERE product_id = $1 AND status = 'available' AND remaining_quantity > 0 AND expiry_date >= CURRENT_DATE
        ORDER BY expiry_date, id LIMIT 1
        FOR UPDATE
      `, [source.id]);
      const batch = batchRes.rows[0];

      const prevRes = await client.query(
        "SELECT COALESCE(SUM(CASE WHEN expiry_date >= CURRENT_DATE THEN remaining_quantity ELSE 0 END), 0) AS stock FROM inventory_batches WHERE product_id = $1 AND status = 'available'",
        [source.id]
      );
      const previous = Number(prevRes.rows[0].stock);

      if (!batch || parsed.data.quantity > previous) throw new Error('Transfer would create negative stock');

      await client.query('UPDATE inventory_batches SET remaining_quantity = remaining_quantity - $1 WHERE id = $2', [parsed.data.quantity, batch.id]);

      await recordMovement({
        productId: source.id,
        batchId: batch.id,
        storeId: sourceStore,
        type: 'TRANSFER_OUT',
        quantity: parsed.data.quantity,
        previousQuantity: previous,
        updatedQuantity: previous - parsed.data.quantity,
        reason: parsed.data.reason,
        userId: req.user.id,
        transactionKey: parsed.data.transaction_key
      }, client);

      const destBatch = await client.query(`
        INSERT INTO inventory_batches (product_id, batch_number, expiry_date, received_quantity, remaining_quantity, purchase_price)
        VALUES ($1, $2, '2099-12-31', $3, $4, $5)
        RETURNING id
      `, [destination.id, `TRANSFER-${parsed.data.transaction_key}`, parsed.data.quantity, parsed.data.quantity, destination.purchase_price]);

      await recordMovement({
        productId: destination.id,
        batchId: destBatch.rows[0].id,
        storeId: destinationStore,
        type: 'TRANSFER_IN',
        quantity: parsed.data.quantity,
        previousQuantity: 0,
        updatedQuantity: parsed.data.quantity,
        referenceId: parsed.data.transaction_key,
        reason: parsed.data.reason,
        userId: req.user.id,
        transactionKey: `${parsed.data.transaction_key}-in`
      }, client);

      await audit(req.user.id, 'TRANSFER', 'inventory', source.id, parsed.data.reason, client);
      return { previous_stock: previous, updated_stock: previous - parsed.data.quantity, destination_store_id: destinationStore };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.message === 'Duplicate stock transaction' ? 409 : 400).json({ error: error.message });
  }
});

app.post('/api/inventory/adjust', auth, role('admin', 'manager', 'inventory', 'stock_manager'), async (req, res) => {
  const parsed = z.object({
    product_id: z.number().int().positive(),
    quantity: z.number().refine((value) => value !== 0),
    reason: z.string().trim().min(3),
    transaction_key: z.string().trim().min(8).max(120)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Product, non-zero quantity, reason and transaction key are required' });

  try {
    const result = await withTransaction(async (client) => {
      const dupCheck = await client.query('SELECT id FROM stock_movements WHERE transaction_key = $1', [parsed.data.transaction_key]);
      if (dupCheck.rows.length > 0) throw new Error('Duplicate stock transaction');

      const prodRes = await client.query('SELECT id, purchase_price FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [parsed.data.product_id, storeFor(req)]);
      if (prodRes.rows.length === 0) throw new Error('Product not found');
      const product = prodRes.rows[0];

      const prevRes = await client.query(
        "SELECT COALESCE(SUM(CASE WHEN expiry_date >= CURRENT_DATE THEN remaining_quantity ELSE 0 END), 0) AS stock FROM inventory_batches WHERE product_id = $1 AND status = 'available'",
        [product.id]
      );
      const previous = Number(prevRes.rows[0].stock);
      const updated = previous + parsed.data.quantity;

      const allowNegative = await negativeStockAllowed(req, client);
      if (updated < 0 && !allowNegative) throw new Error('Adjustment would create negative stock');

      let batchId = null;
      if (parsed.data.quantity > 0) {
        const createdBatch = await client.query(`
          INSERT INTO inventory_batches (product_id, batch_number, expiry_date, received_quantity, remaining_quantity, purchase_price)
          VALUES ($1, $2, '2099-12-31', $3, $4, $5)
          RETURNING id
        `, [product.id, `ADJUST-${parsed.data.transaction_key}`, parsed.data.quantity, parsed.data.quantity, product.purchase_price]);
        batchId = createdBatch.rows[0].id;
      } else {
        const batchRes = await client.query(`
          SELECT * FROM inventory_batches
          WHERE product_id = $1 AND status = 'available'
          ORDER BY expiry_date, id LIMIT 1
          FOR UPDATE
        `, [product.id]);
        if (batchRes.rows.length === 0) throw new Error('No available batch for stock adjustment');
        const batch = batchRes.rows[0];
        await client.query('UPDATE inventory_batches SET remaining_quantity = remaining_quantity + $1 WHERE id = $2', [parsed.data.quantity, batch.id]);
        batchId = batch.id;
      }

      const movement = await recordMovement({
        productId: product.id,
        batchId,
        storeId: storeFor(req),
        type: 'MANUAL_ADJUSTMENT',
        quantity: Math.abs(parsed.data.quantity),
        previousQuantity: previous,
        updatedQuantity: updated,
        reason: parsed.data.reason,
        userId: req.user.id,
        transactionKey: parsed.data.transaction_key
      }, client);

      await audit(req.user.id, 'ADJUST', 'inventory', product.id, parsed.data.reason, client);
      return { id: movement.id, previous_stock: previous, updated_stock: updated };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.message === 'Duplicate stock transaction' ? 409 : 400).json({ error: error.message });
  }
});

// ==============================================================================
// SUPPLIERS & PURCHASE ORDER ROUTES
// ==============================================================================

const supplierInput = z.object({
  supplier_code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().trim().min(2).max(120),
  contact_person: z.string().trim().max(120).default(''),
  phone: z.string().trim().min(7).max(25),
  email: z.string().trim().email(),
  address: z.string().trim().max(300).default(''),
  gstin: z.string().trim().max(20).default('')
});

app.get('/api/suppliers', auth, async (req, res) => {
  try {
    const list = await supplierList(req);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load suppliers' });
  }
});

app.get('/api/suppliers/:id', auth, async (req, res) => {
  try {
    const storeId = storeFor(req);
    const supRes = await pool.query(`
      SELECT s.*,
        COUNT(DISTINCT po.id) AS purchase_count,
        COALESCE(SUM(DISTINCT po.total), 0) AS purchase_value,
        COALESCE(SUM(DISTINCT CASE WHEN po.payment_status <> 'paid' THEN po.total ELSE 0 END), 0) AS outstanding_payable
      FROM suppliers s
      LEFT JOIN purchase_orders po ON po.supplier_id = s.id
      WHERE s.id = $1 AND s.store_id = $2
      GROUP BY s.id
    `, [req.params.id, storeId]);

    if (supRes.rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });
    const supplier = supRes.rows[0];

    const prodRes = await pool.query(`
      SELECT p.id, p.name, p.sku, p.unit
      FROM supplier_products sp
      JOIN products p ON p.id = sp.product_id
      WHERE sp.supplier_id = $1 AND sp.store_id = $2 AND sp.active = 1
      ORDER BY p.name
    `, [req.params.id, storeId]);

    const poRes = await pool.query(`
      SELECT po.id, po.order_number, po.status, po.payment_status, po.total, po.order_date, po.expected_date
      FROM purchase_orders po
      WHERE po.supplier_id = $1
      ORDER BY po.id DESC
    `, [req.params.id]);

    res.json({ ...supplier, products: prodRes.rows, purchases: poRes.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/suppliers', auth, role('admin', 'manager'), async (req, res) => {
  const parsed = supplierInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Supplier code, name, phone and email are required' });
  const value = parsed.data;

  const dupRes = await pool.query(
    'SELECT id FROM suppliers WHERE store_id = $1 AND (LOWER(supplier_code) = LOWER($2) OR LOWER(name) = LOWER($3))',
    [storeFor(req), value.supplier_code, value.name]
  );
  if (dupRes.rows.length > 0) return res.status(409).json({ error: 'Supplier code or name already exists' });

  try {
    const insertRes = await pool.query(`
      INSERT INTO suppliers (supplier_code, name, contact_person, phone, email, address, gstin, store_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [value.supplier_code, value.name, value.contact_person, value.phone, value.email, value.address, value.gstin, storeFor(req)]);

    const id = insertRes.rows[0].id;
    await audit(req.user.id, 'CREATE', 'supplier', id, value.name);
    res.status(201).json({ id });
  } catch (error) {
    const isUnique = error.code === '23505' || error.message.includes('unique');
    res.status(409).json({ error: isUnique ? 'Supplier code or name already exists' : 'Unable to create supplier' });
  }
});

app.patch('/api/suppliers/:id', auth, role('admin', 'manager'), async (req, res) => {
  const parsed = supplierInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Supplier code, name, phone and email are required' });
  const value = parsed.data;

  const existRes = await pool.query('SELECT id FROM suppliers WHERE id = $1 AND store_id = $2', [req.params.id, storeFor(req)]);
  if (existRes.rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });

  const dupRes = await pool.query(
    'SELECT id FROM suppliers WHERE store_id = $1 AND id <> $2 AND (LOWER(supplier_code) = LOWER($3) OR LOWER(name) = LOWER($4))',
    [storeFor(req), req.params.id, value.supplier_code, value.name]
  );
  if (dupRes.rows.length > 0) return res.status(409).json({ error: 'Supplier code or name already exists' });

  try {
    await pool.query(`
      UPDATE suppliers
      SET supplier_code = $1, name = $2, contact_person = $3, phone = $4, email = $5, address = $6, gstin = $7
      WHERE id = $8 AND store_id = $9
    `, [value.supplier_code, value.name, value.contact_person, value.phone, value.email, value.address, value.gstin, req.params.id, storeFor(req)]);

    await audit(req.user.id, 'UPDATE', 'supplier', req.params.id, value.name);
    res.json({ ok: true });
  } catch (error) {
    res.status(409).json({ error: 'Unable to update supplier' });
  }
});

app.delete('/api/suppliers/:id', auth, role('admin', 'manager'), async (req, res) => {
  const existRes = await pool.query('SELECT id, name FROM suppliers WHERE id = $1 AND store_id = $2 AND active = 1', [req.params.id, storeFor(req)]);
  if (existRes.rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });
  const supplier = existRes.rows[0];

  await pool.query('UPDATE suppliers SET active = 0 WHERE id = $1 AND store_id = $2', [req.params.id, storeFor(req)]);
  await audit(req.user.id, 'ARCHIVE', 'supplier', req.params.id, supplier.name);
  res.json({ ok: true });
});

app.post('/api/suppliers/:id/products', auth, role('admin', 'manager'), async (req, res) => {
  const parsed = z.object({ product_id: z.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A valid product is required' });

  const supRes = await pool.query('SELECT id FROM suppliers WHERE id = $1 AND store_id = $2 AND active = 1', [req.params.id, storeFor(req)]);
  const prodRes = await pool.query('SELECT id FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [parsed.data.product_id, storeFor(req)]);
  if (supRes.rows.length === 0 || prodRes.rows.length === 0) return res.status(404).json({ error: 'Supplier or product not found' });

  try {
    const insertRes = await pool.query(
      'INSERT INTO supplier_products (supplier_id, product_id, store_id) VALUES ($1, $2, $3) RETURNING id',
      [req.params.id, parsed.data.product_id, storeFor(req)]
    );
    const id = insertRes.rows[0].id;
    await audit(req.user.id, 'MAP', 'supplier_product', id, `${req.params.id}:${parsed.data.product_id}`);
    res.status(201).json({ id });
  } catch (error) {
    res.status(409).json({ error: 'Product is already mapped to this supplier' });
  }
});

const purchaseInput = z.object({
  supplier_id: z.number().int().positive(),
  expected_date: z.string().optional(),
  discount: z.number().nonnegative().default(0),
  transaction_key: z.string().trim().min(8).max(120),
  items: z.array(z.object({
    product_id: z.number().int().positive(),
    quantity: z.number().positive(),
    unit_price: z.number().nonnegative(),
    gst_rate: z.number().min(0).max(28).default(5)
  })).min(1)
});

app.get('/api/purchases', auth, async (req, res) => {
  try {
    const rows = await queryMany(`
      SELECT po.*, s.name AS supplier_name
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.store_id = $1
      ORDER BY po.id DESC
    `, [storeFor(req)]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/purchases/:id', auth, async (req, res) => {
  try {
    const poRes = await pool.query(`
      SELECT po.*, s.name AS supplier_name
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.id = $1 AND po.store_id = $2
    `, [req.params.id, storeFor(req)]);

    if (poRes.rows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
    const order = poRes.rows[0];

    const itemsRes = await pool.query(`
      SELECT pi.*, p.name, p.sku
      FROM purchase_items pi
      JOIN products p ON p.id = pi.product_id
      WHERE pi.purchase_order_id = $1
    `, [order.id]);

    res.json({ ...order, items: itemsRes.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/purchases', auth, role('admin', 'manager', 'inventory'), async (req, res) => {
  const parsed = purchaseInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Supplier, transaction key and purchase items are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      const value = parsed.data;
      const dupCheck = await client.query('SELECT id FROM purchase_orders WHERE transaction_key = $1', [value.transaction_key]);
      if (dupCheck.rows.length > 0) throw new Error('Duplicate purchase submission');

      const supRes = await client.query('SELECT id FROM suppliers WHERE id = $1 AND store_id = $2 AND active = 1', [value.supplier_id, storeId]);
      if (supRes.rows.length === 0) throw new Error('Supplier not found');

      for (const item of value.items) {
        const prodRes = await client.query('SELECT id FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [item.product_id, storeId]);
        if (prodRes.rows.length === 0) throw new Error('Product not found');
      }

      const subtotal = value.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      const tax = value.items.reduce((sum, item) => sum + item.quantity * item.unit_price * item.gst_rate / 100, 0);
      const total = Math.max(0, subtotal + tax - value.discount);

      const countRes = await client.query('SELECT COUNT(*) AS count FROM purchase_orders');
      const orderNumber = `PO-${new Date().getFullYear()}-${String(Number(countRes.rows[0].count) + 1).padStart(4, '0')}`;

      const orderInsert = await client.query(`
        INSERT INTO purchase_orders (order_number, supplier_id, status, payment_status, subtotal, tax, discount, total, expected_date, store_id, transaction_key)
        VALUES ($1, $2, 'approved', 'unpaid', $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `, [orderNumber, value.supplier_id, subtotal, tax, value.discount, total, value.expected_date || null, storeId, value.transaction_key]);

      const orderId = orderInsert.rows[0].id;

      for (const item of value.items) {
        await client.query(`
          INSERT INTO purchase_items (purchase_order_id, product_id, quantity, unit_price, gst_rate)
          VALUES ($1, $2, $3, $4, $5)
        `, [orderId, item.product_id, item.quantity, item.unit_price, item.gst_rate]);
      }

      await audit(req.user.id, 'CREATE', 'purchase_order', orderId, orderNumber, client);
      return { id: orderId, order_number: orderNumber, subtotal, tax, discount: value.discount, total };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.message === 'Duplicate purchase submission' ? 409 : 400).json({ error: error.message });
  }
});

app.post('/api/purchases/:id/receive', auth, role('admin', 'manager', 'inventory'), async (req, res) => {
  const parsed = z.object({
    transaction_key: z.string().trim().min(8).max(120),
    items: z.array(z.object({
      product_id: z.number().int().positive(),
      received_quantity: z.number().positive(),
      batch_number: z.string().trim().min(1),
      manufacturing_date: z.string().optional(),
      expiry_date: z.string().optional(),
      purchase_price: z.number().nonnegative()
    })).min(1)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Receipt transaction key and batch details are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      const dupCheck = await client.query('SELECT id FROM stock_movements WHERE transaction_key = $1', [parsed.data.transaction_key]);
      if (dupCheck.rows.length > 0) throw new Error('Duplicate receipt submission');

      const poRes = await client.query('SELECT * FROM purchase_orders WHERE id = $1 AND store_id = $2 FOR UPDATE', [req.params.id, storeId]);
      if (poRes.rows.length === 0) throw new Error('Purchase order not found');
      const order = poRes.rows[0];

      if (order.status === 'cancelled' || order.status === 'received') throw new Error('Purchase order cannot be received again');

      for (const item of parsed.data.items) {
        const itemRes = await client.query(
          'SELECT * FROM purchase_items WHERE purchase_order_id = $1 AND product_id = $2 FOR UPDATE',
          [order.id, item.product_id]
        );
        const ordered = itemRes.rows[0];
        if (!ordered || Number(ordered.received_quantity) + item.received_quantity > Number(ordered.quantity)) {
          throw new Error('Received quantity exceeds ordered quantity');
        }

        const prevRes = await client.query(
          "SELECT COALESCE(SUM(CASE WHEN expiry_date >= CURRENT_DATE THEN remaining_quantity ELSE 0 END), 0) AS stock FROM inventory_batches WHERE product_id = $1 AND status = 'available'",
          [item.product_id]
        );
        const previous = Number(prevRes.rows[0].stock);

        const batchRes = await client.query(`
          INSERT INTO inventory_batches (product_id, supplier_id, batch_number, manufacturing_date, expiry_date, received_quantity, remaining_quantity, purchase_price)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `, [item.product_id, order.supplier_id, item.batch_number, item.manufacturing_date || null, item.expiry_date || '2099-12-31', item.received_quantity, item.received_quantity, item.purchase_price]);

        await recordMovement({
          productId: item.product_id,
          batchId: batchRes.rows[0].id,
          storeId,
          type: 'PURCHASE_IN',
          quantity: item.received_quantity,
          previousQuantity: previous,
          updatedQuantity: previous + item.received_quantity,
          referenceId: order.order_number,
          reason: 'Purchase receipt',
          userId: req.user.id,
          transactionKey: parsed.data.transaction_key
        }, client);

        await client.query(
          'UPDATE purchase_items SET received_quantity = received_quantity + $1 WHERE purchase_order_id = $2 AND product_id = $3',
          [item.received_quantity, order.id, item.product_id]
        );
      }

      const remRes = await client.query(
        'SELECT COUNT(*) AS count FROM purchase_items WHERE purchase_order_id = $1 AND received_quantity < quantity',
        [order.id]
      );
      const remainingCount = Number(remRes.rows[0].count);

      await client.query("UPDATE purchase_orders SET status = $1 WHERE id = $2", [remainingCount > 0 ? 'partially_received' : 'received', order.id]);
      await audit(req.user.id, 'RECEIVE', 'purchase_order', order.id, order.order_number, client);

      return { order_id: order.id, status: remainingCount > 0 ? 'partially_received' : 'received' };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.message === 'Duplicate receipt submission' ? 409 : 400).json({ error: error.message });
  }
});

// ==============================================================================
// SALES & POS CHECKOUT ROUTES
// ==============================================================================

const saleInput = z.object({
  customer_id: z.number().int().positive().nullable().optional(),
  payment_method: z.enum(['cash', 'upi', 'card', 'split']),
  payment_status: z.enum(['paid', 'pending', 'partial']).default('paid'),
  discount: z.number().nonnegative().default(0),
  transaction_key: z.string().trim().min(8).max(120).optional().default(() => `ui-sale-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  items: z.array(z.object({
    product_id: z.number().int().positive(),
    quantity: z.number().positive()
  })).min(1)
});

app.post('/api/sales', auth, async (req, res) => {
  const parsed = saleInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payment, transaction key and sale items are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      const value = parsed.data;
      const dupCheck = await client.query('SELECT id FROM sales WHERE transaction_key = $1', [value.transaction_key]);
      if (dupCheck.rows.length > 0) throw new Error('Duplicate sale submission');

      const lineItems = [];
      for (const item of value.items) {
        const prodRes = await client.query('SELECT * FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [item.product_id, storeId]);
        if (prodRes.rows.length === 0) throw new Error('Product not found');
        const product = prodRes.rows[0];

        // FEFO Row Locking: Select earliest expiring batches FOR UPDATE to prevent race conditions
        const batchesRes = await client.query(`
          SELECT * FROM inventory_batches
          WHERE product_id = $1 AND remaining_quantity > 0 AND status = 'available' AND expiry_date >= CURRENT_DATE
          ORDER BY expiry_date, id
          FOR UPDATE
        `, [product.id]);
        const batches = batchesRes.rows;

        let remaining = item.quantity;
        for (const batch of batches) {
          if (remaining <= 0) break;
          const batchRem = Number(batch.remaining_quantity);
          const quantity = Math.min(remaining, batchRem);
          lineItems.push({ product, batch, quantity });
          remaining -= quantity;
        }

        if (remaining > 0) {
          throw new Error(`${product.name} does not have enough unexpired stock`);
        }
      }

      const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * Number(item.product.selling_price), 0);
      const tax = lineItems.reduce((sum, item) => sum + item.quantity * Number(item.product.selling_price) * Number(item.product.gst_rate) / 100, 0);
      const total = Math.max(0, subtotal + tax - value.discount);
      const invoiceNumber = await nextInvoice(client);

      const saleInsert = await client.query(`
        INSERT INTO sales (invoice_number, customer_id, subtotal, tax, discount, total, payment_method, payment_status, status, cashier_id, store_id, transaction_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9, $10, $11)
        RETURNING id
      `, [invoiceNumber, value.customer_id || null, subtotal, tax, value.discount, total, value.payment_method, value.payment_status, Number(req.user.id) || null, storeId, value.transaction_key]);

      const saleId = saleInsert.rows[0].id;

      for (const item of lineItems) {
        const lineTotal = item.quantity * Number(item.product.selling_price);
        await client.query(`
          INSERT INTO sale_items (sale_id, product_id, batch_id, quantity, unit_price, gst_rate, line_total)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [saleId, item.product.id, item.batch.id, item.quantity, item.product.selling_price, item.product.gst_rate, lineTotal]);

        const previous = Number(item.batch.remaining_quantity);
        await client.query('UPDATE inventory_batches SET remaining_quantity = remaining_quantity - $1 WHERE id = $2', [item.quantity, item.batch.id]);

        await recordMovement({
          productId: item.product.id,
          batchId: item.batch.id,
          storeId,
          type: 'SALE_OUT',
          quantity: item.quantity,
          previousQuantity: previous,
          updatedQuantity: previous - item.quantity,
          referenceId: invoiceNumber,
          reason: 'Sale',
          userId: req.user.id,
          transactionKey: `${value.transaction_key}-${item.product.id}-${item.batch.id}`
        }, client);
      }

      await client.query(`
        INSERT INTO payments (sale_id, method, amount, status, store_id)
        VALUES ($1, $2, $3, $4, $5)
      `, [saleId, value.payment_method, total, value.payment_status, storeId]);

      await audit(req.user.id, 'CREATE', 'sale', saleId, `Invoice ${invoiceNumber}`, client);
      return { id: saleId, invoice_number: invoiceNumber, subtotal, tax, discount: value.discount, total, payment_status: value.payment_status };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.message === 'Duplicate sale submission' ? 409 : 400).json({ error: error.message });
  }
});

app.get('/api/sales', auth, async (req, res) => {
  try {
    const rows = await queryMany(`
      SELECT s.*, c.name AS customer_name, u.name AS cashier_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN users u ON u.id = s.cashier_id
      WHERE s.store_id = $1
      ORDER BY s.id DESC LIMIT 100
    `, [storeFor(req)]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sales/:id', auth, async (req, res) => {
  try {
    const saleRes = await pool.query(`
      SELECT s.*, c.name AS customer_name, u.name AS cashier_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN users u ON u.id = s.cashier_id
      WHERE s.id = $1 AND s.store_id = $2
    `, [req.params.id, storeFor(req)]);

    if (saleRes.rows.length === 0) return res.status(404).json({ error: 'Sale not found' });
    const sale = saleRes.rows[0];

    const itemsRes = await pool.query(`
      SELECT si.*, p.name, p.sku
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1
    `, [sale.id]);

    res.json({ ...sale, items: itemsRes.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sales/:id/return', auth, role('admin', 'manager', 'cashier'), async (req, res) => {
  const parsed = z.object({
    transaction_key: z.string().trim().min(8).max(120),
    items: z.array(z.object({
      sale_item_id: z.number().int().positive(),
      quantity: z.number().positive()
    })).min(1)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Return transaction key and items are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      const dupCheck = await client.query('SELECT id FROM sale_returns WHERE transaction_key = $1', [parsed.data.transaction_key]);
      if (dupCheck.rows.length > 0) throw new Error('Duplicate return submission');

      const saleRes = await client.query("SELECT * FROM sales WHERE id = $1 AND store_id = $2 AND status <> 'cancelled'", [req.params.id, storeId]);
      if (saleRes.rows.length === 0) throw new Error('Sale not found');
      const sale = saleRes.rows[0];

      for (const item of parsed.data.items) {
        const itemRes = await client.query('SELECT * FROM sale_items WHERE id = $1 AND sale_id = $2', [item.sale_item_id, sale.id]);
        const saleItem = itemRes.rows[0];

        const retRes = await client.query('SELECT COALESCE(SUM(quantity), 0) AS quantity FROM sale_returns WHERE sale_item_id = $1', [item.sale_item_id]);
        const returned = Number(retRes.rows[0].quantity);

        if (!saleItem || returned + item.quantity > Number(saleItem.quantity)) {
          throw new Error('Return quantity exceeds the remaining sale quantity');
        }

        const batchRes = await client.query('SELECT remaining_quantity FROM inventory_batches WHERE id = $1 FOR UPDATE', [saleItem.batch_id]);
        const batch = batchRes.rows[0];
        const prevStock = Number(batch.remaining_quantity);

        await client.query('UPDATE inventory_batches SET remaining_quantity = remaining_quantity + $1 WHERE id = $2', [item.quantity, saleItem.batch_id]);

        await client.query(`
          INSERT INTO sale_returns (sale_id, sale_item_id, quantity, store_id, transaction_key)
          VALUES ($1, $2, $3, $4, $5)
        `, [sale.id, item.sale_item_id, item.quantity, storeId, `${parsed.data.transaction_key}-${item.sale_item_id}`]);

        await recordMovement({
          productId: saleItem.product_id,
          batchId: saleItem.batch_id,
          storeId,
          type: 'SALE_RETURN_IN',
          quantity: item.quantity,
          previousQuantity: prevStock,
          updatedQuantity: prevStock + item.quantity,
          referenceId: sale.invoice_number,
          reason: 'Sale return',
          userId: req.user.id,
          transactionKey: `${parsed.data.transaction_key}-${item.sale_item_id}-movement`
        }, client);
      }

      await audit(req.user.id, 'RETURN', 'sale', sale.id, sale.invoice_number, client);
      return { sale_id: sale.id, status: 'returned' };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.message === 'Duplicate return submission' ? 409 : 400).json({ error: error.message });
  }
});

app.post('/api/sales/:id/cancel', auth, role('admin', 'manager'), async (req, res) => {
  const parsed = z.object({
    transaction_key: z.string().trim().min(8).max(120),
    reason: z.string().trim().min(3)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Cancellation transaction key and reason are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      const dupCheck = await client.query('SELECT id FROM sale_reversals WHERE transaction_key = $1', [parsed.data.transaction_key]);
      if (dupCheck.rows.length > 0) throw new Error('Duplicate cancellation submission');

      const saleRes = await client.query("SELECT * FROM sales WHERE id = $1 AND store_id = $2 AND status = 'completed' FOR UPDATE", [req.params.id, storeId]);
      if (saleRes.rows.length === 0) throw new Error('Only completed sales can be cancelled');
      const sale = saleRes.rows[0];

      const itemsRes = await client.query('SELECT * FROM sale_items WHERE sale_id = $1', [sale.id]);

      for (const item of itemsRes.rows) {
        const batchRes = await client.query('SELECT remaining_quantity FROM inventory_batches WHERE id = $1 FOR UPDATE', [item.batch_id]);
        const batch = batchRes.rows[0];
        const prevStock = Number(batch.remaining_quantity);

        await client.query('UPDATE inventory_batches SET remaining_quantity = remaining_quantity + $1 WHERE id = $2', [item.quantity, item.batch_id]);

        await recordMovement({
          productId: item.product_id,
          batchId: item.batch_id,
          storeId,
          type: 'SALE_CANCEL_IN',
          quantity: item.quantity,
          previousQuantity: prevStock,
          updatedQuantity: prevStock + Number(item.quantity),
          referenceId: sale.invoice_number,
          reason: parsed.data.reason,
          userId: req.user.id,
          transactionKey: `${parsed.data.transaction_key}-${item.id}`
        }, client);
      }

      await client.query(`
        INSERT INTO sale_reversals (sale_id, store_id, transaction_key, reason)
        VALUES ($1, $2, $3, $4)
      `, [sale.id, storeId, parsed.data.transaction_key, parsed.data.reason]);

      await client.query("UPDATE sales SET status = 'cancelled', payment_status = 'refunded' WHERE id = $1", [sale.id]);
      await audit(req.user.id, 'CANCEL', 'sale', sale.id, parsed.data.reason, client);

      return { sale_id: sale.id, status: 'cancelled' };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(error.message === 'Duplicate cancellation submission' ? 409 : 400).json({ error: error.message });
  }
});

// ==============================================================================
// CUSTOMERS ROUTES
// ==============================================================================

app.get('/api/customers', auth, async (req, res) => {
  try {
    const storeId = storeFor(req);
    const rows = await queryMany(`
      SELECT c.*, COUNT(s.id) AS purchase_count, COALESCE(SUM(s.total), 0) AS lifetime_value
      FROM customers c
      LEFT JOIN sales s ON s.customer_id = c.id AND s.store_id = $1 AND s.status = 'completed'
      GROUP BY c.id
      ORDER BY c.name
    `, [storeId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/customers', auth, async (req, res) => {
  const parsed = z.object({
    name: z.string().min(2),
    phone: z.string().optional(),
    email: z.string().email().optional()
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Customer name is required' });

  try {
    const insertRes = await pool.query(
      'INSERT INTO customers (name, phone, email) VALUES ($1, $2, $3) RETURNING id',
      [parsed.data.name, parsed.data.phone || '', parsed.data.email || '']
    );
    res.status(201).json({ id: insertRes.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==============================================================================
// LEGACY COMPATIBILITY ROUTES (DEPRECATED)
// ==============================================================================

app.get('/api/purchases-legacy', auth, async (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  const rows = await queryMany(`
    SELECT po.*, s.name AS supplier_name
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.store_id = $1
    ORDER BY po.id DESC
  `, [storeFor(req)]);
  res.json(rows);
});

app.post('/api/purchases-legacy', auth, role('admin', 'manager', 'inventory'), async (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  const parsed = z.object({
    supplier_id: z.number().int(),
    expected_date: z.string().optional(),
    items: z.array(z.object({
      product_id: z.number().int(),
      quantity: z.number().positive(),
      unit_price: z.number().nonnegative(),
      gst_rate: z.number().min(0).max(28).default(5)
    })).min(1)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Supplier and purchase items are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      const countRes = await client.query('SELECT COUNT(*) AS count FROM purchase_orders');
      const orderNumber = `PO-${new Date().getFullYear()}-${String(Number(countRes.rows[0].count) + 41).padStart(3, '0')}`;
      const total = parsed.data.items.reduce((sum, item) => sum + item.quantity * item.unit_price * (1 + item.gst_rate / 100), 0);

      const orderInsert = await client.query(`
        INSERT INTO purchase_orders (order_number, supplier_id, status, total, expected_date, store_id)
        VALUES ($1, $2, 'approved', $3, $4, $5)
        RETURNING id
      `, [orderNumber, parsed.data.supplier_id, total, parsed.data.expected_date || null, storeId]);

      const orderId = orderInsert.rows[0].id;
      for (const item of parsed.data.items) {
        await client.query(`
          INSERT INTO purchase_items (purchase_order_id, product_id, quantity, unit_price, gst_rate)
          VALUES ($1, $2, $3, $4, $5)
        `, [orderId, item.product_id, item.quantity, item.unit_price, item.gst_rate]);
      }

      await audit(req.user.id, 'CREATE', 'purchase_order', orderId, orderNumber, client);
      return { id: orderId, orderNumber };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/purchases/:id/receive-legacy', auth, role('admin', 'manager', 'inventory'), async (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  const parsed = z.object({
    items: z.array(z.object({
      product_id: z.number().int(),
      received_quantity: z.number().positive(),
      batch_number: z.string().min(1),
      manufacturing_date: z.string().optional(),
      expiry_date: z.string().optional(),
      purchase_price: z.number().nonnegative()
    })).min(1)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Received batch details are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      const poRes = await client.query('SELECT * FROM purchase_orders WHERE id = $1 AND store_id = $2 FOR UPDATE', [req.params.id, storeId]);
      if (poRes.rows.length === 0) throw new Error('Purchase order not found');
      const order = poRes.rows[0];

      for (const item of parsed.data.items) {
        const prevRes = await client.query(
          "SELECT COALESCE(SUM(CASE WHEN expiry_date >= CURRENT_DATE THEN remaining_quantity ELSE 0 END), 0) AS stock FROM inventory_batches WHERE product_id = $1 AND status = 'available'",
          [item.product_id]
        );
        const previous = Number(prevRes.rows[0].stock);

        const batchRes = await client.query(`
          INSERT INTO inventory_batches (product_id, supplier_id, batch_number, manufacturing_date, expiry_date, received_quantity, remaining_quantity, purchase_price)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `, [item.product_id, order.supplier_id, item.batch_number, item.manufacturing_date || null, item.expiry_date || null, item.received_quantity, item.received_quantity, item.purchase_price]);

        await recordMovement({
          productId: item.product_id,
          batchId: batchRes.rows[0].id,
          storeId,
          type: 'PURCHASE_IN',
          quantity: item.received_quantity,
          previousQuantity: previous,
          updatedQuantity: previous + item.received_quantity,
          referenceId: order.order_number,
          reason: 'Goods received (legacy)',
          userId: req.user.id
        }, client);

        await client.query(
          'UPDATE purchase_items SET received_quantity = received_quantity + $1 WHERE purchase_order_id = $2 AND product_id = $3',
          [item.received_quantity, order.id, item.product_id]
        );
      }

      await client.query("UPDATE purchase_orders SET status = 'received' WHERE id = $1", [order.id]);
      await audit(req.user.id, 'RECEIVE', 'purchase_order', order.id, order.order_number, client);
      return { orderId: order.id, status: 'received' };
    });

    res.json(result);
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

app.post('/api/sales-legacy', auth, async (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  const parsed = z.object({
    customer_id: z.number().int().nullable().optional(),
    payment_method: z.enum(['cash', 'upi', 'card', 'split']),
    discount: z.number().nonnegative().default(0),
    items: z.array(z.object({ product_id: z.number().int(), quantity: z.number().positive() })).min(1)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Payment method and sale items are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      const lineItems = [];
      for (const item of parsed.data.items) {
        const prodRes = await client.query('SELECT * FROM products WHERE id = $1 AND store_id = $2 AND active = 1', [item.product_id, storeId]);
        if (prodRes.rows.length === 0) throw new Error('Product not found');
        const product = prodRes.rows[0];

        const batchesRes = await client.query(`
          SELECT * FROM inventory_batches
          WHERE product_id = $1 AND remaining_quantity > 0 AND status = 'available' AND expiry_date >= CURRENT_DATE
          ORDER BY expiry_date, id
          FOR UPDATE
        `, [item.product_id]);
        const batches = batchesRes.rows;

        let remaining = item.quantity;
        for (const batch of batches) {
          if (remaining <= 0) break;
          const batchRem = Number(batch.remaining_quantity);
          const quantity = Math.min(remaining, batchRem);
          lineItems.push({ product, batch, quantity });
          remaining -= quantity;
        }
        if (remaining > 0) throw new Error(`${product.name} does not have enough unexpired stock`);
      }

      const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * Number(item.product.selling_price), 0);
      const tax = lineItems.reduce((sum, item) => sum + item.quantity * Number(item.product.selling_price) * Number(item.product.gst_rate) / 100, 0);
      const total = Math.max(0, subtotal + tax - parsed.data.discount);
      const invoiceNumber = await nextInvoice(client);

      const saleInsert = await client.query(`
        INSERT INTO sales (invoice_number, customer_id, subtotal, tax, discount, total, payment_method, cashier_id, store_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `, [invoiceNumber, parsed.data.customer_id || null, subtotal, tax, parsed.data.discount, total, parsed.data.payment_method, Number(req.user.id) || null, storeId]);

      const saleId = saleInsert.rows[0].id;

      for (const item of lineItems) {
        const lineTotal = item.quantity * Number(item.product.selling_price);
        await client.query(`
          INSERT INTO sale_items (sale_id, product_id, batch_id, quantity, unit_price, gst_rate, line_total)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [saleId, item.product.id, item.batch.id, item.quantity, item.product.selling_price, item.product.gst_rate, lineTotal]);

        const previous = Number(item.batch.remaining_quantity);
        await client.query('UPDATE inventory_batches SET remaining_quantity = remaining_quantity - $1 WHERE id = $2', [item.quantity, item.batch.id]);

        await recordMovement({
          productId: item.product.id,
          batchId: item.batch.id,
          storeId,
          type: 'SALE_OUT',
          quantity: item.quantity,
          previousQuantity: previous,
          updatedQuantity: previous - item.quantity,
          referenceId: String(saleId),
          reason: 'POS sale (legacy)',
          userId: req.user.id
        }, client);
      }

      await client.query('INSERT INTO payments (sale_id, method, amount, store_id) VALUES ($1, $2, $3, $4)', [saleId, parsed.data.payment_method, total, storeId]);
      await audit(req.user.id, 'CREATE', 'sale', saleId, `Invoice ${invoiceNumber}`, client);

      return { id: saleId, invoice_number: invoiceNumber, subtotal, tax, total };
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

app.get('/api/sales-legacy', auth, async (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  const rows = await queryMany(`
    SELECT s.*, c.name AS customer_name, u.name AS cashier_name
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.cashier_id
    WHERE s.store_id = $1
    ORDER BY s.id DESC LIMIT 100
  `, [storeFor(req)]);
  res.json(rows);
});

app.post('/api/sales/:id/return-legacy', auth, role('admin', 'manager', 'cashier'), async (req, res) => {
  res.setHeader('X-Deprecated', 'true');
  const parsed = z.object({
    items: z.array(z.object({ sale_item_id: z.number().int(), quantity: z.number().positive() })).min(1)
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Return items are required' });

  try {
    const storeId = storeFor(req);
    const result = await withTransaction(async (client) => {
      for (const item of parsed.data.items) {
        const itemRes = await client.query(`
          SELECT si.* FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE si.id = $1 AND si.sale_id = $2 AND s.store_id = $3
        `, [item.sale_item_id, req.params.id, storeId]);
        const saleItem = itemRes.rows[0];

        if (!saleItem || item.quantity > Number(saleItem.quantity)) throw new Error('Return quantity exceeds the original sale');

        const batchRes = await client.query('SELECT remaining_quantity FROM inventory_batches WHERE id = $1 FOR UPDATE', [saleItem.batch_id]);
        const batch = batchRes.rows[0];
        const prevStock = Number(batch.remaining_quantity);

        await client.query('UPDATE inventory_batches SET remaining_quantity = remaining_quantity + $1 WHERE id = $2', [item.quantity, saleItem.batch_id]);

        await recordMovement({
          productId: saleItem.product_id,
          batchId: saleItem.batch_id,
          storeId,
          type: 'SALE_RETURN_IN',
          quantity: item.quantity,
          previousQuantity: prevStock,
          updatedQuantity: prevStock + item.quantity,
          referenceId: req.params.id,
          reason: 'Customer return (legacy)',
          userId: req.user.id
        }, client);
      }

      await audit(req.user.id, 'RETURN', 'sale', req.params.id, 'Legacy sale return', client);
      return { saleId: req.params.id, status: 'returned' };
    });

    res.json(result);
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

// ==============================================================================
// NOTIFICATIONS & REPORTS ROUTES
// ==============================================================================

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const storeId = storeFor(req);
    await syncAlerts(storeId);
    const conditions = ['store_id = $1', 'dismissed = 0'];
    const params = [storeId];
    let paramIdx = 2;

    if (req.query.type) {
      conditions.push(`type = $${paramIdx}`);
      params.push(req.query.type);
      paramIdx++;
    }
    if (req.query.read === 'unread') conditions.push('read = 0');
    if (req.query.read === 'read') conditions.push('read = 1');

    const rows = await queryMany(`
      SELECT * FROM notifications
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
    `, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    const result = await pool.query('UPDATE notifications SET read = 1 WHERE id = $1 AND store_id = $2', [req.params.id, storeFor(req)]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/notifications/:id', auth, async (req, res) => {
  try {
    const result = await pool.query('UPDATE notifications SET dismissed = 1, read = 1 WHERE id = $1 AND store_id = $2', [req.params.id, storeFor(req)]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/sales', auth, role('admin', 'manager'), async (req, res) => {
  try {
    const storeId = storeFor(req);
    const from = req.query.from || '2000-01-01';
    const to = req.query.to || '2999-12-31';

    const sumRes = await pool.query(`
      SELECT COUNT(*) AS bills,
        COALESCE(SUM(subtotal), 0) AS subtotal,
        COALESCE(SUM(tax), 0) AS tax,
        COALESCE(SUM(total), 0) AS revenue
      FROM sales
      WHERE created_at::date BETWEEN $1::date AND $2::date
        AND status = 'completed' AND store_id = $3
    `, [from, to, storeId]);

    const payRes = await pool.query(`
      SELECT payment_method, COUNT(*) AS bills, SUM(total) AS amount
      FROM sales
      WHERE created_at::date BETWEEN $1::date AND $2::date
        AND status = 'completed' AND store_id = $3
      GROUP BY payment_method
    `, [from, to, storeId]);

    res.json({ from, to, summary: sumRes.rows[0], byPayment: payRes.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/sales-trend', auth, async (req, res) => {
  try {
    const storeId = storeFor(req);
    const days = req.query.period === 'monthly' ? 30 : 7;
    const rowsRes = await pool.query(`
      SELECT created_at::date AS date, COALESCE(SUM(total), 0) AS revenue
      FROM sales
      WHERE status = 'completed' AND store_id = $1
        AND created_at::date >= (CURRENT_DATE - ($2 || ' days')::interval)
      GROUP BY created_at::date
      ORDER BY created_at::date
    `, [storeId, days - 1]);

    res.json({ days, rows: rowsRes.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/profit-loss', auth, role('admin', 'manager'), async (req, res) => {
  try {
    const storeId = storeFor(req);
    const from = req.query.from || '2000-01-01';
    const to = req.query.to || '2999-12-31';

    const rowRes = await pool.query(`
      SELECT COALESCE(SUM(si.line_total), 0) AS revenue,
        COALESCE(SUM(si.quantity * p.purchase_price), 0) AS cost,
        COALESCE(SUM(si.line_total - (si.quantity * p.purchase_price)), 0) AS gross_profit
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      WHERE s.created_at::date BETWEEN $1::date AND $2::date
        AND s.status = 'completed' AND s.store_id = $3
    `, [from, to, storeId]);

    res.json(rowRes.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/inventory-valuation', auth, role('admin', 'manager'), async (req, res) => {
  try {
    const storeId = storeFor(req);
    const valRes = await pool.query(`
      SELECT COALESCE(SUM(b.remaining_quantity * b.purchase_price), 0) AS purchase_value,
        COALESCE(SUM(b.remaining_quantity * p.selling_price), 0) AS retail_value
      FROM inventory_batches b
      JOIN products p ON p.id = b.product_id
      WHERE b.remaining_quantity > 0 AND p.store_id = $1
    `, [storeId]);
    res.json(valRes.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/expiry', auth, async (req, res) => {
  try {
    const storeId = storeFor(req);
    const expRes = await pool.query(`
      SELECT p.name, p.sku, b.batch_number, b.expiry_date, b.remaining_quantity,
        CASE WHEN b.expiry_date < CURRENT_DATE THEN 'expired' ELSE 'near_expiry' END AS status
      FROM inventory_batches b
      JOIN products p ON p.id = b.product_id
      WHERE b.remaining_quantity > 0 AND p.store_id = $1
      ORDER BY b.expiry_date
    `, [storeId]);
    res.json(expRes.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/export.csv', auth, role('admin', 'manager'), async (req, res) => {
  try {
    const storeId = storeFor(req);
    const rowsRes = await pool.query(
      'SELECT invoice_number, subtotal, tax, total, payment_method, status, created_at FROM sales WHERE store_id = $1 ORDER BY id DESC',
      [storeId]
    );
    const csv = [
      'invoice_number,subtotal,tax,total,payment_method,status,created_at',
      ...rowsRes.rows.map((row) => Object.values(row).map((val) => `"${String(val ?? '').replaceAll('"', '""')}"`).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="amora-sales.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/forecast', auth, role('admin', 'manager'), async (req, res) => {
  try {
    const storeId = storeFor(req);
    const rowsRes = await pool.query(`
      SELECT p.id, p.name, p.min_stock,
        COALESCE(SUM(si.quantity), 0) AS units_sold,
        ROUND((COALESCE(SUM(si.quantity), 0) / 30.0)::numeric, 1) AS daily_velocity,
        GREATEST(0, ROUND(((COALESCE(SUM(si.quantity), 0) / 30.0) * 14 - COALESCE(SUM(b.remaining_quantity), 0))::numeric, 0)) AS recommended_reorder
      FROM products p
      LEFT JOIN sale_items si ON si.product_id = p.id
      LEFT JOIN inventory_batches b ON b.product_id = p.id
      WHERE p.store_id = $1 AND p.active = 1
      GROUP BY p.id
      ORDER BY recommended_reorder DESC
    `, [storeId]);
    res.json(rowsRes.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/analysis/inventory', auth, role('admin', 'manager', 'inventory', 'stock_manager'), async (req, res) => {
  try {
    const storeId = storeFor(req);
    const intervalMap = {
      daily: '1 day',
      yearly: '1 year',
      monthly: '1 month'
    };
    const interval = intervalMap[req.query.period] || '1 month';

    const rowsRes = await pool.query(`
      SELECT p.id, p.sku, p.barcode, p.name, p.unit, p.min_stock, p.selling_price,
        COALESCE((
          SELECT SUM(pi.quantity) FROM purchase_items pi
          JOIN purchase_orders po ON po.id = pi.purchase_order_id
          WHERE pi.product_id = p.id AND po.order_date >= (CURRENT_TIMESTAMP - ($1)::interval) AND po.store_id = $2
        ), 0) AS purchased,
        COALESCE((
          SELECT SUM(si.quantity) FROM sale_items si
          JOIN sales s ON s.id = si.sale_id
          WHERE si.product_id = p.id AND s.created_at >= (CURRENT_TIMESTAMP - ($1)::interval) AND s.store_id = $2
        ), 0) AS sold,
        COALESCE((
          SELECT SUM(b.remaining_quantity) FROM inventory_batches b
          WHERE b.product_id = p.id AND b.status = 'available' AND b.expiry_date >= CURRENT_DATE
        ), 0) AS remaining
      FROM products p
      WHERE p.store_id = $2 AND p.active = 1
      ORDER BY p.name
    `, [interval, storeId]);

    const rows = rowsRes.rows.map((item) => {
      const dailyDemand = Number(item.sold) / (req.query.period === 'daily' ? 1 : req.query.period === 'yearly' ? 365 : 30);
      const suggested = Math.max(0, Math.ceil(dailyDemand * 14 + Number(item.min_stock) - Number(item.remaining)));
      return {
        ...item,
        suggested_order: suggested,
        status: Number(item.remaining) <= 0 ? 'Out of stock' : suggested > 0 ? 'Reorder' : Number(item.remaining) <= Number(item.min_stock) ? 'Low' : 'Healthy'
      };
    });

    const summary = rows.reduce((result, item) => ({
      purchased: result.purchased + Number(item.purchased),
      sold: result.sold + Number(item.sold),
      remaining: result.remaining + Number(item.remaining),
      reorder: result.reorder + (item.status === 'Reorder' || item.status === 'Out of stock' ? 1 : 0)
    }), { purchased: 0, sold: 0, remaining: 0, reorder: 0 });

    res.json({ period: req.query.period || 'monthly', summary, rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/analysis/profit-loss', auth, role('admin', 'manager'), async (req, res) => {
  try {
    const storeId = storeFor(req);
    const intervalMap = {
      daily: '1 day',
      yearly: '1 year',
      monthly: '1 month'
    };
    const interval = intervalMap[req.query.period] || '1 month';

    const rowsRes = await pool.query(`
      SELECT p.id, p.sku, p.name,
        COALESCE(SUM(si.quantity), 0) AS quantity_sold,
        COALESCE(SUM(si.line_total), 0) AS revenue,
        COALESCE(SUM(si.quantity * b.purchase_price), 0) AS cost
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      JOIN inventory_batches b ON b.id = si.batch_id
      WHERE s.status = 'completed' AND s.store_id = $1 AND s.created_at >= (CURRENT_TIMESTAMP - ($2)::interval)
      GROUP BY p.id
      ORDER BY revenue DESC
    `, [storeId, interval]);

    const rows = rowsRes.rows.map((item) => {
      const rev = Number(item.revenue);
      const cost = Number(item.cost);
      return {
        ...item,
        profit: rev - cost,
        margin: rev ? Number((((rev - cost) / rev) * 100).toFixed(2)) : 0
      };
    });

    const summary = rows.reduce((result, item) => ({
      revenue: result.revenue + Number(item.revenue),
      cost: result.cost + Number(item.cost),
      profit: result.profit + Number(item.profit)
    }), { revenue: 0, cost: 0, profit: 0 });

    summary.margin = summary.revenue ? Number(((summary.profit / summary.revenue) * 100).toFixed(2)) : 0;
    res.json({ period: req.query.period || 'monthly', summary, rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==============================================================================
// AUDIT LOGS, SETTINGS & ADMINISTRATIVE EXPORT ROUTES
// ==============================================================================

app.get('/api/audit-logs', auth, role('admin', 'manager'), async (_req, res) => {
  try {
    const rows = await queryMany(`
      SELECT a.*, u.name AS user_name
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT 100
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/settings', auth, async (_req, res) => {
  try {
    const rows = await queryMany('SELECT key, value FROM settings');
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/settings', auth, role('admin', 'manager'), async (req, res) => {
  const values = z.record(z.string(), z.string()).safeParse(req.body);
  if (!values.success) return res.status(400).json({ error: 'Settings must be key/value text' });

  try {
    await withTransaction(async (client) => {
      for (const [key, value] of Object.entries(values.data)) {
        await client.query(`
          INSERT INTO settings (key, value)
          VALUES ($1, $2)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [key, value]);
      }
    });

    await audit(req.user.id, 'UPDATE', 'settings', 'store', Object.keys(values.data).join(','));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/backup', auth, role('admin'), async (_req, res) => {
  try {
    const filename = `amora-backup-${new Date().toISOString().replaceAll(':', '-')}.json`;
    const tables = [
      'brands', 'categories', 'customers', 'notifications', 'settings', 'suppliers', 'users',
      'products', 'purchase_orders', 'audit_logs', 'backups', 'login_history',
      'sales', 'inventory_batches', 'supplier_products', 'purchase_items',
      'payments', 'sale_reversals', 'sale_items', 'stock_movements', 'sale_returns'
    ];

    const exportData = {
      exported_at: new Date().toISOString(),
      database: 'neondb',
      tables: {}
    };

    for (const table of tables) {
      const tableRows = await queryMany(`SELECT * FROM "${table}"`);
      exportData.tables[table] = tableRows;
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(exportData, null, 2));
  } catch (error) {
    res.status(500).json({ error: 'Backup failed: ' + error.message });
  }
});

app.use(express.static(rootDir));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Unexpected server error' });
});

export { app, pool as db, pool };

if (process.env.NODE_ENV !== 'test' && !process.argv.includes('--test')) {
  if (process.argv.includes('--seed')) {
    console.log('AMORA database is hosted on Neon PostgreSQL.');
    process.exit(0);
  }
  const server = app.listen(PORT, () => console.log(`AMORA running at http://localhost:${PORT}`));
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`AMORA cannot start: port ${PORT} is already in use. Stop the existing AMORA process or choose another PORT explicitly.`);
      process.exitCode = 1;
    } else {
      console.error('AMORA server error:', error.message);
      process.exitCode = 1;
    }
  });
}
