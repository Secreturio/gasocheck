// GasoCheck — lógica del servidor, independiente de dónde se ejecute:
//  - En Netlify: netlify/functions/api.mjs (peticiones /api/*) y netlify/functions/actualizar.mjs (cada 30 min).
//  - En tu ordenador: server/index.js (npm start / npm run demo).
// Recibe un Request estándar y devuelve un Response estándar. La lista de rutas está más abajo, en RUTAS.

import crypto from 'node:crypto';
import { crearEstaciones } from './estaciones.js';
import { crearAlmacenReportes, PROBLEMAS } from './reportes.js';
import { crearHistorico, sembrarDemo, hoyMadrid } from './historico.js';
import { crearCuentas, VERSION_CONDICIONES, esPro } from './cuentas.js';
import { crearProveedores, SERVICIOS, COMBUSTIBLES_DECLARABLES } from './proveedores.js';
import { crearCorreo } from './correo.js';
import { abrirBD, CLAVE_BD } from './db.js';
import { crearReputacion } from './reputacion.js';
import { crearWebPush } from './webpush.js';
import { crearAvisos } from './avisos.js';
import { consejo } from './consejo.js';
import { validarTicket } from './ticket.js';
import { crearFlotas } from './flotas.js';
import { crearFotos } from './fotos.js';
import { crearFotoCoche } from './fotocoche.js';

export const VERSION = '1.8.0';

