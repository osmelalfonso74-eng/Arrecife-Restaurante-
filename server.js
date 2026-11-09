'use strict';
// Arrecife · Alta Cocina · servidor. Requiere Node.js 18 o superior. Sin dependencias.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOADS = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = process.env.PORT || 3000;
const PUBLICOS = new Set(['index.html', 'logo.jpg', 'terraza.jpg']);

// ---------- Administrador (solo contraseña) ----------
let ADMIN_PASS = process.env.ADMIN_PASS || '';
if (!ADMIN_PASS) {
  ADMIN_PASS = crypto.randomBytes(9).toString('base64url');
  console.warn('[AVISO] No definiste ADMIN_PASS. Contraseña temporal: ' + ADMIN_PASS);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sessions = new Map();
const loginFails = new Map();
const reservaHits = new Map();

function countHit(map, ip, ventanaMs) {
  const now = Date.now();
  let e = map.get(ip);
  if (!e || now - e.desde > ventanaMs) { e = { n: 0, desde: now }; map.set(ip, e); }
  return e;
}
function ipDe(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'x';
}
function tokenDe(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function sesionValida(req) {
  const t = tokenDe(req);
  if (!t) return false;
  const v = sessions.get(t);
  if (!v) return false;
  if (v < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function cookie(valor, segundos, req) {
  const seguro = req.headers['x-forwarded-proto'] === 'https' || process.env.HTTPS === '1';
  return 'sid=' + valor + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + segundos + (seguro ? '; Secure' : '');
}

// ---------- Datos ----------
fs.mkdirSync(UPLOADS, { recursive: true });
function cargarDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return {}; }
}
const db = Object.assign({ platos: [], reservas: [] }, cargarDB());
function guardarDB() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const esHora = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
const limpio = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
const MESAS = ['1', '2', '3', '4'];
const nuevoId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

// ---------- Respuestas ----------
function json(res, code, obj, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {});
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}
function leerJSON(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { const e = new Error('Datos demasiado grandes.'); e.status = 413; reject(e); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { const err = new Error('Datos no válidos.'); err.status = 400; reject(err); }
    });
    req.on('error', reject);
  });
}

// ---------- Públicas ----------
function listaPlatos() {
  return db.platos.map((p) => ({ id: p.id, nombre: p.nombre, tipo: p.tipo, espec: p.espec, foto: p.foto }));
}

async function crearReserva(req, res) {
  const e = countHit(reservaHits, ipDe(req), 3600000);
  if (e.n >= 30) return json(res, 429, { error: 'Demasiadas solicitudes. Intenta más tarde.' });
  e.n++;
  const b = await leerJSON(req, 5000);
  const mesa = String(b.mesa || '');
  if (!MESAS.includes(mesa)) return json(res, 400, { error: 'Elige una mesa.' });
  const nombre = limpio(b.nombre, 60);
  if (nombre.length < 2) return json(res, 400, { error: 'Falta tu nombre.' });
  const telefono = limpio(b.telefono, 25);
  if (telefono.replace(/\D/g, '').length < 7) return json(res, 400, { error: 'Escribe un número de WhatsApp válido.' });
  const fecha = String(b.fecha || '');
  if (!esFecha(fecha)) return json(res, 400, { error: 'Fecha no válida.' });
  if (fecha < hoy()) return json(res, 400, { error: 'La fecha ya pasó.' });
  const hora = String(b.hora || '');
  if (!esHora(hora)) return json(res, 400, { error: 'Hora no válida.' });
  if (db.reservas.some((r) => r.mesa === mesa && r.fecha === fecha && r.hora === hora)) {
    return json(res, 409, { error: 'La Mesa ' + mesa + ' ya está reservada a esa hora. Elige otra mesa u otra hora.' });
  }
  const r = { id: nuevoId(), mesa, nombre, telefono, fecha, hora, creada: new Date().toISOString() };
  db.reservas.push(r);
  guardarDB();
  const msg = 'Hola Arrecife! Quiero reservar la Mesa ' + mesa + '.\nNombre: ' + nombre + '\nFecha: ' + fecha + '\nHora: ' + hora + '\nTeléfono: ' + telefono;
  return json(res, 200, { ok: true, waUrl: 'https://wa.me/' + CFG.whatsapp + '?text=' + encodeURIComponent(msg) });
}

