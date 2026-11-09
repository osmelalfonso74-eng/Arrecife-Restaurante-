// Arrecife · Alta Cocina · API para Netlify (funciones + almacenamiento Netlify Blobs)
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const WHATSAPP_INICIAL = "5356146377";
// Contraseña del administrador (cámbiala aquí si quieres otra).
const ADMIN_PASS = "1234";
const MESAS = ["1", "2", "3", "4"];
const HORAS = ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00"];

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
const limpio = (s, max) => String(s ?? "").trim().slice(0, max);
const nuevoId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

// ---------- Administrador ----------
const sha = (s) => createHash("sha256").update(String(s)).digest();
const iguales = (a, b) => timingSafeEqual(sha(a), sha(b));
function firmar(exp) {
  return createHmac("sha256", "arrecife-sesion:" + ADMIN_PASS).update(String(exp)).digest("hex");
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
  const ip = req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "x";
  const clave = "fallos/" + ip;
  const previo = (await tienda().get(clave, { type: "json" })) || { n: 0, t: Date.now() };
  const reciente = Date.now() - previo.t < VENTANA;
  if (reciente && previo.n >= 10) throw error(429, "Demasiados intentos. Espera 15 minutos.");
  const b = await leerJSON(req, 1000);
  if (!iguales(String(b.pass || ""), ADMIN_PASS)) {
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

// ---------- Platos ----------
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
  const tipo = ["plato", "bebida", "bienvenida"].includes(b.tipo) ? b.tipo : "plato";
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

async function foto(id) {
  const data = await tienda().get("img/" + id, { type: "arrayBuffer" });
  if (!data) return new Response("No encontrado", { status: 404 });
  return new Response(data, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
}

// ---------- Número de WhatsApp (editable desde el admin) ----------
async function whatsapp() {
  const c = await tienda().get("config", { type: "json" });
  return (c && c.whatsapp) || WHATSAPP_INICIAL;
}

async function guardarWhatsapp(req) {
  const b = await leerJSON(req, 500);
  const numero = String(b.whatsapp || "").replace(/\D/g, "");
  if (numero.length < 7 || numero.length > 15) {
    throw error(400, "Escribe un número de WhatsApp válido, con código de país (ej: 5356146377).");
  }
  await tienda().setJSON("config", { whatsapp: numero });
  return json({ ok: true, whatsapp: numero });
}

// ---------- Ocupación: reservas + horas bloqueadas por el admin ----------
const idBloqueo = (mesa, fecha, hora) => `${mesa}_${fecha}_${hora.replace(":", "")}`;

async function ocupacionesDelDia(fecha) {
  const reservas = (await listar("res/")).filter((r) => r.fecha === fecha);
  const bloqueos = (await listar("bloq/")).filter((b) => b.fecha === fecha);
  return [...reservas, ...bloqueos];
}

async function disponibilidad(url) {
  const fecha = url.searchParams.get("fecha") || "";
  if (!esFecha(fecha)) throw error(400, "Fecha no válida.");
  const ocupadas = {};
  MESAS.forEach((m) => (ocupadas[m] = []));
  (await ocupacionesDelDia(fecha)).forEach((x) => {
    if (ocupadas[x.mesa]) ocupadas[x.mesa].push(x.hora);
  });
  return json({ horas: HORAS, ocupadas });
}

async function listarBloqueos() {
  const bloqueos = await listar("bloq/");
  return bloqueos.sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
}

async function crearBloqueos(req) {
  const b = await leerJSON(req, 5000);
  const mesa = String(b.mesa || "");
  if (!MESAS.includes(mesa)) throw error(400, "Elige una mesa.");
  const fecha = String(b.fecha || "");
  if (!esFecha(fecha)) throw error(400, "Fecha no válida.");
  const horas = Array.isArray(b.horas) ? b.horas.map(String) : [];
  const validas = horas.filter((h) => HORAS.includes(h));
  if (!validas.length) throw error(400, "Marca al menos una hora.");
  for (const hora of validas) {
    const id = idBloqueo(mesa, fecha, hora);
    await tienda().setJSON("bloq/" + id, { id, mesa, fecha, hora });
  }
  return json({ ok: true, creadas: validas.length });
}

// ---------- Reservas ----------
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
  if (!HORAS.includes(hora)) throw error(400, "Elige una hora válida.");

  const ocupada = (await ocupacionesDelDia(fecha)).some((x) => x.mesa === mesa && x.hora === hora);
  if (ocupada) {
    throw error(409, "La Mesa " + mesa + " no está disponible a las " + hora + ". Elige otra mesa u otra hora.");
  }
  const r = { id: nuevoId(), mesa, nombre, telefono, fecha, hora, vista: false, creada: new Date().toISOString() };
  await tienda().setJSON("res/" + r.id, r);
  const msg = "Hola Arrecife! Quiero reservar la Mesa " + mesa + ".\nNombre: " + nombre + "\nFecha: " + fecha + "\nHora: " + hora + "\nTeléfono: " + telefono;
  return json({ ok: true, waUrl: "https://wa.me/" + (await whatsapp()) + "?text=" + encodeURIComponent(msg) });
}

async function marcarVista(id, req) {
  const b = await leerJSON(req, 200);
  const r = await tienda().get("res/" + id, { type: "json" });
  if (!r) throw error(404, "Reserva no encontrada.");
  r.vista = !!b.vista;
  await tienda().setJSON("res/" + id, r);
  return json({ ok: true });
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const p = url.pathname.replace(/^\/api/, "");
    const m = req.method;
    let x;

    if (m === "GET" && p === "/config") return json({ whatsapp: await whatsapp() });
    if (m === "GET" && p === "/platos") return json(await listarPlatos());
    if (m === "GET" && p === "/disponibilidad") return await disponibilidad(url);
    if (m === "GET" && (x = /^\/foto\/(\d+)$/.exec(p))) return await foto(x[1]);
    if (m === "POST" && p === "/reservas") return await crearReserva(req);
    if (m === "POST" && p === "/admin/login") return await login(req);
    if (m === "POST" && p === "/admin/logout") {
      return json({ ok: true }, 200, { "Set-Cookie": "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure" });
    }

    if (p.startsWith("/admin/")) {
      if (!sesionValida(req)) return json({ error: "Sesión vencida. Vuelve a entrar." }, 401);
      if (m === "GET" && p === "/admin/config") return json({ whatsapp: await whatsapp() });
      if (m === "POST" && p === "/admin/config") return await guardarWhatsapp(req);
      if (m === "POST" && p === "/admin/platos") return await crearPlato(req);
      if (m === "DELETE" && (x = /^\/admin\/platos\/(\d+)$/.exec(p))) return await borrarPlato(x[1]);
      if (m === "GET" && p === "/admin/reservas") {
        const reservas = await listar("res/");
        return json(reservas.sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora)));
      }
      if (m === "POST" && (x = /^\/admin\/reservas\/(\d+)\/vista$/.exec(p))) return await marcarVista(x[1], req);
      if (m === "DELETE" && (x = /^\/admin\/reservas\/(\d+)$/.exec(p))) {
        await tienda().delete("res/" + x[1]).catch(() => {});
        return json({ ok: true });
      }
      if (m === "GET" && p === "/admin/bloqueos") return json(await listarBloqueos());
      if (m === "POST" && p === "/admin/bloqueos") return await crearBloqueos(req);
      if (m === "DELETE" && (x = /^\/admin\/bloqueos\/([A-Za-z0-9_-]+)$/.exec(p))) {
        await tienda().delete("bloq/" + x[1]).catch(() => {});
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
