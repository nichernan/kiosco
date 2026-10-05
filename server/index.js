import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXPIRY_ALERT_DAYS = 30;
const dataDir = join(root, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'kiosco.sqlite'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id,email));
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#4169f1', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id,name));
CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id,name));
CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), category_id TEXT REFERENCES categories(id), supplier_id TEXT REFERENCES suppliers(id), name TEXT NOT NULL, sku TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'unitario', cost REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, tax_rate REAL NOT NULL DEFAULT 21, tax_included INTEGER NOT NULL DEFAULT 1, stock REAL NOT NULL DEFAULT 0, stock_alert REAL NOT NULL DEFAULT 5, active INTEGER NOT NULL DEFAULT 1, expires_on TEXT, image TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id,sku));
CREATE TABLE IF NOT EXISTS product_variants (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE, name TEXT NOT NULL, stock REAL NOT NULL DEFAULT 0, sku TEXT, expires_on TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, tax_id TEXT, phone TEXT, email TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, active INTEGER NOT NULL DEFAULT 1, tax_id_normalized TEXT);
CREATE TABLE IF NOT EXISTS cash_sessions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), opened_by TEXT REFERENCES users(id), closed_by TEXT REFERENCES users(id), opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TEXT, opening_amount REAL NOT NULL DEFAULT 0, closing_amount REAL, status TEXT NOT NULL DEFAULT 'open');
CREATE TABLE IF NOT EXISTS cash_movements (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), session_id TEXT NOT NULL REFERENCES cash_sessions(id), user_id TEXT REFERENCES users(id), kind TEXT NOT NULL, amount REAL NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sales (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT REFERENCES users(id), customer_id TEXT REFERENCES customers(id), cash_session_id TEXT REFERENCES cash_sessions(id), ticket_number INTEGER NOT NULL, subtotal REAL NOT NULL, total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'completed', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id,ticket_number));
CREATE TABLE IF NOT EXISTS sale_items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE, product_id TEXT REFERENCES products(id), product_name TEXT NOT NULL, sku TEXT NOT NULL, quantity REAL NOT NULL, unit_price REAL NOT NULL, line_total REAL NOT NULL);
CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE, method TEXT NOT NULL, amount REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sale_adjustments (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), sale_id TEXT NOT NULL REFERENCES sales(id), user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind='void'), reason TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>=0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id,sale_id,kind));
CREATE TABLE IF NOT EXISTS sale_adjustment_payments (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), adjustment_id TEXT NOT NULL REFERENCES sale_adjustments(id) ON DELETE CASCADE, method TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>=0));
CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT REFERENCES users(id), supplier_id TEXT REFERENCES suppliers(id), product_id TEXT NOT NULL REFERENCES products(id), quantity REAL NOT NULL, unit_cost REAL NOT NULL, subtotal REAL NOT NULL, expires_on TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_created ON sales(tenant_id,created_at);
`);

function normalizeTaxId(value){
  const normalized=String(value||'').toLocaleUpperCase('es-AR').replace(/[^\p{L}\p{N}]/gu,'');
  return normalized||null;
}
function localToday(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));return `${values.year}-${values.month}-${values.day}`;
}
function validDateOnly(value){
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
}
const roundMoney=value=>Math.round((Number(value)+Number.EPSILON)*100)/100;
const toCents=value=>Math.round((Number(value)+Number.EPSILON)*100);
const isCentAmount=value=>Number.isFinite(Number(value))&&Math.abs(Number(value)*100-Math.round(Number(value)*100))<1e-7;
const validUnits=new Set(['unitario','kg','g','l','ml','pack']);
const wholeUnits=new Set(['unitario','pack']);
function validQuantity(quantity,unit){return Number.isFinite(quantity)&&quantity>0&&isCentAmount(quantity)&&(!wholeUnits.has(unit)||Number.isInteger(quantity));}
function expiryInfo(expiresOn,stock=1){
  if(!expiresOn||Number(stock)<=0)return {expiry_status:'none',expiry_days:null};
  const days=Math.floor((Date.parse(`${expiresOn}T00:00:00Z`)-Date.parse(`${localToday()}T00:00:00Z`))/86400000);
  return {expiry_status:days<0?'expired':days<=getExpiryAlertDays()?'expiring':'ok',expiry_days:days};
}
const customerColumns=new Set(db.prepare('PRAGMA table_info(customers)').all().map(column=>column.name));
if(!customerColumns.has('active'))db.exec('ALTER TABLE customers ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
if(!customerColumns.has('tax_id_normalized'))db.exec('ALTER TABLE customers ADD COLUMN tax_id_normalized TEXT');
for(const customer of db.prepare("SELECT id,tax_id FROM customers WHERE tax_id IS NOT NULL AND TRIM(tax_id)<>'' AND tax_id_normalized IS NULL").all()){
  db.prepare('UPDATE customers SET tax_id_normalized=? WHERE id=?').run(normalizeTaxId(customer.tax_id),customer.id);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_tenant_tax_id_unique ON customers(tenant_id,tax_id_normalized) WHERE tax_id_normalized IS NOT NULL");

// Lightweight schema upgrades keep existing local kiosks and their data intact.
const saleItemColumns = new Set(db.prepare('PRAGMA table_info(sale_items)').all().map(column => column.name));
if (!saleItemColumns.has('variant_id')) db.exec('ALTER TABLE sale_items ADD COLUMN variant_id TEXT');
if (!saleItemColumns.has('variant_name')) db.exec("ALTER TABLE sale_items ADD COLUMN variant_name TEXT NOT NULL DEFAULT ''");

const purchaseColumns = new Set(db.prepare('PRAGMA table_info(purchases)').all().map(column => column.name));
if (!purchaseColumns.has('variant_id')) db.exec('ALTER TABLE purchases ADD COLUMN variant_id TEXT REFERENCES product_variants(id) ON DELETE SET NULL');
if (!purchaseColumns.has('variant_name')) db.exec("ALTER TABLE purchases ADD COLUMN variant_name TEXT NOT NULL DEFAULT ''");

const variantColumns = new Set(db.prepare('PRAGMA table_info(product_variants)').all().map(column => column.name));
if (!variantColumns.has('expires_on')) db.exec('ALTER TABLE product_variants ADD COLUMN expires_on TEXT');
const cashSessionColumns = new Set(db.prepare('PRAGMA table_info(cash_sessions)').all().map(column => column.name));
if (!cashSessionColumns.has('closed_by')) db.exec('ALTER TABLE cash_sessions ADD COLUMN closed_by TEXT REFERENCES users(id)');
const cashMovementColumns = new Set(db.prepare('PRAGMA table_info(cash_movements)').all().map(column => column.name));
if (!cashMovementColumns.has('user_id')) db.exec('ALTER TABLE cash_movements ADD COLUMN user_id TEXT REFERENCES users(id)');

// Explicitly link cash movements to the commercial record that caused them.
const movementColumns = new Set(db.prepare('PRAGMA table_info(cash_movements)').all().map(column => column.name));
if (!movementColumns.has('sale_id')) db.exec('ALTER TABLE cash_movements ADD COLUMN sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL');
if (!movementColumns.has('purchase_id')) db.exec('ALTER TABLE cash_movements ADD COLUMN purchase_id TEXT REFERENCES purchases(id) ON DELETE SET NULL');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sale_items_tenant_sale ON sale_items(tenant_id,sale_id);
  CREATE INDEX IF NOT EXISTS idx_payments_tenant_sale_method ON payments(tenant_id,sale_id,method);
  CREATE INDEX IF NOT EXISTS idx_cash_sessions_tenant_opened ON cash_sessions(tenant_id,opened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cash_movements_session_created ON cash_movements(session_id,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS idx_cash_movements_tenant_sale ON cash_movements(tenant_id,sale_id) WHERE sale_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_sale_adjustments_tenant_sale ON sale_adjustments(tenant_id,sale_id);
  DROP INDEX IF EXISTS idx_sales_tenant_ticket;
`);
// Older tickets used notes such as "Venta #4.0". Match only exact ticket notes
// inside the same cash session so historical sale links can be restored safely.
db.exec('BEGIN IMMEDIATE');
try {
  for (const movement of db.prepare("SELECT id,session_id,note FROM cash_movements WHERE kind='sale' AND sale_id IS NULL").all()) {
    const match = /^Venta #([1-9][0-9]*)(?:\.0+)?$/.exec(movement.note);
    if (!match) continue;
    const sale = db.prepare('SELECT s.id FROM sales s JOIN cash_sessions c ON c.id=s.cash_session_id AND c.tenant_id=s.tenant_id WHERE s.tenant_id=c.tenant_id AND s.cash_session_id=? AND s.ticket_number=?').get(movement.session_id, Number(match[1]));
    if (sale) db.prepare('UPDATE cash_movements SET sale_id=? WHERE id=?').run(sale.id, movement.id);
  }
  for (const movement of db.prepare("SELECT id,tenant_id,amount,note FROM cash_movements WHERE kind='purchase' AND purchase_id IS NULL").all()) {
    const candidates=db.prepare(`SELECT pu.id FROM purchases pu JOIN products p ON p.id=pu.product_id AND p.tenant_id=pu.tenant_id
      WHERE pu.tenant_id=? AND ABS(pu.subtotal)=ABS(?) AND ?=('Compra de '||p.name||CASE WHEN pu.variant_name<>'' THEN ' · '||pu.variant_name ELSE '' END)`)
      .all(movement.tenant_id,movement.amount,movement.note);
    const duplicateMovements=db.prepare("SELECT COUNT(*) AS n FROM cash_movements WHERE tenant_id=? AND kind='purchase' AND amount=? AND note=? AND purchase_id IS NULL")
      .get(movement.tenant_id,movement.amount,movement.note).n;
    if(candidates.length===1&&duplicateMovements===1)db.prepare('UPDATE cash_movements SET purchase_id=? WHERE id=?').run(candidates[0].id,movement.id);
  }
  db.exec('COMMIT');
} catch(error) {db.exec('ROLLBACK');throw error;}