// ---------- Administrador ----------
async function login(req, res) {
  const ip = ipDe(req);
  const e = countHit(loginFails, ip, 15 * 60 * 1000);
  if (e.n >= 10) return json(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
  const b = await leerJSON(req, 1000);
  if (!sameSecret(String(b.pass || ''), ADMIN_PASS)) { e.n++; return json(res, 401, { error: 'Contraseña incorrecta' }); }
  loginFails.delete(ip);
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + 12 * 3600 * 1000);
  return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(t, 12 * 3600, req) });
}

async function adminApi(req, res, p) {
  const m = req.method;
  let x;
  if (m === 'POST' && p === '/api/admin/platos') {
    const b = await leerJSON(req, 3000000);
    const nombre = limpio(b.nombre, 60);
    const espec = limpio(b.espec, 1000);
    const tipo = b.tipo === 'bebida' ? 'bebida' : 'plato';
    if (!nombre) return json(res, 400, { error: 'Falta el nombre.' });
    const pre = 'data:image/jpeg;base64,';
    if (typeof b.foto !== 'string' || !b.foto.startsWith(pre)) return json(res, 400, { error: 'La foto no es válida.' });
    const buf = Buffer.from(b.foto.slice(pre.length), 'base64');
    if (buf.length < 100 || buf.length > 2500000) return json(res, 400, { error: 'La foto es demasiado grande.' });
    const id = nuevoId();
    const archivo = id + '.jpg';
    fs.writeFileSync(path.join(UPLOADS, archivo), buf);
    db.platos.unshift({ id, nombre, tipo, espec, foto: '/uploads/' + archivo });
    guardarDB();
    return json(res, 200, { ok: true });
  }
  if (m === 'DELETE' && (x = /^\/api\/admin\/platos\/(\d+)$/.exec(p))) {
    const id = Number(x[1]);
    const plato = db.platos.find((q) => q.id === id);
    if (!plato) return json(res, 404, { error: 'No encontrado.' });
    db.platos = db.platos.filter((q) => q.id !== id);
    guardarDB();
    try { fs.unlinkSync(path.join(UPLOADS, path.basename(plato.foto))); } catch (e) {}
    return json(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/admin/reservas') {
    return json(res, 200, db.reservas.slice().sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora)));
  }
  if (m === 'DELETE' && (x = /^\/api\/admin\/reservas\/(\d+)$/.exec(p))) {
    const id = Number(x[1]);
    db.reservas = db.reservas.filter((q) => q.id !== id);
    guardarDB();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'No encontrado.' });
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  if (m === 'GET' && p === '/api/platos') return json(res, 200, listaPlatos());
  if (m === 'POST' && p === '/api/reservas') return crearReserva(req, res);
  if (m === 'POST' && p === '/api/admin/login') return login(req, res);
  if (m === 'POST' && p === '/api/admin/logout') {
    const t = tokenDe(req);
    if (t) sessions.delete(t);
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0, req) });
  }
  if (p.startsWith('/api/admin/')) {
    if (!sesionValida(req)) return json(res, 401, { error: 'Sesión vencida. Vuelve a entrar.' });
    return adminApi(req, res, p);
  }
  return json(res, 404, { error: 'No encontrado.' });
}

// ---------- Archivos ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png' };
function enviarArchivo(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(file).pipe(res);
  });
}
function estatico(res, p) {
  if (p.startsWith('/uploads/')) {
    const nombre = path.basename(p);
    if (!/^\d+\.jpg$/.test(nombre)) { res.writeHead(404); return res.end(); }
    return enviarArchivo(res, path.join(UPLOADS, nombre), 'public, max-age=86400');
  }
  let nombre = p === '/' ? 'index.html' : p.slice(1);
  if (!PUBLICOS.has(nombre)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
  return enviarArchivo(res, path.join(ROOT, nombre), nombre.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
}

// ---------- Servidor ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return estatico(res, url.pathname);
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    return json(res, 500, { error: 'Error interno del servidor.' });
  }
});
server.listen(PORT, () => console.log('Arrecife funcionando en el puerto ' + PORT));