/* ---------------- Utilidades HTTP ---------------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};
const SEGURIDAD = {
  'X-Content-Type-Options': 'nosniff',
  // Solo se envía el dominio (nunca la ruta): los enlaces de verificación llevan tokens en la URL.
  'Referrer-Policy': 'strict-origin',
  'X-Frame-Options': 'DENY',
};

class Respuesta {
  constructor(status, cuerpo) {
    this.status = status;
    this.cuerpo = cuerpo;
  }
}
const error = (status, mensaje) => new Respuesta(status, { error: mensaje });

const json = (status, obj, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...SEGURIDAD, ...extra },
  });

const binario = (datos, tipo, cache) =>
  new Response(datos, { status: 200, headers: { 'Content-Type': tipo, 'Cache-Control': cache, ...CORS, ...SEGURIDAD } });

const distanciaKm = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Identidad para límites y "mis valoraciones": la cuenta si hay sesión, si no la IP
const identidad = (c) => (c.usuario ? 'u:' + c.usuario.id : c.ip);

export async function crearApp({ almacen, demo = false, appUrl = '' }) {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
  const SOLO_REGISTRADOS = process.env.REPORTES_SOLO_REGISTRADOS === '1';
  const APP_URL = String(appUrl || '').replace(/\/$/, '');

  const db = await abrirBD(almacen);
  const correo = crearCorreo();
  const reputacion = crearReputacion(db);
  const reportes = crearAlmacenReportes(db, reputacion);
  const historico = crearHistorico(almacen);
  const cuentas = crearCuentas(db, { correo, appUrl: APP_URL });
  const proveedores = crearProveedores(db, reputacion);
  const estaciones = crearEstaciones(almacen, { demo });
  // Las claves de notificaciones se leen (o se crean) la primera vez que hacen falta
  let pushListo = null;
  const obtenerPush = () => (pushListo ||= crearWebPush(almacen, { sujeto: process.env.PUSH_CONTACTO || 'mailto:gasochecklegal@gmail.com' }).catch((e) => {
    pushListo = null;
    throw e;
  }));
  const push = demo ? null : { enviar: async (...a) => (await obtenerPush()).enviar(...a) };
  const avisos = crearAvisos(db, { push, reportes, proveedores });
  const flotas = crearFlotas(db);
  const fotos = crearFotos(almacen);
  const fotoCoche = crearFotoCoche(almacen);

  // Búsquedas de foto del coche: como mucho 20 por hora y persona (Wikipedia pide un uso moderado)
  const busquedasCoche = new Map();
  function puedeBuscarCoche(quien) {
    const ahora = Date.now();
    const lista = (busquedasCoche.get(quien) || []).filter((t) => ahora - t < 3600 * 1000);
    if (lista.length >= 20) return false;
    lista.push(ahora);
    busquedasCoche.set(quien, lista);
    return true;
  }

  /* ---------- Una petición a la vez sobre la base de datos ---------- */
  let cadena = Promise.resolve();
  const enSerie = (fn) => {
    const p = cadena.then(fn, fn);
    cadena = p.catch(() => {});
    return p;
  };

  // Ejecuta fn con la base de datos al día y guarda los cambios. Si otra copia de la función guardó
  // antes, se descarta lo hecho y se repite (como mucho 6 veces). Con opcional, no se repite:
  // si no se pudo guardar, se pierde ese cambio (p. ej. el contador de visitas) y se responde igual.
  async function conBD(fn, { opcional = false } = {}) {
    for (let intento = 0; ; intento++) {
      await db.sincronizar();
      correo.empezar();
      const despues = [];
      let resultado, fallo = null, hayFallo = false;
      try {
        resultado = await fn(despues);
      } catch (e) {
        fallo = e;
        hayFallo = true;
      }
      let guardado;
      try {
        guardado = await db.guardar();
      } catch (e) {
        db.descartar();
        correo.descartar();
        throw e;
      }
      if (guardado || opcional) {
        if (guardado) {
          await correo.vaciar();
          for (const f of despues) await f().catch((e) => console.error('Tarea posterior fallida:', e.message));
        } else correo.descartar();
        if (hayFallo) throw fallo;
        return resultado;
      }
      correo.descartar();
      if (intento >= 5) throw new Error('La base de datos está muy ocupada. Inténtalo de nuevo.');
      await esperar(40 + Math.random() * 120 * (intento + 1));
    }
  }

  /* ---------- Datos de gasolineras ---------- */
  const indices = new WeakMap();
  const porIdDe = (d) => {
    let m = indices.get(d);
    if (!m) indices.set(d, (m = new Map(d.estaciones.map((e) => [e.id, e]))));
    return m;
  };
  const datosOk = () => estaciones.obtener().catch(() => null);
  const existeEstacion = async (id) => {
    const d = await datosOk();
    return d ? porIdDe(d).has(id) : true;
  };
  const preciosOficiales = async (id) => {
    const d = await datosOk();
    return (d && porIdDe(d).get(id)?.precios) || {};
  };
  const nombreEstacion = async (id) => {
    const d = await datosOk();
    const e = d && porIdDe(d).get(id);
    return e ? { id, rotulo: e.rotulo, direccion: e.direccion, localidad: e.localidad, provincia: e.provincia } : { id };
  };

  // Tras cada actualización de precios: alertas de precio y de calidad
  async function evaluarAvisos(datos) {
    const porId = porIdDe(datos);
    const extras = proveedores.extras();
    const precioActual = (id, c) => porId.get(id)?.precios[c] ?? extras[id]?.d?.[c]?.[0] ?? null;
    const nombreDe = (id) => {
      const e = porId.get(id);
      return e ? `${e.rotulo} (${e.localidad})` : 'Tu gasolinera';
    };
    return avisos.evaluar(precioActual, nombreDe);
  }

  let estacionesTxt = { ref: null, txt: '' };

  /* ---------------- Rutas ----------------
     Cada ruta: [método, patrón, opciones, manejador(c)]
     opciones: { sesion: 'obligatoria' | 'proveedor' | 'empresa', admin: true, cuerpo: bytes máximos,
                 bd: false (no usa la base de datos), opcional: true (escritura que se puede perder) } */
  const RUTAS = [
    // ---- Precios ----
    ['GET', '/api/estaciones', { bd: false }, async (c) => {
      let datos;
      try {
        datos = await estaciones.obtener();
      } catch (err) {
        console.error('Error cargando estaciones:', err.message);
        return error(502, 'No se pudieron cargar los precios del Ministerio. Inténtalo de nuevo en unos minutos.');
      }
      const cab = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        // La CDN de Netlify la guarda 5 minutos: casi ninguna visita llega a ejecutar la función
        'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800',
        Vary: 'Accept-Encoding',
        ...CORS,
        ...SEGURIDAD,
      };
      // Sin comprimir aquí (≈4 MB, por debajo del límite de 6 MB de las funciones):
      // la CDN de Netlify la comprime con brotli/gzip al enviarla (≈200 KB)
      if (estacionesTxt.ref !== datos) estacionesTxt = { ref: datos, txt: JSON.stringify(datos) };
      return new Response(estacionesTxt.txt, { status: 200, headers: cab });
    }],
    ['GET', /^\/api\/estaciones\/([^/]+)\/historico$/, { bd: false, cdn: 1800 }, async (c) => ({ serie: await historico.deEstacion(c.p[0]) })],
    ['GET', '/api/tendencia', { bd: false, cdn: 600 }, async (c) => {
      const provincia = c.url.searchParams.get('provincia') || '';
      return { ambito: provincia || 'España', serie: await historico.tendencia(provincia) };
    }],
    ['GET', '/api/variaciones', { bd: false, cdn: 600 }, async () => ({ dias: 7, variaciones: await historico.variaciones() })],

    // ---- Calidad ----
    ['GET', '/api/calidad', {}, () => ({ calidad: reportes.resumenGlobal() })],
    ['GET', '/api/problemas', { bd: false }, () => ({ problemas: PROBLEMAS, servicios: SERVICIOS, soloRegistrados: SOLO_REGISTRADOS, condiciones: VERSION_CONDICIONES })],
    ['GET', /^\/api\/estaciones\/([^/]+)\/reportes$/, { opcional: true }, (c) => {
      proveedores.contarVisita(c.p[0]);
      return reportes.deEstacion(c.p[0], identidad(c));
    }],
    ['POST', /^\/api\/estaciones\/([^/]+)\/reportes$/, {}, async (c) => {
      const id = c.p[0];
      if (SOLO_REGISTRADOS && !c.usuario) return error(401, 'Inicia sesión para valorar gasolineras.');
      if (SOLO_REGISTRADOS && !c.usuario.verificado) return error(403, 'Confirma tu correo electrónico para poder valorar.');
      if (c.usuario && c.usuario.rol !== 'usuario') return error(403, 'Las cuentas de gasolinera o de empresa no pueden valorar. Usa una cuenta personal.');
      if (!(await existeEstacion(id))) return error(404, 'Esa gasolinera no existe en el listado oficial.');
      const autor = c.usuario ? { id: c.usuario.id, alias: c.usuario.alias, verificado: c.usuario.verificado } : null;
      let ticket = null;
      if (c.body.ticket) {
        if (!c.usuario) return error(401, 'Inicia sesión para añadir el ticket a tu valoración.');
        const comb = String(c.body.combustible || '');
        const ref = (await preciosOficiales(id))[comb] ?? proveedores.extras()[id]?.d?.[comb]?.[0];
        const v = validarTicket(c.body.ticket, ref);
        if (v.error) return error(400, v.error);
        ticket = v.ticket;
      }
      const r = reportes.crear(id, c.body, identidad(c), autor, ticket);
      if (r.error) return error(r.status || 400, r.error);
      return new Respuesta(201, r);
    }],
    ['PUT', /^\/api\/reportes\/([^/]+)$/, {}, (c) => {
      const r = reportes.editar(c.p[0], c.body, identidad(c), c.usuario?.id);
      return r.error ? error(r.status || 400, r.error) : r;
    }],
    ['DELETE', /^\/api\/reportes\/([^/]+)$/, {}, (c) => {
      const r = reportes.eliminar(c.p[0], identidad(c), c.usuario?.id);
      return r.error ? error(r.status || 400, r.error) : r;
    }],
    ['POST', /^\/api\/reportes\/([^/]+)\/denuncia$/, {}, (c) => {
      const r = reportes.denunciar(c.p[0], identidad(c));
      return r.error ? error(r.status || 400, r.error) : r;
    }],

    // ---- Fichas ampliadas (públicas) ----
    ['POST', /^\/api\/estaciones\/([^/]+)\/precios\/correccion$/, { sesion: 'obligatoria' }, async (c) => {
      const r = proveedores.corregirPrecio(c.usuario, c.p[0], c.body, await preciosOficiales(c.p[0]));
      return r.error ? error(r.status, r.error) : r;
    }],
    ['GET', /^\/api\/estaciones\/([^/]+)\/ficha$/, {}, (c) => proveedores.ficha(c.p[0])],
    ['GET', '/api/extras', {}, () => ({ extras: proveedores.extras() })],

    // ---- Cuentas ----
    ['POST', '/api/auth/registro', {}, async (c) => new Respuesta(201, await cuentas.registrar(c.body, c.ip, c.req.headers['user-agent']))],
    ['POST', '/api/auth/entrar', {}, (c) => cuentas.entrar(c.body, c.ip, c.req.headers['user-agent'])],
    ['POST', '/api/auth/salir', { sesion: 'obligatoria' }, (c) => {
      if (c.body.todas) cuentas.salirDeTodo(c.usuario);
      else cuentas.salir(c.usuario, c.req.sesionHash);
      return { ok: true };
    }],
    ['GET', '/api/auth/yo', { sesion: 'obligatoria' }, (c) => ({ usuario: cuentas.publico(c.usuario), reputacion: reputacion.de(c.usuario.id) })],
    ['POST', '/api/auth/verificar', {}, (c) => ({ usuario: cuentas.verificar(c.body.token) })],
    ['POST', '/api/auth/reenviar', { sesion: 'obligatoria' }, async (c) => {
      await cuentas.reenviarVerificacion(c.usuario);
      return { ok: true };
    }],
    ['POST', '/api/auth/olvido', {}, async (c) => {
      await cuentas.olvido(c.body, c.ip);
      return { ok: true };
    }],
    ['POST', '/api/auth/restablecer', {}, async (c) => cuentas.restablecer(c.body, c.req.headers['user-agent'])],

    ['POST', '/api/cuenta/password', { sesion: 'obligatoria' }, (c) => cuentas.cambiarPassword(c.usuario, c.body, c.req.headers['user-agent'])],
    ['POST', '/api/cuenta/perfil', { sesion: 'obligatoria' }, (c) => ({ usuario: cuentas.actualizarPerfil(c.usuario, c.body) })],
    ['GET', '/api/cuenta/datos', { sesion: 'obligatoria' }, (c) => cuentas.leerDatos(c.usuario)],
    ['PUT', '/api/cuenta/datos', { sesion: 'obligatoria', cuerpo: 600 * 1024 }, (c) => cuentas.guardarDatos(c.usuario, c.body)],
    // Foto orientativa del coche (Wikipedia / Wikimedia Commons)
    ['GET', '/api/coche/foto', { bd: false }, async (c) => {
      if (!puedeBuscarCoche(identidad(c))) return error(429, 'Demasiadas búsquedas de fotos. Prueba dentro de un rato.');
      const q = c.url.searchParams;
      return fotoCoche.obtener({ marca: q.get('marca'), modelo: q.get('modelo'), anio: q.get('anio') });
    }],
    ['GET', /^\/api\/coche\/foto\/([a-f0-9]{20})$/, { bd: false }, async (c) => {
      const f = await fotoCoche.imagen(c.p[0]);
      if (!f) return error(404, 'No hay foto.');
      return binario(f.datos, f.tipo, 'public, max-age=604800');
    }],
    // ---- Fotos de tickets de "Mis repostajes" y de perfil (privadas) ----
    ['PUT', /^\/api\/cuenta\/fotos\/([^/]+)$/, { sesion: 'obligatoria', cuerpo: 1300 * 1024 }, async (c) => {
      const r = await fotos.guardar(c.usuario, c.p[0], c.body.datos);
      return r.error ? error(r.status, r.error) : r;
    }],
    ['GET', /^\/api\/cuenta\/fotos\/([^/]+)$/, { sesion: 'obligatoria' }, async (c) => {
      const f = await fotos.leer(c.usuario, c.p[0]);
      if (!f) return error(404, 'No hay foto.');
      return binario(f.datos, f.tipo, 'private, max-age=86400');
    }],
    ['DELETE', /^\/api\/cuenta\/fotos\/([^/]+)$/, { sesion: 'obligatoria' }, async (c) => {
      const r = await fotos.borrar(c.usuario, c.p[0]);
      return r.error ? error(r.status, r.error) : r;
    }],
    ['GET', '/api/cuenta/reportes', { sesion: 'obligatoria' }, async (c) => ({
      reportes: await Promise.all(reportes.deUsuario(c.usuario.id).map(async (r) => ({ ...r, gasolinera: await nombreEstacion(r.estacion) }))),
    })],
    ['GET', '/api/cuenta/exportar', { sesion: 'obligatoria' }, async (c) => ({
      ...(await cuentas.exportar(c.usuario)),
      valoraciones: reportes.deUsuario(c.usuario.id),
      fotosDeTickets: (await fotos.lista(c.usuario)).length,
      correccionesPrecio: db.todos('SELECT estacion, combustible, precio, fecha FROM correcciones_precio WHERE usuario = ?', c.usuario.id),
      ...(c.usuario.rol === 'proveedor' ? { reclamaciones: proveedores.reclamacionesDe(c.usuario.id) } : {}),
      exportado: new Date().toISOString(),
    })],
    ['POST', '/api/cuenta/borrar', { sesion: 'obligatoria' }, async (c) => {
      // Todo en la misma transacción: si algo falla, no se borra nada
      await cuentas.borrar(c.usuario, c.body, (u) => {
        reportes.anonimizarUsuario(u.id);
        if (u.rol === 'proveedor') proveedores.olvidarUsuario(u.id);
      });
      // Las fotos se borran cuando la base de datos ya está guardada
      const id = c.usuario.id;
      c.despues.push(() => fotos.borrarTodas(id));
      return { ok: true };
    }],

    // ---- Panel de gasolinera ----
    ['GET', '/api/proveedor/panel', { sesion: 'proveedor' }, async (c) => {
      const u = c.usuario;
      const ids = proveedores.estacionesDe(u.id);
      const lista = [];
      for (const id of ids) {
        lista.push({
          ...(await nombreEstacion(id)),
          calidad: reportes.deEstacion(id),
          visitas30: proveedores.visitas30(id),
          ficha: proveedores.ficha(id),
          oficiales: await preciosOficiales(id),
          correcciones: proveedores.correccionesPendientes(id),
        });
      }
      const reclamaciones = [];
      for (const r of proveedores.reclamacionesDe(u.id)) reclamaciones.push({ ...r, gasolinera: await nombreEstacion(r.estacion) });
      return { cuenta: cuentas.publico(u), estaciones: lista, reclamaciones, servicios: SERVICIOS, problemas: PROBLEMAS, combustibles: COMBUSTIBLES_DECLARABLES };
    }],
    ['POST', '/api/proveedor/reclamaciones', { sesion: 'proveedor' }, async (c) => {
      const ok = await existeEstacion(String(c.body.estacion || ''));
      const r = proveedores.reclamar(c.usuario, c.body, () => ok);
      return r.error ? error(r.status, r.error) : new Respuesta(201, r);
    }],
    ['POST', /^\/api\/proveedor\/estaciones\/([^/]+)\/ficha$/, { sesion: 'proveedor' }, (c) => {
      const r = proveedores.editarFicha(c.usuario, c.p[0], c.body);
      return r.error ? error(r.status, r.error) : r;
    }],
    ['POST', /^\/api\/proveedor\/estaciones\/([^/]+)\/precios$/, { sesion: 'proveedor' }, async (c) => {
      const r = proveedores.declararPrecios(c.usuario, c.p[0], c.body.precios, await preciosOficiales(c.p[0]));
      return r.error ? error(r.status, r.error) : r;
    }],
    ['GET', /^\/api\/proveedor\/estaciones\/([^/]+)\/precios$/, { sesion: 'proveedor' }, (c) => {
      if (!proveedores.esDueno(c.usuario.id, c.p[0])) return error(403, 'Esta gasolinera no está asociada a tu cuenta.');
      return { historial: proveedores.historialPrecios(c.p[0]) };
    }],
    ['POST', /^\/api\/proveedor\/reportes\/([^/]+)\/respuesta$/, { sesion: 'proveedor' }, (c) => {
      const u = c.usuario;
      const r = reportes.responder(c.p[0], c.body.texto, u.proveedor.empresa, (est) => proveedores.esDueno(u.id, est));
      return r.error ? error(r.status, r.error) : r;
    }],

    // ---- ¿Lleno ahora o espero? ----
    ['GET', '/api/consejo', { bd: false, cdn: 600 }, async (c) => {
      const provincia = c.url.searchParams.get('provincia') || '';
      const comb = c.url.searchParams.get('combustible') || 'gasoleoA';
      return { ambito: provincia || 'España', ...consejo(await historico.tendencia(provincia), comb, hoyMadrid()) };
    }],

    // ---- Gasolineras cercanas en formato compacto (widget, Android Auto, CarPlay) ----
    ['GET', '/api/cercanas', { bd: false }, async (c) => {
      const lat = Number(c.url.searchParams.get('lat'));
      const lng = Number(c.url.searchParams.get('lng'));
      const comb = c.url.searchParams.get('combustible') || 'gasoleoA';
      const n = Math.min(20, Math.max(1, Number(c.url.searchParams.get('n')) || 5));
      const radio = Math.min(50, Math.max(1, Number(c.url.searchParams.get('radio')) || 10));
      if (!c.url.searchParams.get('lat') || !c.url.searchParams.get('lng') || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return error(400, 'Indica lat y lng.');
      const d = await estaciones.obtener();
      const yo = { lat, lng };
      const lista = d.estaciones
        .filter((e) => e.venta === 'publico' && e.precios[comb] != null && Math.abs(e.lat - lat) < radio / 100 && Math.abs(e.lng - lng) < radio / 70)
        .map((e) => ({ e, km: distanciaKm(yo, e) }))
        .filter((x) => x.km <= radio)
        .sort((a, b) => a.e.precios[comb] - b.e.precios[comb] || a.km - b.km)
        .slice(0, n)
        .map(({ e, km }) => ({ id: e.id, rotulo: e.rotulo, direccion: e.direccion, localidad: e.localidad, lat: e.lat, lng: e.lng, precio: e.precios[comb], km: Math.round(km * 10) / 10 }));
      return { combustible: comb, actualizado: d.fecha, gasolineras: lista };
    }],

    // ---- Alertas, avisos y notificaciones ----
    ['GET', '/api/alertas', { sesion: 'obligatoria' }, async (c) => {
      const alertas = [];
      for (const a of avisos.alertasDe(c.usuario)) alertas.push({ ...a, gasolinera: await nombreEstacion(a.estacion) });
      return { alertas };
    }],
    ['POST', '/api/alertas', { sesion: 'obligatoria' }, async (c) => {
      const ok = await existeEstacion(String(c.body.estacion || ''));
      const r = avisos.crearAlerta(c.usuario, c.body, () => ok);
      return r.error ? error(r.status, r.error) : new Respuesta(201, r);
    }],
    ['DELETE', /^\/api\/alertas\/([^/]+)$/, { sesion: 'obligatoria' }, (c) => {
      const r = avisos.borrarAlerta(c.usuario, c.p[0]);
      return r.error ? error(r.status, r.error) : r;
    }],
    ['GET', '/api/avisos', { sesion: 'obligatoria' }, (c) => avisos.bandeja(c.usuario)],
    ['POST', '/api/avisos/leidos', { sesion: 'obligatoria' }, (c) => avisos.marcarLeidos(c.usuario)],
    ['GET', '/api/push/clave', { bd: false }, async () => {
      if (demo) return error(503, 'Notificaciones desactivadas en el modo demostración.');
      return { clave: (await obtenerPush()).clavePublica };
    }],
    ['POST', '/api/push/suscribir', { sesion: 'obligatoria' }, (c) => {
      const r = avisos.suscribir(c.usuario, c.body);
      return r.error ? error(r.status, r.error) : r;
    }],
    ['POST', '/api/push/desuscribir', { sesion: 'obligatoria' }, (c) => avisos.desuscribir(c.usuario, c.body)],

    // ---- GasoCheck Pro para gasolineras ----
    ['GET', /^\/api\/proveedor\/estaciones\/([^/]+)\/estadisticas$/, { sesion: 'proveedor' }, async (c) => {
      const id = c.p[0];
      if (!proveedores.esDueno(c.usuario.id, id)) return error(403, 'Esta gasolinera no está asociada a tu cuenta.');
      if (!esPro(c.usuario)) return error(402, 'Las estadísticas avanzadas son una función de GasoCheck Pro.');
      const d = await estaciones.obtener();
      const yo = porIdDe(d).get(id);
      const competencia = {};
      if (yo) {
        const cerca = d.estaciones.filter((e) => e.venta === 'publico' && e.id !== id && distanciaKm(yo, e) <= 5);
        for (const [comb, p] of Object.entries(yo.precios)) {
          const otros = cerca.filter((e) => e.precios[comb] != null).map((e) => e.precios[comb]);
          if (!otros.length) continue;
          const todos = [...otros, p].sort((a, b) => a - b);
          competencia[comb] = {
            tuPrecio: p,
            posicion: todos.indexOf(p) + 1,
            de: todos.length,
            media: Math.round((otros.reduce((a, b) => a + b, 0) / otros.length) * 1000) / 1000,
            min: Math.min(...otros),
            max: Math.max(...otros),
          };
        }
      }
      return {
        competencia,
        radioKm: 5,
        notaMensual: proveedores.notaMensual(id),
        visitas: proveedores.visitasDiarias(id),
        seguidores: avisos.seguidores(id),
        ultimoMensaje: avisos.ultimoMensaje(id),
      };
    }],
    ['POST', /^\/api\/proveedor\/estaciones\/([^/]+)\/mensaje$/, { sesion: 'proveedor' }, async (c) => {
      const n = await nombreEstacion(c.p[0]);
      const r = await avisos.mensajeASeguidores(c.usuario, c.p[0], c.body.texto, { esPro: esPro(c.usuario), nombre: `${n.rotulo || c.usuario.proveedor.empresa}${n.localidad ? ' · ' + n.localidad : ''}` });
      return r.error ? error(r.status, r.error) : r;
    }],

    // ---- GasoCheck Empresas: panel de la empresa ----
    ['GET', '/api/empresa/panel', { sesion: 'empresa' }, (c) => ({
      cuenta: cuentas.publico(c.usuario),
      maxVehiculosGratis: 5,
      ...flotas.panel(c.usuario, { desde: c.url.searchParams.get('desde') || '', hasta: c.url.searchParams.get('hasta') || '' }),
    })],
    ['POST', '/api/empresa/vehiculos', { sesion: 'empresa' }, (c) => {
      const r = flotas.guardarVehiculo(c.usuario, c.body, esPro(c.usuario));
      return r.error ? error(r.status, r.error) : r;
    }],
    ['DELETE', /^\/api\/empresa\/vehiculos\/([^/]+)$/, { sesion: 'empresa' }, (c) => {
      const r = flotas.bajaVehiculo(c.usuario, c.p[0]);
      return r.error ? error(r.status, r.error) : r;
    }],
    ['POST', '/api/empresa/codigo', { sesion: 'empresa' }, (c) => flotas.regenerarCodigo(c.usuario)],
    ['DELETE', /^\/api\/empresa\/conductores\/([^/]+)$/, { sesion: 'empresa' }, (c) => flotas.expulsar(c.usuario, c.p[0])],

    // ---- GasoCheck Empresas: lado del conductor ----
    ['GET', '/api/flotas', { sesion: 'obligatoria' }, (c) => ({ flotas: flotas.misFlotas(c.usuario) })],
    ['POST', '/api/flotas/unirse', { sesion: 'obligatoria' }, (c) => {
      const r = flotas.unirse(c.usuario, c.body.codigo);
      return r.error ? error(r.status, r.error) : r;
    }],
    ['DELETE', /^\/api\/flotas\/([^/]+)$/, { sesion: 'obligatoria' }, (c) => flotas.dejar(c.usuario, c.p[0])],
    ['POST', '/api/flotas/repostajes', { sesion: 'obligatoria' }, async (c) => {
      const d = await datosOk();
      const porId = d ? porIdDe(d) : new Map();
      const r = flotas.registrarRepostaje(c.usuario, c.body, {
        precioOficial: (id, comb) => porId.get(id)?.precios[comb] ?? null,
        nombreEstacion: (id) => (porId.get(id) ? `${porId.get(id).rotulo} · ${porId.get(id).localidad}` : ''),
      });
      return r.error ? error(r.status, r.error) : new Respuesta(201, r);
    }],

    // ---- Solo en modo demostración: evaluar los avisos ahora, sin esperar a la próxima actualización ----
    ['POST', '/api/demo/evaluar', {}, async () => {
      if (!demo) return error(404, 'Ruta no encontrada.');
      await evaluarAvisos(await estaciones.obtener());
      return { ok: true };
    }],

    // ---- Moderación ----
    ['GET', '/api/admin/reportes', { admin: true }, (c) => ({ reportes: reportes.listarAdmin(c.url.searchParams.get('filtro') || 'denunciados') })],
    ['POST', /^\/api\/admin\/reportes\/([^/]+)$/, { admin: true }, (c) => {
      const r = reportes.moderar(c.p[0], c.body.accion);
      return r.error ? error(r.status || 400, r.error) : r;
    }],
    ['GET', '/api/admin/cuentas', { admin: true }, () => ({ cuentas: cuentas.listarProfesionales() })],
    ['POST', /^\/api\/admin\/cuentas\/([^/]+)\/plan$/, { admin: true }, (c) => ({ cuenta: cuentas.fijarPlan(c.p[0], c.body.plan, c.body.hasta) })],
    ['GET', '/api/admin/reclamaciones', { admin: true }, async (c) => {
      const lista = proveedores.listarReclamaciones(c.url.searchParams.get('estado') || 'pendiente');
      const out = [];
      for (const r of lista) {
        const u = cuentas.porId(r.usuario);
        out.push({ ...r, gasolinera: await nombreEstacion(r.estacion), cuenta: u ? cuentas.publico(u) : null, dueno: proveedores.duenoDe(r.estacion)?.usuario === r.usuario ? null : proveedores.duenoDe(r.estacion) });
      }
      return { reclamaciones: out };
    }],
    ['POST', /^\/api\/admin\/reclamaciones\/([^/]+)$/, { admin: true }, (c) => {
      const r = proveedores.resolverReclamacion(c.p[0], c.body.accion, c.body.nota);
      return r.error ? error(r.status, r.error) : r;
    }],
    // Descargar los precios ahora mismo (sin esperar a la actualización programada)
    ['POST', '/api/admin/actualizar', { admin: true, bd: false }, async () => ({ ok: true, ...(await actualizar()) })],
    // Estado del servicio (para comprobar que todo funciona tras publicar)
    ['GET', '/api/estado', { bd: false }, async () => {
      const d = await datosOk();
      return {
        version: VERSION,
        almacen: almacen.tipo,
        demo,
        gasolineras: d ? d.estaciones.length : 0,
        fechaPrecios: d?.fecha || null,
        descargado: d?.descargado ? new Date(d.descargado).toISOString() : null,
        diasHistorial: await historico.numDias(),
        correoReal: correo.real,
        moderacion: Boolean(ADMIN_TOKEN),
      };
    }],
  ];

  function esAdmin(headers) {
    if (!ADMIN_TOKEN) return false;
    const dado = (headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(dado);
    const b = Buffer.from(ADMIN_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Convierte lo que devuelve una ruta en un Response
  function aResponse(r, op) {
    if (r instanceof Response) return r;
    if (r instanceof Respuesta) return json(r.status, r.cuerpo);
    const extra = op.cdn ? { 'Cache-Control': 'public, max-age=300', 'Netlify-CDN-Cache-Control': `public, s-maxage=${op.cdn}, stale-while-revalidate=${op.cdn}` } : {};
    return json(200, r, extra);
  }

  async function manejar(request, { ip = 'desconocida' } = {}) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return json(400, { error: 'Petición no válida.' });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const ruta = url.pathname.replace(/\/+$/, '') || '/';
    let encontrada = null;
    let p = [];
    let metodoValido = false;
    for (const r of RUTAS) {
      const m = typeof r[1] === 'string' ? (r[1] === ruta ? [] : null) : ruta.match(r[1]);
      if (!m) continue;
      if (r[0] !== request.method) {
        metodoValido = true;
        continue;
      }
      encontrada = r;
      try {
        p = (Array.isArray(m) ? m.slice(1) : []).map((x) => decodeURIComponent(x));
      } catch {
        return json(400, { error: 'Petición no válida.' });
      }
      break;
    }
    if (!encontrada) return json(metodoValido ? 405 : 404, { error: metodoValido ? 'Método no permitido.' : 'Ruta no encontrada.' });

    const [, , op, fn] = encontrada;
    const headers = Object.fromEntries([...request.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const c = { req: { headers }, url, p, ip, usuario: null, body: {}, despues: [] };

    try {
      if (op.admin) {
        if (!ADMIN_TOKEN) return json(503, { error: 'Moderación desactivada: define la variable ADMIN_TOKEN en Netlify.' });
        if (!esAdmin(headers)) return json(401, { error: 'Clave de moderación incorrecta.' });
      }
      if (request.method === 'POST' || request.method === 'PUT') {
        const max = op.cuerpo || 16_000;
        const texto = await request.text();
        if (Buffer.byteLength(texto) > max) return json(413, { error: 'La petición es demasiado grande.' });
        try {
          c.body = texto ? JSON.parse(texto) : {};
        } catch {
          return json(400, { error: 'Petición no válida.' });
        }
        if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) c.body = {};
      }

      if (op.bd === false) return aResponse(await fn(c), op);

      const r = await enSerie(() =>
        conBD(async (despues) => {
          c.despues = despues;
          c.req.sesionHash = undefined;
          c.usuario = cuentas.autenticar(c.req);
          if (op.sesion && !c.usuario) return error(401, 'Tu sesión ha caducado. Vuelve a entrar.');
          if (op.sesion === 'proveedor' && c.usuario.rol !== 'proveedor') return error(403, 'Esta sección es solo para cuentas de gasolinera.');
          if (op.sesion === 'empresa' && c.usuario.rol !== 'empresa') return error(403, 'Esta sección es solo para cuentas de empresa.');
          return fn(c);
        }, { opcional: op.opcional })
      );
      return aResponse(r, op);
    } catch (err) {
      if (err instanceof Respuesta) return json(err.status, err.cuerpo);
      if (err instanceof cuentas.ErrorCuenta) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'Error interno. Inténtalo de nuevo.' });
    }
  }

  /* ---------------- Actualización programada (cada 30 minutos) ---------------- */
  // Descarga los precios, guarda el historial, envía avisos, limpia y hace la copia diaria.
  async function actualizar({ tiempoMax = 22_000 } = {}) {
    const t0 = Date.now();
    const datos = await estaciones.actualizar({ tiempoMax });
    const dias = demo ? await historico.numDias() : await historico.registrar(datos);
    let enviados = 0;
    await enSerie(() =>
      conBD(async () => {
        enviados = await evaluarAvisos(datos);
        mantenimiento();
      })
    );
    if (!demo) await copiaDiaria().catch((e) => console.error('No se pudo hacer la copia de seguridad:', e.message));
    const resumen = { gasolineras: datos.estaciones.length, fecha: datos.fecha, diasHistorial: dias, avisos: enviados, ms: Date.now() - t0 };
    console.log('Actualización:', JSON.stringify(resumen));
    return resumen;
  }

  // Borra sesiones y enlaces caducados y visitas de hace más de 90 días (solo escribe si hay algo que borrar)
  function mantenimiento() {
    const ahora = Date.now();
    if (db.uno('SELECT 1 AS si FROM sesiones WHERE expira < ? LIMIT 1', ahora)) db.ejecutar('DELETE FROM sesiones WHERE expira < ?', ahora);
    if (db.uno('SELECT 1 AS si FROM tokens WHERE expira < ? LIMIT 1', ahora)) db.ejecutar('DELETE FROM tokens WHERE expira < ?', ahora);
    const limite = new Date(ahora - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (db.uno('SELECT 1 AS si FROM visitas WHERE dia < ? LIMIT 1', limite)) db.ejecutar('DELETE FROM visitas WHERE dia < ?', limite);
  }

  // Copia de seguridad de la base de datos una vez al día; se guardan las 14 últimas (copias/)
  async function copiaDiaria() {
    const destino = `copias/gasocheck-${hoyMadrid()}.sqlite`;
    const existentes = await almacen.listar('copias/');
    if (existentes.includes(destino)) return;
    const actual = await almacen.leer(CLAVE_BD, { tipo: 'buffer' });
    if (!actual?.datos) return;
    await almacen.escribir(destino, actual.datos, { siNuevo: true });
    const viejas = [...existentes, destino].filter((k) => /gasocheck-\d{4}-\d{2}-\d{2}\.sqlite$/.test(k)).sort().slice(0, -14);
    for (const k of viejas) await almacen.borrar(k);
    console.log('Copia de seguridad guardada:', destino);
  }

  // Solo modo demostración: inventa el historial la primera vez
  async function prepararDemo() {
    const datos = await estaciones.obtener();
    if ((await historico.numDias()) === 0) {
      await sembrarDemo(historico, datos);
      await historico.registrar(datos);
    }
  }

  // Plan B por si la función programada no llega a tiempo (el Ministerio a veces tarda mucho):
  // si los precios tienen más de 70 minutos, una petición los actualiza en segundo plano.
  let ultimoIntento = 0;
  function quizaActualizar() {
    if (demo || estaciones.edad() < 70 * 60 * 1000 || estaciones.edad() === Infinity) return null;
    if (Date.now() - ultimoIntento < 15 * 60 * 1000) return null;
    ultimoIntento = Date.now();
    return actualizar({ tiempoMax: 40_000 }).catch((e) => console.warn('Actualización en segundo plano fallida:', e.message));
  }

  return { manejar, actualizar, quizaActualizar, prepararDemo, correoReal: correo.real, moderacion: Boolean(ADMIN_TOKEN) };
}
