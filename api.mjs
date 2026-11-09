// Arrecife · Alta Cocina · API para Netlify (funciones + almacenamiento Netlify Blobs)
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const WHATSAPP = "5356146377";
const MESAS = ["1", "2", "3", "4"];

const tienda = () => getStore("arrecife");

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}
function error(status, mensaje) {
  const e = new Error(mensaje);
  e.status = status;
  return e;
}
async function leerJSON(req, max = 50000) {
  const texto = await req.text();
  if (texto.length > max) throw error(413, "Datos demasiado grandes.");
  try {
    return JSON.parse(texto || "{}");
  } catch {
    throw error(400, "Datos no válidos.");
  }
}

const hoy = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Havana", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(Date.parse(s + "T00:00:00Z"));
const esHora = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
const limpio = (s, max) => String(s ?? "").trim().slice(0, max);
const nuevoId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

// ---------- Administrador ----------
const sha = (s) => createHash("sha256").update(String(s)).digest();
const iguales = (a, b) => timingSafeEqual(sha(a), sha(b));
function firmar(exp) {
  return createHmac("sha256", "arrecife-sesion:" + (process.env.ADMIN_PASS || "")).update(String(exp)).digest("hex");
}
function sesionValida(req) {
  const m = /(?:^|;\s*)sid=(\d+)\.([a-f0-9]{64})/.exec(req.headers.get("cookie") || "");
  if (!m) return false;
  if (Number(m[1]) < Date.now()) return false;
  const esperado = Buffer.from(firmar(m[1]));
  const recibido = Buffer.from(m[2]);
  return esperado.length === recibido.length && timingSafeEqual(esperado, recibido);
}
const VENTANA = 15 * 60 * 1000;

async function login(req) {
  const pass = process.env.ADMIN_PASS || "";
  if (!pass) throw error(500, "Falta configurar ADMIN_PASS en Netlify (Site configuration → Environment variables).");
  const ip = req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "x";
  const clave = "fallos/" + ip;
  const previo = (await tienda().get(clave, { type: "json" })) || { n: 0, t: Date.now() };
  const reciente = Date.now() - previo.t < VENTANA;
  if (reciente && previo.n >= 10) throw error(429, "Demasiados intentos. Espera 15 minutos.");
  const b = await leerJSON(req, 1000);
  if (!iguales(String(b.pass || ""), pass)) {
    const nuevo = reciente ? { n: previo.n + 1, t: previo.t } : { n: 1, t: Date.now() };
    await tienda().setJSON(clave, nuevo);
    throw error(401, "Contraseña incorrecta");
  }
  await tienda().delete(clave).catch(() => {});
  const exp = Date.now() + 12 * 3600 * 1000;
  return json({ ok: true }, 200, {
    "Set-Cookie": `sid=${exp}.${firmar(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200; Secure`,
  });
}

async function listar(prefijo) {
  const { blobs } = await tienda().list({ prefix: prefijo });
  const items = await Promise.all(blobs.map((b) => tienda().get(b.key, { type: "json" })));
  return items.filter(Boolean);
}

async function listarPlatos() {
  const platos = await listar("plato/");
  return platos
    .sort((a, b) => b.id - a.id)
    .map((p) => ({ id: p.id, nombre: p.nombre, tipo: p.tipo, espec: p.espec, foto: "/api/foto/" + p.id }));
}

async function crearPlato(req) {
  const b = await leerJSON(req, 3000000);
  const nombre = limpio(b.nombre, 60);
  const espec = limpio(b.espec, 1000);
  const tipo = b.tipo === "bebida" ? "bebida" : "plato";
  if (!nombre) throw error(400, "Falta el nombre.");
  const pre = "data:image/jpeg;base64,";
  if (typeof b.foto !== "string" || !b.foto.startsWith(pre)) throw error(400, "La foto no es válida.");
  const bytes = Buffer.from(b.foto.slice(pre.length), "base64");
  if (bytes.length < 100 || bytes.length > 2500000) throw error(400, "La foto es demasiado grande.");
  const id = nuevoId();
  await tienda().set("img/" + id, new Blob([bytes], { type: "image/jpeg" }));
  await tienda().setJSON("plato/" + id, { id, nombre, tipo, espec });
  return json({ ok: true });
}

async function borrarPlato(id) {
  await tienda().delete("plato/" + id).catch(() => {});
  await tienda().delete("img/" + id).catch(() => {});
  return json({ ok: true });
}

async function crearReserva(req) {
  const b = await leerJSON(req, 5000);
  const mesa = String(b.mesa || "");
  if (!MESAS.includes(mesa)) throw error(400, "Elige una mesa.");
  const nombre = limpio(b.nombre, 60);
  if (nombre.length < 2) throw error(400, "Falta tu nombre.");
  const telefono = limpio(b.telefono, 25);
  if (telefono.replace(/\D/g, "").length < 7) throw error(400, "Escribe un número de WhatsApp válido.");
  const fecha = String(b.fecha || "");
  if (!esFecha(fecha)) throw error(400, "Fecha no válida.");
  if (fecha < hoy()) throw error(400, "La fecha ya pasó.");
  const hora = String(b.hora || "");
  if (!esHora(hora)) throw error(400, "Hora no válida.");

  const existentes = await listar("res/");
  if (existentes.some((r) => r.mesa === mesa && r.fecha === fecha && r.hora === hora)) {
    throw error(409, "La Mesa " + mesa + " ya está reservada a esa hora. Elige otra mesa u otra hora.");
  }
  const r = { id: nuevoId(), mesa, nombre, telefono, fecha, hora, creada: new Date().toISOString() };
  await tienda().setJSON("res/" + r.id, r);
  const msg = "Hola Arrecife! Quiero reservar la Mesa " + mesa + ".\nNombre: " + nombre + "\nFecha: " + fecha + "\nHora: " + hora + "\nTeléfono: " + telefono;
  return json({ ok: true, waUrl: "https://wa.me/" + WHATSAPP + "?text=" + encodeURIComponent(msg) });
}

async function foto(id) {
  const data = await tienda().get("img/" + id, { type: "arrayBuffer" });
  if (!data) return new Response("No encontrado", { status: 404 });
  return new Response(data, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const p = url.pathname.replace(/^\/api/, "");
    const m = req.method;
    let x;

    if (m === "GET" && p === "/platos") return json(await listarPlatos());
    if (m === "GET" && (x = /^\/foto\/(\d+)$/.exec(p))) return await foto(x[1]);
    if (m === "POST" && p === "/reservas") return await crearReserva(req);
    if (m === "POST" && p === "/admin/login") return await login(req);
    if (m === "POST" && p === "/admin/logout") {
      return json({ ok: true }, 200, { "Set-Cookie": "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure" });
    }

    if (p.startsWith("/admin/")) {
      if (!sesionValida(req)) return json({ error: "Sesión vencida. Vuelve a entrar." }, 401);
      if (m === "POST" && p === "/admin/platos") return await crearPlato(req);
      if (m === "DELETE" && (x = /^\/admin\/platos\/(\d+)$/.exec(p))) return await borrarPlato(x[1]);
      if (m === "GET" && p === "/admin/reservas") {
        const reservas = await listar("res/");
        return json(reservas.sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora)));
      }
      if (m === "DELETE" && (x = /^\/admin\/reservas\/(\d+)$/.exec(p))) {
        await tienda().delete("res/" + x[1]).catch(() => {});
        return json({ ok: true });
      }
    }
    return json({ error: "No encontrado." }, 404);
  } catch (e) {
    if (e.status) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Error interno del servidor." }, 500);
  }
};

export const config = { path: "/api/*" };