const tenantId = 'demo-kiosco';
const userId = 'demo-user';
const hasTenant = db.prepare('SELECT id FROM tenants WHERE id=?').get(tenantId);
if (!hasTenant) {
  db.prepare('INSERT INTO tenants(id,name) VALUES (?,?)').run(tenantId, 'Mi Kiosco');
  db.prepare('INSERT INTO users(id,tenant_id,name,email) VALUES (?,?,?,?)').run(userId, tenantId, 'Administrador', 'admin@kiosco.local');
  const insertCategory = db.prepare('INSERT INTO categories(id,tenant_id,name,color) VALUES (?,?,?,?)');
  const drinks = randomUUID(), snacks = randomUUID(), sweets = randomUUID();
  insertCategory.run(drinks, tenantId, 'Bebidas', '#4c7cf3');
  insertCategory.run(snacks, tenantId, 'Almacén', '#13a56e');
  insertCategory.run(sweets, tenantId, 'Alfajores', '#e5a52e');
  db.prepare('INSERT INTO suppliers(id,tenant_id,name) VALUES (?,?,?)').run(randomUUID(), tenantId, 'Distribuidora Centro');
  const add = db.prepare('INSERT INTO products(id,tenant_id,category_id,name,sku,description,unit,cost,price,tax_rate,tax_included,stock,stock_alert) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  add.run(randomUUID(),tenantId,drinks,'Coca Cola 500 ml','7790895000012','Gaseosa cola, botella de 500 ml','unitario',850,1500,21,1,18,5);
  add.run(randomUUID(),tenantId,snacks,'Papas clásicas','7791234567890','Paquete individual','unitario',700,1200,21,1,12,4);
  add.run(randomUUID(),tenantId,sweets,'Alfajor de chocolate','106416413946','Alfajor triple de chocolate','unitario',800,1200,21,1,9,3);
}
// Safe, additive upgrades preserve the existing local kiosk and its records.
const tenantColumns=new Set(db.prepare('PRAGMA table_info(tenants)').all().map(column=>column.name));
if(!tenantColumns.has('expiry_alert_days'))db.exec(`ALTER TABLE tenants ADD COLUMN expiry_alert_days INTEGER NOT NULL DEFAULT ${DEFAULT_EXPIRY_ALERT_DAYS}`);
const userColumns=new Set(db.prepare('PRAGMA table_info(users)').all().map(column=>column.name));
if(!userColumns.has('password_hash'))db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
if(!userColumns.has('active'))db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
db.exec(`UPDATE users SET role='admin' WHERE role='owner';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email_nocase ON users(tenant_id,email COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);`);

function getExpiryAlertDays(){return db.prepare('SELECT expiry_alert_days FROM tenants WHERE id=?').get(tenantId)?.expiry_alert_days??DEFAULT_EXPIRY_ALERT_DAYS;}

// Variant SKUs share the tenant-wide code namespace with product SKUs.
// Stop rather than making existing ambiguous codes or stock disappear silently.
const duplicateVariantSku = db.prepare(`SELECT sku FROM product_variants WHERE tenant_id=? AND sku IS NOT NULL AND TRIM(sku)<>'' GROUP BY sku COLLATE NOCASE HAVING COUNT(*)>1 LIMIT 1`).get(tenantId);
const duplicateProductSku = db.prepare(`SELECT sku FROM products WHERE tenant_id=? GROUP BY sku COLLATE NOCASE HAVING COUNT(*)>1 LIMIT 1`).get(tenantId);
const productVariantSkuCollision = db.prepare(`SELECT p.sku FROM products p JOIN product_variants v ON v.tenant_id=p.tenant_id AND v.sku=p.sku COLLATE NOCASE WHERE p.tenant_id=? AND TRIM(p.sku)<>'' LIMIT 1`).get(tenantId);
if (duplicateVariantSku || duplicateProductSku || productVariantSkuCollision) {
  throw new Error(`No se puede iniciar: hay SKU duplicados o en conflicto (${duplicateVariantSku?.sku || duplicateProductSku?.sku || productVariantSkuCollision.sku}). Resolvé esos códigos conservando el stock antes de continuar.`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_variant_sku_tenant_unique ON product_variants(tenant_id, sku COLLATE NOCASE) WHERE sku IS NOT NULL AND TRIM(sku)<>''`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_product_sku_tenant_nocase ON products(tenant_id, sku COLLATE NOCASE)`);
const unassignedVariantStock = db.prepare(`SELECT p.id,p.name,p.stock,COALESCE(SUM(v.stock),0) AS variant_total FROM products p JOIN product_variants v ON v.product_id=p.id AND v.tenant_id=p.tenant_id WHERE p.tenant_id=? GROUP BY p.id HAVING p.stock > COALESCE(SUM(v.stock),0)`).all(tenantId);
if (unassignedVariantStock.length) {
  const details = unassignedVariantStock.map(product => `${product.name}: producto=${product.stock}, variantes=${product.variant_total}`).join('; ');
  throw new Error(`Hay stock general sin asignar a variantes. No se modificaron datos. Asignalo de forma explícita antes de iniciar: ${details}`);
}
db.prepare(`UPDATE products SET stock=0 WHERE tenant_id=? AND id IN (SELECT product_id FROM product_variants WHERE tenant_id=?)`).run(tenantId,tenantId);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api',(req,res,next)=>{
  if(!['POST','PUT','PATCH'].includes(req.method)||req.path==='/auth/logout')return next();
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))return res.status(400).json({error:'La solicitud debe incluir un objeto JSON válido.'});
  next();
});
app.get('/api/health', (_req,res) => res.json({ ok: true }));
const SESSION_MS=12*60*60*1000;
const passwordHash=(password,salt=randomBytes(16).toString('hex'))=>`${salt}:${scryptSync(password,salt,64).toString('hex')}`;
const passwordMatches=(password,encoded)=>{try{const [salt,expected]=encoded.split(':');const actual=scryptSync(password,salt,64);return timingSafeEqual(actual,Buffer.from(expected,'hex'));}catch{return false;}};
const cookieToken=req=>String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('kiosco_session='))?.slice('kiosco_session='.length);
const setSessionCookie=(res,token)=>res.setHeader('Set-Cookie',`kiosco_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}`);
const clearSessionCookie=res=>res.setHeader('Set-Cookie','kiosco_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
const sessionUser=req=>{const token=cookieToken(req);if(!token)return null;const session=db.prepare(`SELECT s.id AS session_id,u.id,u.tenant_id,u.name,u.email,u.role,u.active FROM auth_sessions s JOIN users u ON u.id=s.user_id AND u.tenant_id=s.tenant_id WHERE s.token_hash=? AND s.tenant_id=? AND s.expires_at>CURRENT_TIMESTAMP`).get(createHash('sha256').update(token).digest('hex'),tenantId);if(!session||!session.active){if(session)db.prepare('DELETE FROM auth_sessions WHERE id=?').run(session.session_id);return null;}return session;};
app.get('/api/auth/status',(_req,res)=>{const admin=db.prepare("SELECT id FROM users WHERE tenant_id=? AND role='admin' AND active=1 AND password_hash IS NOT NULL LIMIT 1").get(tenantId);res.json({setup_required:!admin});});
app.post('/api/auth/setup',(req,res)=>{try{const name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');if(name.length<2||name.length>80||!/^\S+@\S+\.\S+$/.test(email)||password.length<10||password.length>200)throw Object.assign(new Error('Ingresá nombre, email válido y una contraseña de al menos 10 caracteres.'),{status:400});const admin=db.prepare("SELECT id FROM users WHERE tenant_id=? AND role IN ('admin','owner') AND active=1 AND password_hash IS NULL ORDER BY created_at LIMIT 1").get(tenantId);if(!admin)throw Object.assign(new Error('La configuración inicial ya fue completada.'),{status:409});db.prepare("UPDATE users SET name=?,email=?,role='admin',password_hash=? WHERE id=? AND tenant_id=?").run(name,email,passwordHash(password),admin.id,tenantId);const token=randomBytes(32).toString('base64url');db.prepare('INSERT INTO auth_sessions(id,token_hash,user_id,tenant_id,expires_at) VALUES (?,?,?,?,datetime(\'now\',\'+12 hours\'))').run(randomUUID(),createHash('sha256').update(token).digest('hex'),admin.id,tenantId);setSessionCookie(res,token);res.status(201).json({user:{id:admin.id,name,email,role:'admin'}});}catch(error){res.status(error.status||(/UNIQUE constraint/.test(error.message)?409:400)).json({error:/UNIQUE constraint/.test(error.message)?'Ese email ya está registrado.':error.message});}});
app.post('/api/auth/login',(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');const user=db.prepare('SELECT id,tenant_id,name,email,role,password_hash,active FROM users WHERE tenant_id=? AND email=? COLLATE NOCASE').get(tenantId,email);if(!user||!user.active||!user.password_hash||!passwordMatches(password,user.password_hash))return res.status(401).json({error:'Email o contraseña incorrectos, o usuario desactivado.'});const token=randomBytes(32).toString('base64url');db.prepare('INSERT INTO auth_sessions(id,token_hash,user_id,tenant_id,expires_at) VALUES (?,?,?,?,datetime(\'now\',\'+12 hours\'))').run(randomUUID(),createHash('sha256').update(token).digest('hex'),user.id,tenantId);setSessionCookie(res,token);res.json({user:{id:user.id,name:user.name,email:user.email,role:user.role}});});
app.post('/api/auth/logout',(req,res)=>{const token=cookieToken(req);if(token)db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(createHash('sha256').update(token).digest('hex'));clearSessionCookie(res);res.json({ok:true});});
app.use('/api',(req,res,next)=>{if(['/health','/auth/status','/auth/setup','/auth/login','/auth/logout'].includes(req.path))return next();const user=sessionUser(req);if(!user)return res.status(401).json({error:'Tu sesión terminó. Iniciá sesión para continuar.'});req.auth=user;if(user.role==='admin')return next();const method=req.method,path=req.path;const allowed=(method==='GET'&&(/^\/bootstrap$|^\/products(?:\/|$)|^\/scan\/|^\/categories$|^\/suppliers$|^\/customers$|^\/cash$|^\/sales(?:\/[^/]+)?$/.test(path)))||(method==='POST'&&(/^\/sales$|^\/cash\/(open|movements|close)$/.test(path)));if(!allowed)return res.status(403).json({error:'Tu rol no tiene permiso para realizar esta operación.'});next();});
app.get('/api/auth/me',(req,res)=>{const user=sessionUser(req);if(!user)return res.status(401).json({error:'No hay una sesión activa.'});res.json({id:user.id,name:user.name,email:user.email,role:user.role});});
app.get('/api/users',(_req,res)=>res.json(db.prepare('SELECT id,name,email,role,active,created_at FROM users WHERE tenant_id=? ORDER BY name').all(tenantId)));
app.post('/api/users',(req,res)=>{try{const name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||''),role=req.body.role;if(name.length<2||name.length>80||!/^\S+@\S+\.\S+$/.test(email)||password.length<10||password.length>200||!['admin','employee'].includes(role))throw Object.assign(new Error('Revisá nombre, email, contraseña (mínimo 10 caracteres) y rol.'),{status:400});const id=randomUUID();db.prepare('INSERT INTO users(id,tenant_id,name,email,role,password_hash) VALUES (?,?,?,?,?,?)').run(id,tenantId,name,email,role,passwordHash(password));db.prepare("INSERT INTO admin_audit_log(id,tenant_id,actor_id,action,subject_type,subject_id) VALUES (?,?,?,'user.create','user',?)").run(randomUUID(),tenantId,req.auth.id,id);res.status(201).json(db.prepare('SELECT id,name,email,role,active,created_at FROM users WHERE id=?').get(id));}catch(error){res.status(error.status||(/UNIQUE constraint/.test(error.message)?409:400)).json({error:/UNIQUE constraint/.test(error.message)?'Ese email ya está registrado.':error.message});}});
app.patch('/api/users/:id',(req,res)=>{try{const current=db.prepare('SELECT id,role,active FROM users WHERE id=? AND tenant_id=?').get(req.params.id,tenantId);if(!current)return res.status(404).json({error:'Usuario no encontrado.'});const name=String(req.body.name??'').trim(),email=String(req.body.email??'').trim().toLowerCase(),role=req.body.role,active=Number(req.body.active);if(name.length<2||name.length>80||!/^\S+@\S+\.\S+$/.test(email)||!['admin','employee'].includes(role)||![0,1].includes(active))throw Object.assign(new Error('Revisá nombre, email, rol y estado.'),{status:400});const demotesAdmin=current.role==='admin'&&(role!=='admin'||active===0);if(demotesAdmin){const admins=db.prepare("SELECT COUNT(*) n FROM users WHERE tenant_id=? AND role='admin' AND active=1").get(tenantId).n;if(admins<=1)return res.status(409).json({error:'No se puede quitar o desactivar al último administrador activo.'});}const password=req.body.password===undefined?'':String(req.body.password);if(password&&(password.length<10||password.length>200))throw Object.assign(new Error('La contraseña debe tener al menos 10 caracteres.'),{status:400});db.prepare('UPDATE users SET name=?,email=?,role=?,active=?,password_hash=CASE WHEN ?=\'\' THEN password_hash ELSE ? END WHERE id=? AND tenant_id=?').run(name,email,role,active,password,password?passwordHash(password):'',req.params.id,tenantId);if(active===0)db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND tenant_id=?').run(req.params.id,tenantId);db.prepare("INSERT INTO admin_audit_log(id,tenant_id,actor_id,action,subject_type,subject_id) VALUES (?,?,?,'user.update','user',?)").run(randomUUID(),tenantId,req.auth.id,req.params.id);res.json(db.prepare('SELECT id,name,email,role,active,created_at FROM users WHERE id=? AND tenant_id=?').get(req.params.id,tenantId));}catch(error){res.status(error.status||(/UNIQUE constraint/.test(error.message)?409:400)).json({error:/UNIQUE constraint/.test(error.message)?'Ese email ya está registrado.':error.message});}});
app.get('/api/settings',(_req,res)=>res.json(db.prepare('SELECT id,name,expiry_alert_days FROM tenants WHERE id=?').get(tenantId)));
app.patch('/api/settings',(req,res)=>{const name=String(req.body.name||'').trim(),days=Number(req.body.expiry_alert_days);if(name.length<2||name.length>100||!Number.isInteger(days)||days<1||days>365)return res.status(400).json({error:'El nombre debe tener entre 2 y 100 caracteres y el aviso entre 1 y 365 días.'});db.prepare('UPDATE tenants SET name=?,expiry_alert_days=? WHERE id=?').run(name,days,tenantId);db.prepare("INSERT INTO admin_audit_log(id,tenant_id,actor_id,action,subject_type,subject_id) VALUES (?,?,?,'settings.update','tenant',?)").run(randomUUID(),tenantId,req.auth.id,tenantId);res.json(db.prepare('SELECT id,name,expiry_alert_days FROM tenants WHERE id=?').get(tenantId));});
app.get('/api/bootstrap', (req,res) => {
  const tenant = db.prepare('SELECT id,name FROM tenants WHERE id=?').get(tenantId);
  const user = db.prepare('SELECT id,name,email,role FROM users WHERE id=? AND tenant_id=?').get(req.auth.id,tenantId);
  const categories = db.prepare('SELECT id,name,color FROM categories WHERE tenant_id=? ORDER BY name').all(tenantId);
  const suppliers = db.prepare('SELECT id,name FROM suppliers WHERE tenant_id=? ORDER BY name').all(tenantId);
  const cash = getOpenCash();
  const customers = db.prepare('SELECT id,name,tax_id,phone,email FROM customers WHERE tenant_id=? AND active=1 ORDER BY name').all(tenantId);
  res.json({ tenant, user, categories, suppliers, cash, customers, expiry_alert_days:getExpiryAlertDays(), products: listProducts() });
});
function listProducts(search='') {
  const products = db.prepare(`SELECT p.*, c.name AS category_name, c.color AS category_color, s.name AS supplier_name
    FROM products p LEFT JOIN categories c ON p.category_id=c.id LEFT JOIN suppliers s ON p.supplier_id=s.id
    WHERE p.tenant_id=? AND (p.name LIKE ? OR p.sku LIKE ?) ORDER BY p.name`).all(tenantId, `%${search}%`, `%${search}%`);
  const variants = db.prepare('SELECT id,product_id,name,sku,stock,expires_on FROM product_variants WHERE tenant_id=? ORDER BY name').all(tenantId);
  return products.map(product=>{
    const productVariants=variants.filter(variant=>variant.product_id===product.id).map(variant=>({...variant,...expiryInfo(variant.expires_on,variant.stock)}));
    const stock=productVariants.length?productVariants.reduce((sum,variant)=>sum+variant.stock,0):product.stock;
    let expiry=expiryInfo(product.expires_on,stock);
    if(productVariants.length){
      const priority={expired:0,expiring:1,ok:2,none:3};
      const mostUrgent=productVariants.sort((a,b)=>(priority[a.expiry_status]??3)-(priority[b.expiry_status]??3)||((a.expiry_days??Infinity)-(b.expiry_days??Infinity)))[0];
      expiry={expiry_status:mostUrgent.expiry_status,expiry_days:mostUrgent.expiry_days};
    }
    return {...product,...expiry,stock,variants:productVariants};
  });
}

function validateProductSku(sku, productId, variants=[]) {
  const normalized=String(sku||'').trim();
  const productConflict=db.prepare('SELECT name FROM products WHERE tenant_id=? AND sku=? COLLATE NOCASE AND id<>?').get(tenantId,normalized,productId||'');
  if(productConflict) throw new Error('Ya existe un producto con ese código.');
  const variantConflict=db.prepare('SELECT name FROM product_variants WHERE tenant_id=? AND sku=? COLLATE NOCASE').get(tenantId,normalized);
  if(variantConflict) throw new Error('El código ya está asignado a una variante.');
  const variantCodes=new Set();
  for(const variant of variants){
    const code=String(variant.sku||'').trim();
    if(!code) continue;
    const key=code.toLocaleLowerCase('es-AR');
    if(key===normalized.toLocaleLowerCase('es-AR')) throw new Error('El código del producto no puede repetirse en una variante.');
    if(variantCodes.has(key)) throw new Error(`El código de variante ${code} está repetido.`);
    variantCodes.add(key);
    const otherProduct=db.prepare('SELECT name FROM products WHERE tenant_id=? AND sku=? COLLATE NOCASE').get(tenantId,code);
    if(otherProduct) throw new Error(`El código de variante ${code} ya está asignado a un producto.`);
  }
}

function validateProductRelations(categoryId,supplierId){
  if(!categoryId||!db.prepare('SELECT 1 FROM categories WHERE id=? AND tenant_id=?').get(categoryId,tenantId))throw new Error('La categoría seleccionada no existe.');
  if(supplierId&&!db.prepare('SELECT 1 FROM suppliers WHERE id=? AND tenant_id=?').get(supplierId,tenantId))throw new Error('El proveedor seleccionado no existe.');
}
function validateProductData(product){
  const name=String(product.name||'').trim(),sku=String(product.sku||'').trim(),description=String(product.description||'');
  if(!name||name.length>150||!sku||sku.length>120)throw new Error('El nombre (hasta 150 caracteres) y el SKU (hasta 120 caracteres) son obligatorios.');
  if(description.length>2000)throw new Error('La descripción no puede superar los 2000 caracteres.');
  const values={};
  for(const [field,label] of [['cost','costo'],['price','precio'],['tax_rate','IVA'],['stock','stock'],['stock_alert','stock mínimo']]){
    const raw=product[field]??(field==='tax_rate'?21:field==='stock_alert'?5:0),number=Number(raw);
    if(!Number.isFinite(number)||number<0||(field==='tax_rate'&&number>100))throw new Error(`El ${label} debe ser un número válido${field==='tax_rate'?' entre 0 y 100':' igual o mayor a cero'}.`);
    if(['cost','price','stock'].includes(field)&&!isCentAmount(number))throw new Error(`El ${label} debe tener como máximo dos decimales.`);
    values[field]=number;
  }
  const unit=String(product.unit||'unitario');
  if(!validUnits.has(unit))throw new Error('El tipo de unidad seleccionado no es válido.');
  if(wholeUnits.has(unit)&&!Number.isInteger(values.stock))throw new Error('El stock de productos unitarios y packs debe ser un número entero.');
  if(!Number.isInteger(values.stock_alert))throw new Error('El stock mínimo debe ser un número entero.');
  const active=Number(product.active??1),taxIncluded=Number(product.tax_included??1);
  if(![0,1].includes(active)||![0,1].includes(taxIncluded))throw new Error('El estado del producto o la opción de IVA no es válida.');
  const expiresOn=String(product.expires_on||'').trim()||null;
  if(expiresOn&&!validDateOnly(expiresOn))throw new Error('La fecha de vencimiento no es válida.');
  const supplierId=product.supplier_id?String(product.supplier_id):null;
  return {...values,name,sku,description,unit,active,tax_included:taxIncluded,expires_on:expiresOn,supplier_id:supplierId};
}

function validateVariantList(productId, variants, productSku, productUnit='unitario') {
  if(!Array.isArray(variants)) throw new Error('La lista de variantes no es válida.');
  const existing=db.prepare('SELECT id,name,stock,sku FROM product_variants WHERE tenant_id=? AND product_id=?').all(tenantId,productId);
  const existingIds=new Set(existing.map(variant=>variant.id));
  const submittedIds=new Set();
  const normalized=variants.map(variant=>{
    const name=String(variant.name||'').trim();
    const stock=Number(variant.stock);
    const sku=String(variant.sku||'').trim();
    if(!name||!Number.isFinite(stock)||stock<0||!isCentAmount(stock)||(wholeUnits.has(productUnit)&&!Number.isInteger(stock))) throw new Error('Cada variante necesita un stock válido para el tipo de unidad del producto.');
    const expiresOn=String(variant.expires_on||'').trim()||null;
    if(expiresOn&&!validDateOnly(expiresOn))throw new Error(`La fecha de vencimiento de ${name} no es válida.`);
    if(variant.id){
      if(!existingIds.has(variant.id)||submittedIds.has(variant.id)) throw new Error('La variante seleccionada no pertenece a este producto.');
      submittedIds.add(variant.id);
    }
    return {id:variant.id||null,name,stock,sku:sku||null,expires_on:expiresOn};
  });
  const skuSet=new Set();
  for(const variant of normalized){
    if(!variant.sku) continue;
    const key=variant.sku.toLocaleLowerCase('es-AR');
    if(key===String(productSku||'').trim().toLocaleLowerCase('es-AR')) throw new Error('El SKU de una variante no puede coincidir con el del producto.');
    if(skuSet.has(key)) throw new Error(`El código de variante ${variant.sku} está repetido.`);
    skuSet.add(key);
    const productConflict=db.prepare('SELECT name FROM products WHERE tenant_id=? AND sku=? COLLATE NOCASE').get(tenantId,variant.sku);
    if(productConflict) throw new Error(`El código de variante ${variant.sku} ya está asignado a un producto.`);
    const variantConflict=db.prepare('SELECT id,name FROM product_variants WHERE tenant_id=? AND sku=? COLLATE NOCASE AND product_id<>?').get(tenantId,variant.sku,productId);
    if(variantConflict) throw new Error(`El código de variante ${variant.sku} ya está asignado a otra variante.`);
  }
  const nextIds=new Set(normalized.filter(variant=>variant.id).map(variant=>variant.id));
  for(const old of existing){
    if(!nextIds.has(old.id)&&old.stock>0) throw new Error(`No se puede eliminar “${old.name}”: todavía tiene ${old.stock} unidades. Reasigná el stock o dejalo en cero y guardá antes de eliminarla.`);
  }
  return normalized;
}

function saveVariants(productId, variants) {
  const save=db.prepare(`INSERT INTO product_variants(id,tenant_id,product_id,name,stock,sku,expires_on) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,stock=excluded.stock,sku=excluded.sku,expires_on=excluded.expires_on WHERE product_variants.tenant_id=excluded.tenant_id AND product_variants.product_id=excluded.product_id`);
  const keep=[];
  for(const variant of variants){const id=variant.id||randomUUID();keep.push(id);save.run(id,tenantId,productId,variant.name,variant.stock,variant.sku,variant.expires_on||null);}
  const existing=db.prepare('SELECT id FROM product_variants WHERE tenant_id=? AND product_id=?').all(tenantId,productId);
  const remove=db.prepare('DELETE FROM product_variants WHERE id=? AND tenant_id=? AND product_id=? AND stock=0');
  for(const variant of existing) if(!keep.includes(variant.id)){assertVariantCanBeRemoved(variant.id);remove.run(variant.id,tenantId,productId);}
  db.prepare('UPDATE products SET stock=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?').run(productId,tenantId);
}
function assertVariantCanBeRemoved(variantId){
  if(db.prepare('SELECT 1 FROM sale_items WHERE tenant_id=? AND variant_id=? LIMIT 1').get(tenantId,variantId))throw new Error('No se puede quitar esta variante porque forma parte del historial de ventas.');
}
app.get('/api/products', (req,res) => res.json(listProducts(String(req.query.search || ''))));
app.get('/api/scan/:code',(req,res)=>{
  const code=String(req.params.code||'').trim();
  if(!code)return res.status(400).json({error:'No se recibió ningún código.'});
  const product=db.prepare(`SELECT p.*,c.name AS category_name,c.color AS category_color FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.tenant_id=? AND p.active=1 AND p.sku=?`).get(tenantId,code);
  if(product){
    const variants=db.prepare('SELECT id,name,sku,stock FROM product_variants WHERE tenant_id=? AND product_id=?').all(tenantId,product.id);
    if(variants.length)return res.status(409).json({error:'Este producto tiene variantes; escaneá el código de la variante.'});
    if(product.stock<=0)return res.status(409).json({error:`${product.name}: sin stock disponible.`});
    if(expiryInfo(product.expires_on,product.stock).expiry_status==='expired')return res.status(409).json({error:`${product.name}: producto vencido (${product.expires_on}); no se puede vender.`});
    return res.json({product,variant:null});
  }
  const variant=db.prepare(`SELECT v.id AS variant_id,v.name AS variant_name,v.sku AS variant_sku,v.stock AS variant_stock,v.expires_on AS variant_expires_on,p.* FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.tenant_id=? AND p.tenant_id=? AND p.active=1 AND v.sku=?`).get(tenantId,tenantId,code);
  if(!variant)return res.status(404).json({error:`No encontramos el código ${code}.`});
  if(variant.variant_stock<=0)return res.status(409).json({error:`${variant.name}: sin stock disponible.`});
  if(expiryInfo(variant.variant_expires_on,variant.variant_stock).expiry_status==='expired')return res.status(409).json({error:`${variant.name}: variante vencida (${variant.variant_expires_on}); no se puede vender.`});
  const {variant_id,variant_name,variant_sku,variant_stock,...productData}=variant;
  return res.json({product:productData,variant:{id:variant_id,name:variant_name,sku:variant_sku,stock:variant_stock}});
});
app.post('/api/products', (req,res) => {
  const p=req.body;
  if (typeof p.name!=='string'||!p.name.trim()||typeof p.sku!=='string'||!p.sku.trim()||!p.category_id) return res.status(400).json({error:'Completá nombre, código y categoría.'});
  let normalized;try{normalized=validateProductData(p)}catch(e){return res.status(400).json({error:e.message})}
  const id=randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const variants=Object.hasOwn(p,'variants')?validateVariantList(id,p.variants,normalized.sku,normalized.unit):[];
    validateProductSku(normalized.sku,id,variants);
    validateProductRelations(p.category_id,normalized.supplier_id);
    db.prepare(`INSERT INTO products(id,tenant_id,category_id,supplier_id,name,sku,description,unit,cost,price,tax_rate,tax_included,stock,stock_alert,active,expires_on)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,tenantId,p.category_id,normalized.supplier_id,normalized.name,normalized.sku,normalized.description,p.unit||'unitario',normalized.cost,normalized.price,normalized.tax_rate,normalized.tax_included,variants.length?0:normalized.stock,normalized.stock_alert,normalized.active,variants.length?null:normalized.expires_on);
    if(variants.length) saveVariants(id,variants);
    db.exec('COMMIT');
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(id));
  } catch(e) { db.exec('ROLLBACK'); const conflict=/SKU|código|repetid|UNIQUE/i.test(e.message); res.status(conflict?409:400).json({error:e.message.includes('UNIQUE')?'Ya existe un producto o variante con ese código.':e.message||'No se pudo guardar el producto.'}); }
});
app.patch('/api/products/:id', (req,res) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const old=db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(req.params.id,tenantId);
    if(!old){db.exec('ROLLBACK');return res.status(404).json({error:'Producto no encontrado.'});}
    const p={...old,...req.body};
    const normalized=validateProductData(p);
    const existingVariants=db.prepare('SELECT id FROM product_variants WHERE product_id=? AND tenant_id=?').all(req.params.id,tenantId);
    const hasVariantUpdate=Object.hasOwn(req.body,'variants');
    if(existingVariants.length&&!hasVariantUpdate&&Object.hasOwn(req.body,'expires_on')&&normalized.expires_on)throw new Error('Este producto tiene variantes; asigná el vencimiento a cada variante.');
    if(existingVariants.length&&!hasVariantUpdate&&Object.hasOwn(req.body,'stock')&&Number(req.body.stock)!==0) throw new Error('El stock de un producto con variantes se administra exclusivamente por variante.');
    if(!p.category_id) throw new Error('Seleccioná una categoría para el producto.');
    validateProductRelations(p.category_id,normalized.supplier_id);
    let variants=hasVariantUpdate?validateVariantList(req.params.id,req.body.variants,normalized.sku,normalized.unit):null;
    if(variants?.length&&!existingVariants.length&&old.expires_on)variants=variants.map(variant=>({...variant,expires_on:variant.expires_on||old.expires_on}));
    validateProductSku(normalized.sku,req.params.id,variants||[]);
    const previousVariantCount=existingVariants.length;
    if(!previousVariantCount&&variants?.length){
      const oldStock=Number(old.stock)||0;
      const newStock=variants.reduce((sum,variant)=>sum+variant.stock,0);
      if(Math.abs(oldStock-newStock)>0.000001) throw new Error(`Al convertir este producto a variantes, el stock total debe conservar las ${oldStock} unidades actuales.`);
    }
    let nextExpiresOn=variants?.length||existingVariants.length&&!hasVariantUpdate?null:normalized.expires_on;
    if(hasVariantUpdate&&!variants.length&&existingVariants.length){
      const expiries=[...new Set(db.prepare('SELECT expires_on FROM product_variants WHERE tenant_id=? AND product_id=?').all(tenantId,req.params.id).map(row=>row.expires_on||null))];
      if(expiries.length>1&&!normalized.expires_on)throw new Error('Las variantes tienen vencimientos distintos; ingresá un vencimiento único para continuar.');
      nextExpiresOn=normalized.expires_on||expiries[0]||null;
    }
    const nextStock=variants?.length?0:(previousVariantCount?0:normalized.stock);
    db.prepare(`UPDATE products SET category_id=?,supplier_id=?,name=?,sku=?,description=?,unit=?,cost=?,price=?,tax_rate=?,tax_included=?,stock=?,stock_alert=?,active=?,expires_on=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?`)
      .run(p.category_id,normalized.supplier_id,normalized.name,normalized.sku,normalized.description,p.unit,normalized.cost,normalized.price,normalized.tax_rate,normalized.tax_included,nextStock,normalized.stock_alert,normalized.active,nextExpiresOn,req.params.id,tenantId);
    if(hasVariantUpdate&&variants.length) saveVariants(req.params.id,variants);
    else if(hasVariantUpdate){
      const removed=db.prepare('SELECT id FROM product_variants WHERE tenant_id=? AND product_id=?').all(tenantId,req.params.id);
      const deleteVariant=db.prepare('DELETE FROM product_variants WHERE id=? AND tenant_id=? AND product_id=? AND stock=0');
      for(const variant of removed){assertVariantCanBeRemoved(variant.id);deleteVariant.run(variant.id,tenantId,req.params.id);}
      db.prepare('UPDATE products SET stock=0 WHERE id=? AND tenant_id=?').run(req.params.id,tenantId);
    }
    db.exec('COMMIT');res.json({ok:true});
  } catch(e) { db.exec('ROLLBACK'); const conflict=e.message.includes('SKU')||e.message.includes('código')||e.message.includes('repetido')||e.message.includes('UNIQUE'); res.status(conflict?409:400).json({error:e.message.includes('UNIQUE')?'Ya existe un producto o variante con ese código.':e.message||'No se pudo actualizar.'}); }
});
app.put('/api/products/:id/variants',(req,res)=>{
  db.exec('BEGIN IMMEDIATE');
  try {
    const product=db.prepare('SELECT id,sku,stock,expires_on FROM products WHERE id=? AND tenant_id=?').get(req.params.id,tenantId);
    if(!product){db.exec('ROLLBACK');return res.status(404).json({error:'Producto no encontrado.'});}
    const existingCount=db.prepare('SELECT COUNT(*) AS count FROM product_variants WHERE tenant_id=? AND product_id=?').get(tenantId,product.id).count;
    let variants=validateVariantList(product.id,req.body.variants,product.sku,db.prepare('SELECT unit FROM products WHERE id=? AND tenant_id=?').get(product.id,tenantId).unit);
    if(!existingCount&&variants.length&&product.expires_on)variants=variants.map(variant=>({...variant,expires_on:variant.expires_on||product.expires_on}));
    if(!existingCount&&variants.length){
      const nextTotal=variants.reduce((sum,variant)=>sum+variant.stock,0);
      if(Math.abs(Number(product.stock)-nextTotal)>0.000001) throw new Error(`Al convertir este producto a variantes, el stock total debe conservar las ${product.stock} unidades actuales.`);
      saveVariants(product.id,variants);
      db.prepare('UPDATE products SET expires_on=NULL WHERE id=? AND tenant_id=?').run(product.id,tenantId);
    } else if(existingCount&&variants.length){saveVariants(product.id,variants);db.prepare('UPDATE products SET expires_on=NULL WHERE id=? AND tenant_id=?').run(product.id,tenantId);}
    else if(existingCount){
      const expiries=[...new Set(db.prepare('SELECT expires_on FROM product_variants WHERE tenant_id=? AND product_id=?').all(tenantId,product.id).map(row=>row.expires_on||null))];
      if(expiries.length>1)throw new Error('Las variantes tienen vencimientos distintos; no se pueden combinar en un solo producto sin registrar un vencimiento único.');
      const existing=db.prepare('SELECT id FROM product_variants WHERE tenant_id=? AND product_id=?').all(tenantId,product.id);
      const remove=db.prepare('DELETE FROM product_variants WHERE id=? AND tenant_id=? AND product_id=? AND stock=0');
      for(const variant of existing){assertVariantCanBeRemoved(variant.id);remove.run(variant.id,tenantId,product.id);}
      db.prepare('UPDATE products SET stock=0 WHERE id=? AND tenant_id=?').run(product.id,tenantId);
      db.prepare('UPDATE products SET expires_on=? WHERE id=? AND tenant_id=?').run(expiries[0]||product.expires_on||null,product.id,tenantId);
    }
    db.exec('COMMIT');res.json({ok:true});
  }catch(e){db.exec('ROLLBACK');const conflict=e.message.includes('SKU')||e.message.includes('código')||e.message.includes('repetido')||e.message.includes('UNIQUE');res.status(conflict?409:400).json({error:e.message||'No se pudieron guardar las variantes.'});}
});
app.get('/api/categories', (_req,res)=>res.json(db.prepare(`SELECT c.*,COUNT(p.id) AS product_count FROM categories c LEFT JOIN products p ON p.category_id=c.id AND p.tenant_id=c.tenant_id WHERE c.tenant_id=? GROUP BY c.id ORDER BY c.name`).all(tenantId)));
app.post('/api/categories', (req,res)=>{
  const name=String(req.body.name||'').trim(),color=String(req.body.color||'#4169f1');
  if(!name||name.length>100||!/^#[0-9a-f]{6}$/i.test(color))return res.status(400).json({error:'Ingresá un nombre de categoría válido y un color hexadecimal.'});
  try {const id=randomUUID();db.prepare('INSERT INTO categories(id,tenant_id,name,color) VALUES (?,?,?,?)').run(id,tenantId,name,color);res.status(201).json(db.prepare('SELECT * FROM categories WHERE id=?').get(id));}
  catch(e) {res.status(/UNIQUE/i.test(e.message)?409:400).json({error:/UNIQUE/i.test(e.message)?'Esa categoría ya existe.':'No se pudo guardar la categoría.'});}
});
app.patch('/api/categories/:id',(req,res)=>{
  const name=String(req.body.name||'').trim(),color=String(req.body.color||'#4169f1');
  if(!name||name.length>100||!/^#[0-9a-f]{6}$/i.test(color))return res.status(400).json({error:'Ingresá un nombre de categoría válido y un color hexadecimal.'});
  try{const result=db.prepare('UPDATE categories SET name=?,color=? WHERE id=? AND tenant_id=?').run(name,color,req.params.id,tenantId);if(!result.changes)return res.status(404).json({error:'Categoría no encontrada.'});res.json(db.prepare('SELECT * FROM categories WHERE id=? AND tenant_id=?').get(req.params.id,tenantId));}
  catch(e){res.status(/UNIQUE/i.test(e.message)?409:400).json({error:/UNIQUE/i.test(e.message)?'Ya existe una categoría con ese nombre.':'No se pudo actualizar la categoría.'});}
});
app.delete('/api/categories/:id',(req,res)=>{
  let tx=false;try{db.exec('BEGIN IMMEDIATE');tx=true;const category=db.prepare('SELECT id FROM categories WHERE id=? AND tenant_id=?').get(req.params.id,tenantId);if(!category){db.exec('ROLLBACK');return res.status(404).json({error:'Categoría no encontrada.'});}const count=db.prepare('SELECT COUNT(*) AS count FROM products WHERE tenant_id=? AND category_id=?').get(tenantId,category.id).count;if(count){db.exec('ROLLBACK');return res.status(409).json({error:`No se puede eliminar: ${count} producto(s) usan esta categoría.`});}db.prepare('DELETE FROM categories WHERE id=? AND tenant_id=?').run(category.id,tenantId);db.exec('COMMIT');tx=false;res.json({ok:true});}catch{if(tx)db.exec('ROLLBACK');res.status(500).json({error:'No se pudo eliminar la categoría.'});}
});
app.get('/api/suppliers', (_req,res)=>res.json(db.prepare(`SELECT s.*,COUNT(DISTINCT p.id) AS product_count,COUNT(DISTINCT pu.id) AS purchase_count FROM suppliers s LEFT JOIN products p ON p.supplier_id=s.id AND p.tenant_id=s.tenant_id LEFT JOIN purchases pu ON pu.supplier_id=s.id AND pu.tenant_id=s.tenant_id WHERE s.tenant_id=? GROUP BY s.id ORDER BY s.name`).all(tenantId)));
app.post('/api/suppliers', (req,res)=>{
  const name=String(req.body.name||'').trim();if(!name||name.length>150)return res.status(400).json({error:'Escribí un nombre válido para el proveedor.'});
  try {const id=randomUUID();db.prepare('INSERT INTO suppliers(id,tenant_id,name) VALUES (?,?,?)').run(id,tenantId,name);res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(id));}
  catch(e) {res.status(/UNIQUE/i.test(e.message)?409:400).json({error:/UNIQUE/i.test(e.message)?'Ese proveedor ya existe.':'No se pudo guardar el proveedor.'});}
});
app.patch('/api/suppliers/:id',(req,res)=>{
  const name=String(req.body.name||'').trim();if(!name||name.length>150)return res.status(400).json({error:'Escribí un nombre válido para el proveedor.'});
  try{const result=db.prepare('UPDATE suppliers SET name=? WHERE id=? AND tenant_id=?').run(name,req.params.id,tenantId);if(!result.changes)return res.status(404).json({error:'Proveedor no encontrado.'});res.json(db.prepare('SELECT * FROM suppliers WHERE id=? AND tenant_id=?').get(req.params.id,tenantId));}
  catch(e){res.status(/UNIQUE/i.test(e.message)?409:400).json({error:/UNIQUE/i.test(e.message)?'Ya existe un proveedor con ese nombre.':'No se pudo actualizar el proveedor.'});}
});
app.delete('/api/suppliers/:id',(req,res)=>{
  let tx=false;try{db.exec('BEGIN IMMEDIATE');tx=true;const supplier=db.prepare('SELECT id FROM suppliers WHERE id=? AND tenant_id=?').get(req.params.id,tenantId);if(!supplier){db.exec('ROLLBACK');return res.status(404).json({error:'Proveedor no encontrado.'});}const products=db.prepare('SELECT COUNT(*) AS count FROM products WHERE tenant_id=? AND supplier_id=?').get(tenantId,supplier.id).count;const purchases=db.prepare('SELECT COUNT(*) AS count FROM purchases WHERE tenant_id=? AND supplier_id=?').get(tenantId,supplier.id).count;if(products||purchases){db.exec('ROLLBACK');return res.status(409).json({error:`No se puede eliminar: tiene ${products} producto(s) y ${purchases} compra(s) asociadas.`});}db.prepare('DELETE FROM suppliers WHERE id=? AND tenant_id=?').run(supplier.id,tenantId);db.exec('COMMIT');tx=false;res.json({ok:true});}catch{if(tx)db.exec('ROLLBACK');res.status(500).json({error:'No se pudo eliminar el proveedor.'});}
});
function getOpenCash(){
  const session=db.prepare("SELECT * FROM cash_sessions WHERE tenant_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1").get(tenantId);
  if(!session) return null;
  const totals=db.prepare('SELECT COALESCE(SUM(amount),0) AS expected,COUNT(*) AS movement_count FROM cash_movements WHERE tenant_id=? AND session_id=?').get(tenantId,session.id);
  return {...session,expected_cash:session.opening_amount+totals.expected,movement_count:totals.movement_count};
}
const paymentMethods=new Set(['efectivo','tarjeta','transferencia','qr']);
function parseHistoryOptions(req,res,{sales=false}={}){
  const page=Number(req.query.page??1),limit=Number(req.query.limit??25);
  if(!Number.isInteger(page)||page<1||!Number.isInteger(limit)||![25,50,100].includes(limit)){
    res.status(400).json({error:'La página debe ser mayor a cero y el tamaño debe ser 25, 50 o 100.'});return null;
  }
  const from=String(req.query.from||''),to=String(req.query.to||'');
  const validDate=value=>!value||(/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value);
  if(!validDate(from)||!validDate(to)){res.status(400).json({error:'Usá fechas válidas con formato AAAA-MM-DD.'});return null;}
  if(from&&to&&from>to){res.status(400).json({error:'La fecha desde no puede ser posterior a la fecha hasta.'});return null;}
  const until=to?new Date(Date.parse(`${to}T00:00:00Z`)+86400000).toISOString().slice(0,10):'';
  if(sales){
    const method=String(req.query.method||'');
    if(method&&!paymentMethods.has(method)){res.status(400).json({error:'El medio de pago seleccionado no es válido.'});return null;}
    const customerId=String(req.query.customer_id||'');
    const rawQuery=String(req.query.q||'').trim().replace(/^#/,'');
    if(rawQuery&&!/^\d+$/.test(rawQuery)){res.status(400).json({error:'Buscá por número de venta.'});return null;}
    return {page,limit,from,until,method,customerId,ticket:rawQuery?Number(rawQuery):null};
  }
  return {page,limit,from,until};
}
function salesWhere(options){
  const clauses=['sa.tenant_id=?'],values=[tenantId];
  if(options.from){clauses.push('sa.created_at>=?');values.push(`${options.from} 00:00:00`);}
  if(options.until){clauses.push('sa.created_at<?');values.push(`${options.until} 00:00:00`);}
  if(options.method){clauses.push('EXISTS(SELECT 1 FROM payments fp WHERE fp.tenant_id=sa.tenant_id AND fp.sale_id=sa.id AND fp.method=?)');values.push(options.method);}
  if(options.customerId){clauses.push('sa.customer_id=?');values.push(options.customerId);}
  if(options.ticket!==null){clauses.push('sa.ticket_number=?');values.push(options.ticket);}
  return {sql:clauses.join(' AND '),values};
}
app.get('/api/cash/sessions',(req,res)=>{
  const options=parseHistoryOptions(req,res);if(!options)return;
  const where=['cs.tenant_id=?'],values=[tenantId];
  if(options.from){where.push('cs.opened_at>=?');values.push(`${options.from} 00:00:00`);}
  if(options.until){where.push('cs.opened_at<?');values.push(`${options.until} 00:00:00`);}
  const predicate=where.join(' AND '),total=db.prepare(`SELECT COUNT(*) AS total FROM cash_sessions cs WHERE ${predicate}`).get(...values).total;
  const rows=db.prepare(`SELECT cs.id,cs.opened_at,cs.closed_at,cs.opening_amount,cs.closing_amount,cs.status,
    cs.opening_amount+COALESCE(cm.net,0) AS expected_cash,
    COALESCE(cm.income,0) AS total_income,COALESCE(cm.expense,0) AS total_expenses,COALESCE(cm.movement_count,0) AS movement_count,
    CASE WHEN cs.closing_amount IS NULL THEN NULL ELSE cs.closing_amount-(cs.opening_amount+COALESCE(cm.net,0)) END AS difference
    FROM cash_sessions cs LEFT JOIN (
      SELECT session_id,SUM(amount) AS net,SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END) AS expense,COUNT(*) AS movement_count
      FROM cash_movements WHERE tenant_id=? GROUP BY session_id
    ) cm ON cm.session_id=cs.id WHERE ${predicate}
    ORDER BY cs.opened_at DESC,cs.id DESC LIMIT ? OFFSET ?`).all(tenantId,...values,options.limit,(options.page-1)*options.limit);
  res.json({items:rows,total,page:options.page,page_size:options.limit,total_pages:Math.ceil(total/options.limit)});
});
app.get('/api/cash',(_req,res)=>res.json(getOpenCash()));
app.get('/api/cash/:id/movements',(req,res)=>{
  const session=db.prepare('SELECT * FROM cash_sessions WHERE id=? AND tenant_id=?').get(req.params.id,tenantId);
  if(!session) return res.status(404).json({error:'Sesión de caja no encontrada.'});
  const options=parseHistoryOptions(req,res);if(!options)return;
  const totals=db.prepare(`SELECT COALESCE(SUM(amount),0) AS net,
    COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0) AS total_income,
    COALESCE(SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END),0) AS total_expenses,COUNT(*) AS total
    FROM cash_movements WHERE tenant_id=? AND session_id=?`).get(tenantId,session.id);
  const movements=db.prepare(`SELECT cm.id,cm.kind,cm.amount,cm.note,cm.created_at,cm.sale_id,cm.purchase_id,cm.user_id,u.name AS user_name,
    s.ticket_number AS sale_ticket_number,p.name AS purchase_product_name
    FROM cash_movements cm LEFT JOIN sales s ON s.id=cm.sale_id AND s.tenant_id=cm.tenant_id
    LEFT JOIN users u ON u.id=cm.user_id AND u.tenant_id=cm.tenant_id
    LEFT JOIN purchases pu ON pu.id=cm.purchase_id AND pu.tenant_id=cm.tenant_id
    LEFT JOIN products p ON p.id=pu.product_id AND p.tenant_id=pu.tenant_id
    WHERE cm.tenant_id=? AND cm.session_id=? ORDER BY cm.created_at DESC,cm.id DESC LIMIT ? OFFSET ?`)
    .all(tenantId,session.id,options.limit,(options.page-1)*options.limit);
  res.json({session,expected_cash:session.opening_amount+totals.net,total_income:totals.total_income,total_expenses:totals.total_expenses,
    movements,total:totals.total,page:options.page,page_size:options.limit,total_pages:Math.ceil(totals.total/options.limit)});
});
app.post('/api/cash/open',(req,res)=>{
  let inTransaction=false;
  try {
    db.exec('BEGIN IMMEDIATE');inTransaction=true;
    if(getOpenCash()) throw Object.assign(new Error('Ya hay una caja abierta.'),{status:409});
    const amount=Number(req.body.amount);
    if(!Number.isFinite(amount)||amount<0||!isCentAmount(amount)) throw Object.assign(new Error('Ingresá un efectivo inicial válido con hasta dos decimales.'),{status:400});
    const id=randomUUID();db.prepare('INSERT INTO cash_sessions(id,tenant_id,opened_by,opening_amount) VALUES (?,?,?,?)').run(id,tenantId,req.auth.id,amount);
    db.exec('COMMIT');inTransaction=false;res.status(201).json({id});
  } catch(e) {if(inTransaction)db.exec('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'No se pudo abrir la caja.'});}
});
app.post('/api/cash/movements',(req,res)=>{
  let inTransaction=false;
  try {
    db.exec('BEGIN IMMEDIATE');inTransaction=true;
    const session=getOpenCash();if(!session)throw Object.assign(new Error('Abrí la caja antes de registrar movimientos.'),{status:409});
    const {kind,amount,note}=req.body;const value=Number(amount);
    if(!['income','expense'].includes(kind)||!Number.isFinite(value)||value<=0||!isCentAmount(value)||typeof note!=='string'||!note.trim()) throw Object.assign(new Error('Completá tipo, importe con hasta dos decimales y motivo del movimiento.'),{status:400});
    const id=randomUUID(),signed=kind==='income'?value:-value;
    db.prepare('INSERT INTO cash_movements(id,tenant_id,session_id,user_id,kind,amount,note) VALUES (?,?,?,?,?,?,?)').run(id,tenantId,session.id,req.auth.id,kind,signed,note.trim());
    db.exec('COMMIT');inTransaction=false;res.status(201).json({id,expected_cash:session.expected_cash+signed});
  } catch(e) {if(inTransaction)db.exec('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'No se pudo registrar el movimiento de caja.'});}
});
app.post('/api/cash/close',(req,res)=>{
  let inTransaction=false;
  try {
    db.exec('BEGIN IMMEDIATE');inTransaction=true;
    const session=getOpenCash();if(!session)throw Object.assign(new Error('No hay una caja abierta.'),{status:409});
    const counted=Number(req.body.counted_cash);
    if(!Number.isFinite(counted)||counted<0||!isCentAmount(counted)) throw Object.assign(new Error('Ingresá un efectivo contado válido con hasta dos decimales.'),{status:400});
    const difference=counted-session.expected_cash;
    const result=db.prepare("UPDATE cash_sessions SET status='closed',closed_at=CURRENT_TIMESTAMP,closed_by=?,closing_amount=? WHERE id=? AND tenant_id=? AND status='open'").run(req.auth.id,counted,session.id,tenantId);
    if(!result.changes)throw Object.assign(new Error('La caja ya fue cerrada.'),{status:409});
    db.exec('COMMIT');inTransaction=false;res.json({id:session.id,expected_cash:session.expected_cash,counted_cash:counted,difference});
  } catch(e) {if(inTransaction)db.exec('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'No se pudo cerrar la caja.'});}
});
app.post('/api/sales',(req,res)=>{
  let inTransaction=false;
  try {
    db.exec('BEGIN IMMEDIATE');inTransaction=true;
    const {items,payments:payList,customer_id}=req.body;
    if(!Array.isArray(items)||!items.length) throw Object.assign(new Error('El carrito está vacío.'),{status:400});
    if(items.some(item=>!item||typeof item!=='object'||Array.isArray(item)))throw Object.assign(new Error('Hay productos inválidos en el carrito.'),{status:400});
    const normalized=[];
    for(const item of items){
      const product=db.prepare('SELECT id,name,sku,unit,price,stock,active,expires_on FROM products WHERE id=? AND tenant_id=?').get(item.id,tenantId);
      const quantity=Number(item.quantity);
      if(!product||!product.active||!validQuantity(quantity,product.unit)) throw Object.assign(new Error('La cantidad debe ser positiva; los productos unitarios y packs se venden en unidades enteras.'),{status:400});
      let variant=null;
      if(item.variant_id){variant=db.prepare('SELECT id,name,sku,stock,expires_on FROM product_variants WHERE id=? AND tenant_id=? AND product_id=?').get(item.variant_id,tenantId,product.id);if(!variant)throw Object.assign(new Error('La variante seleccionada ya no está disponible.'),{status:400});}
      else if(db.prepare('SELECT 1 FROM product_variants WHERE tenant_id=? AND product_id=? LIMIT 1').get(tenantId,product.id)) throw Object.assign(new Error(`Seleccioná una variante de ${product.name}.`),{status:400});
      const available=variant?variant.stock:product.stock;
      if(quantity>available)throw Object.assign(new Error(`Stock insuficiente para ${product.name}${variant?` (${variant.name})`:''}. Disponible: ${available}.`),{status:409});
      const expiresOn=variant?variant.expires_on:product.expires_on;
      if(expiryInfo(expiresOn,available).expiry_status==='expired')throw Object.assign(new Error(`${product.name}${variant?` · ${variant.name}`:''}: producto vencido (${expiresOn}); no se puede vender.`),{status:409});
      if(!Number.isFinite(Number(product.price))||Number(product.price)<0)throw Object.assign(new Error(`El precio vigente de ${product.name} no es válido. Revisá el producto antes de venderlo.`),{status:409});
      normalized.push({product,variant,quantity,price:Number(product.price),lineTotal:roundMoney(Number(product.price)*quantity)});
    }
    const total=roundMoney(normalized.reduce((n,i)=>n+i.lineTotal,0));
    const validMethods=new Set(['efectivo','tarjeta','transferencia','qr']);
    const payments=Array.isArray(payList)?payList:[];
    const paid=payments.reduce((sum,p)=>sum+Number(p.amount),0);
    if(!payments.length||payments.some(p=>!p||typeof p!=='object'||Array.isArray(p)||!validMethods.has(p.method)||!Number.isFinite(Number(p.amount))||Number(p.amount)<=0||!isCentAmount(p.amount))||toCents(paid)!==toCents(total)) throw Object.assign(new Error('Los pagos deben cubrir el total exacto de la venta, hasta el último centavo.'),{status:400});
    const cashPaid=payments.filter(payment=>payment.method==='efectivo').reduce((sum,payment)=>sum+Number(payment.amount),0);
    const cash=getOpenCash();
    if(cashPaid>0&&!cash) throw Object.assign(new Error('No hay una caja abierta. Abrí una caja antes de registrar una venta en efectivo.'),{status:409});
    if(customer_id&&!db.prepare('SELECT id FROM customers WHERE id=? AND tenant_id=? AND active=1').get(customer_id,tenantId)) throw Object.assign(new Error('El cliente seleccionado no existe o está archivado.'),{status:400});
    const ticket=(db.prepare('SELECT COALESCE(MAX(ticket_number),0)+1 AS n FROM sales WHERE tenant_id=?').get(tenantId)).n;
    const id=randomUUID();
    db.prepare('INSERT INTO sales(id,tenant_id,user_id,customer_id,cash_session_id,ticket_number,subtotal,total) VALUES (?,?,?,?,?,?,?,?)').run(id,tenantId,req.auth.id,customer_id||null,cash?.id||null,ticket,total,total);
    const insertItem=db.prepare('INSERT INTO sale_items(id,tenant_id,sale_id,product_id,product_name,sku,quantity,unit_price,line_total,variant_id,variant_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const stock=db.prepare('UPDATE products SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=? AND stock>=?');
    const variantStock=db.prepare('UPDATE product_variants SET stock=stock-? WHERE id=? AND tenant_id=? AND stock>=?');
    for(const i of normalized) {
      const displayName=i.variant?`${i.product.name} · ${i.variant.name}`:i.product.name;
      insertItem.run(randomUUID(),tenantId,id,i.product.id,displayName,i.variant?.sku||i.product.sku,i.quantity,i.price,i.lineTotal,i.variant?.id||null,i.variant?.name||'');
      if(i.variant){
        const variantUpdate=variantStock.run(i.quantity,i.variant.id,tenantId,i.quantity);
        if(!variantUpdate.changes) throw new Error('Stock modificado durante la venta.');
      } else {
        const productUpdate=stock.run(i.quantity,i.product.id,tenantId,i.quantity);
        if(!productUpdate.changes) throw new Error('Stock modificado durante la venta.');
      }
    }
    const insertPayment=db.prepare('INSERT INTO payments(id,tenant_id,sale_id,method,amount) VALUES (?,?,?,?,?)');
    for(const p of payments) insertPayment.run(randomUUID(),tenantId,id,p.method,Number(p.amount));
    if(cashPaid>0) db.prepare("INSERT INTO cash_movements(id,tenant_id,session_id,user_id,kind,amount,note,sale_id) VALUES (?,?,?,?,'sale',?,?,?)").run(randomUUID(),tenantId,cash.id,req.auth.id,cashPaid,`Venta #${ticket}`,id);
    db.exec('COMMIT');
    inTransaction=false;
    const sale=db.prepare('SELECT id,ticket_number,total,subtotal,status,created_at FROM sales WHERE id=?').get(id);
    const details=db.prepare('SELECT product_name,sku,quantity,unit_price,line_total,variant_name FROM sale_items WHERE sale_id=?').all(id);
    const savedPayments=db.prepare('SELECT method,amount FROM payments WHERE sale_id=?').all(id);
    res.status(201).json({...sale,items:details,payments:savedPayments,customer:customer_id?db.prepare('SELECT name,tax_id FROM customers WHERE id=? AND tenant_id=?').get(customer_id,tenantId):{name:'Consumidor Final'}});
  } catch(e) {if(inTransaction)db.exec('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'No se pudo procesar la venta. No se realizaron cambios.'});}
});
app.get('/api/sales',(req,res)=>{
  const options=parseHistoryOptions(req,res,{sales:true});if(!options)return;
  const {sql,values}=salesWhere(options),total=db.prepare(`SELECT COUNT(*) AS total FROM sales sa WHERE ${sql}`).get(...values).total;
  const rows=db.prepare(`SELECT sa.id,sa.ticket_number,sa.total,sa.subtotal,sa.status,sa.created_at,sa.customer_id,
    sa.total-COALESCE(adj.amount,0) AS net_total,adj.amount AS refunded_total,adj.reason AS void_reason,adj.created_at AS voided_at,vu.name AS voided_by_name,
    cu.name AS customer_name,COALESCE((SELECT SUM(si.quantity) FROM sale_items si WHERE si.tenant_id=sa.tenant_id AND si.sale_id=sa.id),0) AS item_count,
    COALESCE((SELECT COUNT(*) FROM sale_items si WHERE si.tenant_id=sa.tenant_id AND si.sale_id=sa.id),0) AS line_count
    FROM sales sa LEFT JOIN customers cu ON cu.id=sa.customer_id AND cu.tenant_id=sa.tenant_id
    LEFT JOIN sale_adjustments adj ON adj.sale_id=sa.id AND adj.tenant_id=sa.tenant_id
    LEFT JOIN users vu ON vu.id=adj.user_id AND vu.tenant_id=adj.tenant_id
    WHERE ${sql} ORDER BY sa.created_at DESC,sa.ticket_number DESC,sa.id DESC LIMIT ? OFFSET ?`)
    .all(...values,options.limit,(options.page-1)*options.limit);
  const paymentsBySale=new Map(rows.map(row=>[row.id,[]]));
  if(rows.length){
    const ids=rows.map(row=>row.id),placeholders=ids.map(()=>'?').join(',');
    const payments=db.prepare(`SELECT sale_id,method,amount FROM payments WHERE tenant_id=? AND sale_id IN (${placeholders}) ORDER BY method`).all(tenantId,...ids);
    for(const payment of payments)paymentsBySale.get(payment.sale_id)?.push({method:payment.method,amount:payment.amount});
  }
  const items=rows.map(row=>({...row,payments:paymentsBySale.get(row.id)||[]}));
  res.json({items,total,page:options.page,page_size:options.limit,total_pages:Math.ceil(total/options.limit)});
});
app.post('/api/sales/:id/void',(req,res)=>{
  let inTransaction=false;
  try{
    const reason=String(req.body.reason||'').trim();
    if(reason.length<5||reason.length>500)throw Object.assign(new Error('Ingresá un motivo de anulación de entre 5 y 500 caracteres.'),{status:400});
    db.exec('BEGIN IMMEDIATE');inTransaction=true;
    const sale=db.prepare('SELECT id,ticket_number,total,status FROM sales WHERE id=? AND tenant_id=?').get(req.params.id,tenantId);
    if(!sale)throw Object.assign(new Error('Venta no encontrada.'),{status:404});
    if(sale.status!=='completed')throw Object.assign(new Error(sale.status==='voided'?'Esta venta ya está anulada.':'Solo se pueden anular ventas completadas.'),{status:409});
    const items=db.prepare('SELECT id,product_id,variant_id,product_name,quantity FROM sale_items WHERE tenant_id=? AND sale_id=? ORDER BY rowid').all(tenantId,sale.id);
    const payments=db.prepare('SELECT method,amount FROM payments WHERE tenant_id=? AND sale_id=? ORDER BY rowid').all(tenantId,sale.id);
    if(!items.length||!payments.length)throw Object.assign(new Error('La venta no tiene detalle o pagos suficientes para revertirla de forma segura.'),{status:409});
    const paid=payments.reduce((sum,payment)=>sum+Number(payment.amount),0);
    if(payments.some(payment=>!paymentMethods.has(payment.method)||!Number.isFinite(Number(payment.amount))||Number(payment.amount)<=0||!isCentAmount(payment.amount))||toCents(paid)!==toCents(sale.total))throw Object.assign(new Error('Los pagos guardados no coinciden con el total; no se puede anular sin revisión.'),{status:409});
    const cashAmount=payments.filter(payment=>payment.method==='efectivo').reduce((sum,payment)=>sum+Number(payment.amount),0);
    const cash=cashAmount>0?getOpenCash():null;
    if(cashAmount>0&&!cash)throw Object.assign(new Error('Esta venta tuvo un pago en efectivo. Abrí una caja para registrar la reversión antes de anularla.'),{status:409});
    for(const item of items){
      const product=db.prepare('SELECT id FROM products WHERE id=? AND tenant_id=?').get(item.product_id,tenantId);
      if(!product)throw Object.assign(new Error(`No se puede devolver el stock de ${item.product_name}: el producto ya no existe.`),{status:409});
      if(item.variant_id){
        const restored=db.prepare('UPDATE product_variants SET stock=stock+? WHERE id=? AND tenant_id=? AND product_id=?').run(item.quantity,item.variant_id,tenantId,item.product_id);
        if(!restored.changes)throw Object.assign(new Error(`No se puede devolver el stock de ${item.product_name}: la variante original ya no existe.`),{status:409});
      }else{
        const hasVariants=db.prepare('SELECT 1 FROM product_variants WHERE tenant_id=? AND product_id=? LIMIT 1').get(tenantId,item.product_id);
        if(hasVariants)throw Object.assign(new Error(`No se puede devolver el stock de ${item.product_name}: falta la variante registrada en la venta.`),{status:409});
        db.prepare('UPDATE products SET stock=stock+?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?').run(item.quantity,item.product_id,tenantId);
      }
    }
    const adjustmentId=randomUUID();
    db.prepare("INSERT INTO sale_adjustments(id,tenant_id,sale_id,user_id,kind,reason,amount) VALUES (?,?,?,?,'void',?,?)").run(adjustmentId,tenantId,sale.id,req.auth.id,reason,sale.total);
    const insertRefund=db.prepare('INSERT INTO sale_adjustment_payments(id,tenant_id,adjustment_id,method,amount) VALUES (?,?,?,?,?)');
    for(const payment of payments)insertRefund.run(randomUUID(),tenantId,adjustmentId,payment.method,payment.amount);
    if(cashAmount>0)db.prepare("INSERT INTO cash_movements(id,tenant_id,session_id,user_id,kind,amount,note,sale_id) VALUES (?,?,?,?,'sale_void',?,?,?)").run(randomUUID(),tenantId,cash.id,req.auth.id,-cashAmount,`Anulación venta #${sale.ticket_number} · ${reason}`,sale.id);
    const changed=db.prepare("UPDATE sales SET status='voided' WHERE id=? AND tenant_id=? AND status='completed'").run(sale.id,tenantId);
    if(!changed.changes)throw Object.assign(new Error('La venta cambió de estado; no se aplicó la anulación.'),{status:409});
    db.prepare("INSERT INTO admin_audit_log(id,tenant_id,actor_id,action,subject_type,subject_id) VALUES (?,?,?,'sale.void','sale',?)").run(randomUUID(),tenantId,req.auth.id,sale.id);
    db.exec('COMMIT');inTransaction=false;
    res.json({ok:true,sale_id:sale.id,status:'voided',amount:sale.total,cash_reversed:cashAmount,adjustment_id:adjustmentId});
  }catch(error){if(inTransaction)db.exec('ROLLBACK');res.status(error.status||500).json({error:error.status?error.message:'No se pudo anular la venta. No se realizaron cambios.'});}
});
app.get('/api/sales/:id',(req,res)=>{
  const sale=db.prepare(`SELECT sa.*,cu.name AS customer_name,cu.tax_id AS customer_tax_id,u.name AS user_name,
    adj.id AS adjustment_id,adj.reason AS void_reason,adj.amount AS refunded_total,adj.created_at AS voided_at,adj.user_id AS voided_by_id,vu.name AS voided_by_name
    FROM sales sa LEFT JOIN customers cu ON cu.id=sa.customer_id AND cu.tenant_id=sa.tenant_id
    LEFT JOIN users u ON u.id=sa.user_id AND u.tenant_id=sa.tenant_id
    LEFT JOIN sale_adjustments adj ON adj.sale_id=sa.id AND adj.tenant_id=sa.tenant_id
    LEFT JOIN users vu ON vu.id=adj.user_id AND vu.tenant_id=adj.tenant_id
    WHERE sa.id=? AND sa.tenant_id=?`).get(req.params.id,tenantId);
  if(!sale)return res.status(404).json({error:'Venta no encontrada.'});
  const session=sale.cash_session_id?db.prepare('SELECT id,opened_at,closed_at,status FROM cash_sessions WHERE id=? AND tenant_id=?').get(sale.cash_session_id,tenantId):null;
  const cash_movements=db.prepare('SELECT id,session_id,sale_id,kind,amount,note,created_at FROM cash_movements WHERE tenant_id=? AND sale_id=? ORDER BY created_at,id').all(tenantId,sale.id);
  const voidPayments=sale.adjustment_id?db.prepare('SELECT method,amount FROM sale_adjustment_payments WHERE tenant_id=? AND adjustment_id=? ORDER BY rowid').all(tenantId,sale.adjustment_id):[];
  res.json({...sale,net_total:Number(sale.total)-Number(sale.refunded_total||0),void:sale.adjustment_id?{id:sale.adjustment_id,reason:sale.void_reason,amount:sale.refunded_total,created_at:sale.voided_at,user_id:sale.voided_by_id,user_name:sale.voided_by_name,payments:voidPayments}:null,customer:sale.customer_id?{id:sale.customer_id,name:sale.customer_name,tax_id:sale.customer_tax_id}:null,
    session,cash_movements,
    items:db.prepare('SELECT product_id,product_name,sku,quantity,unit_price,line_total,variant_id,variant_name FROM sale_items WHERE tenant_id=? AND sale_id=? ORDER BY rowid').all(tenantId,sale.id),
    payments:db.prepare('SELECT method,amount FROM payments WHERE tenant_id=? AND sale_id=? ORDER BY rowid').all(tenantId,sale.id)});
});
app.get('/api/reports/sales',(req,res)=>{
  const options=parseHistoryOptions(req,res);if(!options)return;
  const clauses=['sa.tenant_id=?'],values=[tenantId];
  if(options.from){clauses.push('sa.created_at>=?');values.push(`${options.from} 00:00:00`);}
  if(options.until){clauses.push('sa.created_at<?');values.push(`${options.until} 00:00:00`);}
  const where=clauses.join(' AND ');
  const summary=db.prepare(`SELECT COUNT(*) AS sale_count,COALESCE(SUM(sa.total),0) AS total_sales FROM sales sa WHERE ${where} AND sa.status='completed'`).get(...values);
  const payments=db.prepare(`SELECT p.method,COALESCE(SUM(p.amount),0) AS total,COUNT(DISTINCT p.sale_id) AS sale_count
    FROM payments p JOIN sales sa ON sa.id=p.sale_id AND sa.tenant_id=p.tenant_id WHERE ${where} AND sa.status='completed' GROUP BY p.method ORDER BY p.method`).all(...values);
  const payment_totals=Object.fromEntries([...paymentMethods].map(method=>[method,0]));
  for(const payment of payments)if(Object.hasOwn(payment_totals,payment.method))payment_totals[payment.method]=payment.total;
  res.json({...summary,payment_totals,payments});
});
function customerListSql(search,includeArchived){
  const archived=includeArchived?"":"AND c.active=1";
  const needle=search?`AND (c.name LIKE ? OR COALESCE(c.tax_id,'') LIKE ? OR COALESCE(c.tax_id_normalized,'') LIKE ? OR COALESCE(c.phone,'') LIKE ? OR COALESCE(c.email,'') LIKE ?)`:'';
  const sql=`SELECT c.id,c.name,c.tax_id,c.phone,c.email,c.created_at,c.active,
    (SELECT COUNT(*) FROM sales sa WHERE sa.customer_id=c.id AND sa.tenant_id=c.tenant_id AND sa.status='completed') AS sales_count,
    (SELECT COALESCE(SUM(sa.total),0) FROM sales sa WHERE sa.customer_id=c.id AND sa.tenant_id=c.tenant_id AND sa.status='completed') AS total_purchased,
    (SELECT MAX(sa.created_at) FROM sales sa WHERE sa.customer_id=c.id AND sa.tenant_id=c.tenant_id AND sa.status='completed') AS last_sale_at
    FROM customers c WHERE c.tenant_id=? ${archived} ${needle} ORDER BY c.name`;
  const values=[tenantId];if(search)values.push(`%${search}%`,`%${search}%`,`%${normalizeTaxId(search)||search}%`,`%${search}%`,`%${search}%`);return {sql,values};
}
app.get('/api/customers',(req,res)=>{
  const search=String(req.query.search||'').trim().slice(0,100),includeArchived=req.query.include_archived==='true';
  const {sql,values}=customerListSql(search,includeArchived);res.json(db.prepare(sql).all(...values));
});
function customerInput(body){
  const name=String(body.name||'').trim(),taxId=String(body.tax_id||'').trim(),phone=String(body.phone||'').trim(),email=String(body.email||'').trim();
  if(!name||name.length>150)throw Object.assign(new Error('El nombre es obligatorio y no puede superar 150 caracteres.'),{status:400});
  if(taxId.length>40||phone.length>40||email.length>254)throw Object.assign(new Error('Revisá la longitud de los datos ingresados.'),{status:400});
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Object.assign(new Error('Ingresá un email válido.'),{status:400});
  return {name,tax_id:taxId||null,tax_id_normalized:normalizeTaxId(taxId),phone:phone||null,email:email||null};
}
app.post('/api/customers',(req,res)=>{
  try{const customer=customerInput(req.body);const id=randomUUID();db.prepare('INSERT INTO customers(id,tenant_id,name,tax_id,tax_id_normalized,phone,email) VALUES (?,?,?,?,?,?,?)').run(id,tenantId,customer.name,customer.tax_id,customer.tax_id_normalized,customer.phone,customer.email);res.status(201).json({...customer,id,active:1});}
  catch(e){const duplicate=/UNIQUE/i.test(e.message);res.status(duplicate?409:(e.status||400)).json({error:duplicate?'Ya existe un cliente con ese DNI/CUIT.':e.status?e.message:'No se pudo guardar el cliente.'});}
});
app.patch('/api/customers/:id',(req,res)=>{
  try{const customer=customerInput(req.body);const result=db.prepare('UPDATE customers SET name=?,tax_id=?,tax_id_normalized=?,phone=?,email=? WHERE id=? AND tenant_id=?').run(customer.name,customer.tax_id,customer.tax_id_normalized,customer.phone,customer.email,req.params.id,tenantId);if(!result.changes)return res.status(404).json({error:'Cliente no encontrado.'});res.json(db.prepare('SELECT id,name,tax_id,phone,email,created_at,active FROM customers WHERE id=? AND tenant_id=?').get(req.params.id,tenantId));}
  catch(e){const duplicate=/UNIQUE/i.test(e.message);res.status(duplicate?409:(e.status||400)).json({error:duplicate?'Ya existe un cliente con ese DNI/CUIT.':e.status?e.message:'No se pudo actualizar el cliente.'});}
});
app.patch('/api/customers/:id/archive',(req,res)=>{
  const active=req.body.active===true||req.body.active===1?1:req.body.active===false||req.body.active===0?0:null;if(active===null)return res.status(400).json({error:'El estado solicitado no es válido.'});
  const result=db.prepare('UPDATE customers SET active=? WHERE id=? AND tenant_id=?').run(active,req.params.id,tenantId);if(!result.changes)return res.status(404).json({error:'Cliente no encontrado.'});res.json({ok:true,active});
});
app.delete('/api/customers/:id',(req,res)=>{
  let tx=false;try{db.exec('BEGIN IMMEDIATE');tx=true;const customer=db.prepare('SELECT id,active FROM customers WHERE id=? AND tenant_id=?').get(req.params.id,tenantId);if(!customer){db.exec('ROLLBACK');return res.status(404).json({error:'Cliente no encontrado.'});}const sales=db.prepare('SELECT COUNT(*) AS count FROM sales WHERE tenant_id=? AND customer_id=?').get(tenantId,customer.id).count;if(sales){db.prepare('UPDATE customers SET active=0 WHERE id=? AND tenant_id=?').run(customer.id,tenantId);db.exec('COMMIT');tx=false;return res.json({ok:true,archived:true,message:'Cliente archivado. Sus ventas históricas se conservaron.'});}db.prepare('DELETE FROM customers WHERE id=? AND tenant_id=?').run(customer.id,tenantId);db.exec('COMMIT');tx=false;res.json({ok:true,archived:false,message:'Cliente eliminado.'});}
  catch{if(tx)db.exec('ROLLBACK');res.status(500).json({error:'No se pudo eliminar o archivar el cliente.'});}
});
app.get('/api/customers/:id/history',(req,res)=>{
  const customer=db.prepare('SELECT id,name,tax_id,phone,email,created_at,active FROM customers WHERE id=? AND tenant_id=?').get(req.params.id,tenantId);if(!customer)return res.status(404).json({error:'Cliente no encontrado.'});
  const summary=db.prepare("SELECT COUNT(*) AS sales_count,COALESCE(SUM(total),0) AS total_purchased,MAX(created_at) AS last_sale_at FROM sales WHERE tenant_id=? AND customer_id=? AND status='completed'").get(tenantId,customer.id);
  const sales=db.prepare(`SELECT sa.id,sa.ticket_number,sa.created_at,sa.total,sa.status,COALESCE((SELECT GROUP_CONCAT(method,', ') FROM (SELECT DISTINCT method FROM payments WHERE tenant_id=sa.tenant_id AND sale_id=sa.id)),'') AS payment_methods FROM sales sa WHERE sa.tenant_id=? AND sa.customer_id=? ORDER BY sa.created_at DESC,sa.ticket_number DESC LIMIT 10`).all(tenantId,customer.id);
  res.json({customer,summary,sales});
});
app.get('/api/purchases',(_req,res)=>res.json(db.prepare('SELECT pu.*,p.name AS product_name,s.name AS supplier_name FROM purchases pu JOIN products p ON p.id=pu.product_id LEFT JOIN suppliers s ON s.id=pu.supplier_id WHERE pu.tenant_id=? ORDER BY pu.created_at DESC LIMIT 100').all(tenantId)));
app.post('/api/purchases',(req,res)=>{
  const {product_id,variant_id,quantity,unit_cost,expires_on}=req.body;
  const qty=Number(quantity),cost=Number(unit_cost);
  if(!product_id||!Number.isFinite(qty)||qty<=0||!isCentAmount(qty)||!Number.isFinite(cost)||cost<0||!isCentAmount(cost)) return res.status(400).json({error:'Indicá una cantidad válida y un costo con hasta dos decimales.'});
  if(expires_on&&!validDateOnly(String(expires_on)))return res.status(400).json({error:'La fecha de vencimiento de la compra no es válida.'});
  const id=randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const product=db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(product_id,tenantId);
    if(!product) throw Object.assign(new Error('Producto no encontrado.'),{status:404});
    if(!validQuantity(qty,product.unit))throw Object.assign(new Error('Los productos unitarios y packs se reciben en cantidades enteras.'),{status:400});
    const variants=db.prepare('SELECT id,name,stock FROM product_variants WHERE product_id=? AND tenant_id=?').all(product_id,tenantId);
    let variant=null;
    if(variants.length){
      if(!variant_id) throw Object.assign(new Error('Este producto tiene variantes. Seleccioná la variante que recibió la mercadería.'),{status:400});
      variant=variants.find(item=>item.id===variant_id);
      if(!variant) throw Object.assign(new Error('La variante seleccionada no pertenece a este producto.'),{status:400});
    } else if(variant_id) throw Object.assign(new Error('Este producto no tiene variantes.'),{status:400});
    const cash=getOpenCash();
    if(!cash) throw Object.assign(new Error('No hay una caja abierta. Abrí una caja antes de registrar una compra pagada en efectivo.'),{status:409});
    const subtotal=roundMoney(qty*cost);
    db.prepare('INSERT INTO purchases(id,tenant_id,user_id,supplier_id,product_id,variant_id,variant_name,quantity,unit_cost,subtotal,expires_on) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,tenantId,req.auth.id,product.supplier_id,product_id,variant?.id||null,variant?.name||'',qty,cost,subtotal,expires_on||null);
    if(variant){db.prepare('UPDATE product_variants SET stock=stock+? WHERE id=? AND tenant_id=? AND product_id=?').run(qty,variant.id,tenantId,product_id);db.prepare('UPDATE products SET stock=0,cost=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?').run(cost,product_id,tenantId);}
    else db.prepare('UPDATE products SET stock=stock+?,cost=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?').run(qty,cost,product_id,tenantId);
    db.prepare("INSERT INTO cash_movements(id,tenant_id,session_id,user_id,kind,amount,note,purchase_id) VALUES (?,?,?,?,'purchase',?,?,?)").run(randomUUID(),tenantId,cash.id,req.auth.id,-subtotal,`Compra #${id.slice(0,8)} · ${product.name}${variant?` · ${variant.name}`:''}`,id);
    db.exec('COMMIT');res.status(201).json({id});
  } catch(e) {db.exec('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'No se pudo registrar la compra. No se realizaron cambios.'});}
});
app.use((error,_req,res,_next)=>{
  if(res.headersSent)return;
  if(error.status===400||error.type==='entity.parse.failed')return res.status(400).json({error:'La solicitud contiene JSON inválido.'});
  res.status(500).json({error:'No se pudo completar la consulta. Intentá nuevamente.'});
});
const port=Number(process.env.KIOSCO_PORT)||3001;
app.listen(port,'127.0.0.1',()=>console.log(`API local lista en http://127.0.0.1:${port}`));

