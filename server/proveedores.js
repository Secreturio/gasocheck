// Gasolineras (proveedores): reclamar una gasolinera, ficha ampliada, visitas y precios declarados (SQLite).
// La propiedad la aprueba un administrador a mano: cualquiera podría decir que una gasolinera es suya.

import crypto from 'node:crypto';

export const SERVICIOS = {
  tienda: 'Tienda',
  cafeteria: 'Cafetería',
  lavado: 'Lavado',
  aspirador: 'Aspirador',
  aire_agua: 'Aire y agua',
  adblue: 'AdBlue en surtidor',
  aseos: 'Aseos',
  cargador_ev: 'Cargador eléctrico',
  atendida: 'Atención en surtidor',
  autoservicio: 'Autoservicio',
  pago_movil: 'Pago con el móvil',
  camiones: 'Acceso para camiones',
};

// Precios declarados
export const COMBUSTIBLES_DECLARABLES = ['gasoleoA', 'gasoleoPremium', 'gasolina95', 'gasolina98', 'glp'];
const DIA = 24 * 3600 * 1000;
// Corrección por los usuarios: si varios con cuenta indican el mismo precio, sustituye al declarado
export const CONSENSO_MIN = 3; // usuarios distintos que deben coincidir
const CONSENSO_MARGEN = 0.01; // € de diferencia para considerar que coinciden
const CONSENSO_VENTANA_MS = 72 * 3600 * 1000; // solo cuentan las indicaciones de las últimas 72 h
const MAX_DESVIO = 0.25; // no se acepta un precio que se aleje más de un 25 % del oficial (evita errores de tecleo)
const PRECIO_MIN = 0.3;
const PRECIO_MAX = 4;

const hoy = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
const limpiarTexto = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B-\u001F]/g, '').trim().slice(0, max);
const fallo = (status, error) => ({ status, error });

export function crearProveedores(db, reputacion) {
  const pesoU = (u) => (reputacion ? reputacion.peso(u) : 1);
  const duenoDe = (estacion) => db.uno(`SELECT * FROM reclamaciones WHERE estacion = ? AND estado = 'aprobada'`, estacion);
  const esDueno = (usuarioId, estacion) => Boolean(db.uno(`SELECT 1 AS si FROM reclamaciones WHERE usuario = ? AND estacion = ? AND estado = 'aprobada'`, usuarioId, estacion));

  // Las visitas de hace más de 90 días se borran en el mantenimiento diario (app.js → mantenimiento)

  // Indicaciones de usuarios posteriores al último precio que publicó la gasolinera
  function indicaciones(estacion, combustible, decl) {
    const desde = Math.max(decl.fecha, Date.now() - CONSENSO_VENTANA_MS);
    return db.todos('SELECT usuario, precio, fecha FROM correcciones_precio WHERE estacion = ? AND combustible = ? AND fecha > ?', estacion, combustible, desde);
  }

  // Busca el grupo más grande de indicaciones que coinciden entre sí y difieren del precio declarado
  function consenso(estacion, combustible, decl) {
    const lista = indicaciones(estacion, combustible, decl).filter((x) => Math.abs(x.precio - decl.precio) >= 0.005);
    // Cada indicación pesa según la fiabilidad de quien la hace
    let mejor = null, pesoMejor = 0;
    for (const x of lista) {
      const grupo = lista.filter((y) => Math.abs(y.precio - x.precio) <= CONSENSO_MARGEN);
      const w = grupo.reduce((a, y) => a + pesoU(y.usuario), 0);
      if (!mejor || w > pesoMejor) {
        mejor = grupo;
        pesoMejor = w;
      }
    }
    const n = mejor ? mejor.length : 0;
    const precios = mejor ? mejor.map((y) => y.precio).sort((a, b) => a - b) : [];
    const mediana = n ? (n % 2 ? precios[n >> 1] : (precios[n / 2 - 1] + precios[n / 2]) / 2) : null;
    return {
      n,
      precio: mediana != null ? Math.round(mediana * 1000) / 1000 : null,
      fecha: n ? Math.max(...mejor.map((y) => y.fecha)) : null,
      peso: +pesoMejor.toFixed(2),
      // 3 usuarios normales, o 2 si son muy fiables; nunca uno solo
      alcanzado: n >= 2 && pesoMejor >= CONSENSO_MIN - 1e-9,
      grupo: mejor || [],
      otros: lista.filter((y) => !(mejor || []).includes(y)),
    };
  }

  // Precio en el hueco "de la gasolinera": el suyo, o el de los usuarios si hay consenso
  // { combustible: { precio, fecha, origen: 'gasolinera' | 'usuarios', n?, declarado? } }
  function declaradosDe(estacion) {
    const out = {};
    for (const f of db.todos('SELECT combustible, precio, fecha FROM precios_declarados WHERE estacion = ?', estacion)) {
      const c = consenso(estacion, f.combustible, f);
      out[f.combustible] = c.alcanzado
        ? { precio: c.precio, fecha: c.fecha, origen: 'usuarios', n: c.n, declarado: { precio: f.precio, fecha: f.fecha } }
        : { precio: f.precio, fecha: f.fecha, origen: 'gasolinera' };
    }
    return out;
  }

  return {
    SERVICIOS,

    // ---- Públicas ----
    ficha(estacion) {
      const f = db.uno('SELECT * FROM fichas WHERE estacion = ?', estacion);
      const promo = f && f.promo_texto && f.promo_hasta >= hoy() ? { texto: f.promo_texto, hasta: f.promo_hasta } : null;
      return {
        verificada: Boolean(duenoDe(estacion)),
        servicios: f ? JSON.parse(f.servicios) : [],
        telefono: f?.telefono || '',
        web: f?.web || '',
        descripcion: f?.descripcion || '',
        promocion: promo,
        actualizado: f?.actualizado || null,
        precios: declaradosDe(estacion),
      };
    },

    // Resumen ligero para la lista y el mapa: verificadas, con promoción y precios declarados
    // { id: { v: 1, p: 1, s: ['tienda', 'lavado'], d: { gasoleoA: [precio, fecha] } } }
    extras() {
      const out = {};
      for (const r of db.todos(`SELECT estacion FROM reclamaciones WHERE estado = 'aprobada'`)) (out[r.estacion] ||= {}).v = 1;
      for (const f of db.todos('SELECT estacion FROM fichas WHERE promo_texto IS NOT NULL AND promo_hasta >= ?', hoy())) (out[f.estacion] ||= {}).p = 1;
      // Servicios que declara la gasolinera verificada (tienda, lavado…), para las etiquetas y filtros de la lista
      for (const f of db.todos(`SELECT f.estacion, f.servicios FROM fichas f JOIN reclamaciones r ON r.estacion = f.estacion AND r.estado = 'aprobada'`)) {
        let s = [];
        try { s = JSON.parse(f.servicios || '[]'); } catch { /* ficha antigua */ }
        if (s.length) (out[f.estacion] ||= {}).s = s;
      }
      // [precio, fecha, origen ('g' gasolinera | 'u' usuarios), nº de usuarios]
      const conCorrecciones = new Set(db.todos('SELECT DISTINCT estacion FROM correcciones_precio WHERE fecha > ?', Date.now() - CONSENSO_VENTANA_MS).map((r) => r.estacion));
      for (const f of db.todos('SELECT estacion, combustible, precio, fecha FROM precios_declarados')) {
        let v = [f.precio, f.fecha, 'g'];
        if (conCorrecciones.has(f.estacion)) {
          const c = consenso(f.estacion, f.combustible, f);
          if (c.alcanzado) v = [c.precio, c.fecha, 'u', c.n];
        }
        ((out[f.estacion] ||= {}).d ||= {})[f.combustible] = v;
      }
      return out;
    },

    contarVisita(estacion) {
      db.ejecutar('INSERT INTO visitas (estacion, dia, n) VALUES (?, ?, 1) ON CONFLICT(estacion, dia) DO UPDATE SET n = n + 1', estacion, hoy());
    },

    duenoDe,
    esDueno,

    // ---- Proveedor ----
    reclamar(u, body, existeEstacion) {
      if (u.rol !== 'proveedor') return fallo(403, 'Solo las cuentas de gasolinera pueden reclamar gasolineras.');
      if (!u.verificado) return fallo(403, 'Confirma primero tu correo electrónico.');
      const estacion = String(body.estacion || '');
      if (!existeEstacion(estacion)) return fallo(404, 'Esa gasolinera no está en el listado oficial.');
      if (db.uno(`SELECT 1 AS si FROM reclamaciones WHERE usuario = ? AND estacion = ? AND estado IN ('pendiente', 'aprobada')`, u.id, estacion)) {
        return fallo(409, 'Ya has reclamado esta gasolinera.');
      }
      if (db.uno(`SELECT COUNT(*) AS n FROM reclamaciones WHERE usuario = ? AND estado = 'pendiente'`, u.id).n >= 20) {
        return fallo(429, 'Tienes demasiadas reclamaciones pendientes. Espera a que revisemos las actuales.');
      }
      const r = { id: crypto.randomBytes(8).toString('base64url'), usuario: u.id, estacion, estado: 'pendiente', mensaje: limpiarTexto(body.mensaje, 600), nota: '', creada: Date.now() };
      db.ejecutar('INSERT INTO reclamaciones (id, usuario, estacion, estado, mensaje, nota, creada) VALUES (?, ?, ?, ?, ?, ?, ?)', r.id, r.usuario, r.estacion, r.estado, r.mensaje, r.nota, r.creada);
      return { reclamacion: r };
    },

    reclamacionesDe: (usuarioId) => db.todos('SELECT * FROM reclamaciones WHERE usuario = ? ORDER BY creada DESC', usuarioId),
    estacionesDe: (usuarioId) => db.todos(`SELECT estacion FROM reclamaciones WHERE usuario = ? AND estado = 'aprobada'`, usuarioId).map((r) => r.estacion),

    visitas30(estacion) {
      const limite = new Date(Date.now() - 30 * DIA).toISOString().slice(0, 10);
      return db.uno('SELECT COALESCE(SUM(n), 0) AS n FROM visitas WHERE estacion = ? AND dia >= ?', estacion, limite).n;
    },

    editarFicha(u, estacion, body) {
      if (!esDueno(u.id, estacion)) return fallo(403, 'Esta gasolinera no está asociada a tu cuenta.');
      const servicios = Array.isArray(body.servicios) ? [...new Set(body.servicios.filter((s) => s in SERVICIOS))] : [];
      const telefono = limpiarTexto(body.telefono, 20);
      if (telefono && !/^\+?[\d\s]{9,15}$/.test(telefono)) return fallo(400, 'El teléfono no es válido.');
      let web = limpiarTexto(body.web, 200);
      if (web) {
        if (!/^https?:\/\//i.test(web)) web = 'https://' + web;
        try {
          const url = new URL(web);
          if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) throw 0;
          web = url.href;
        } catch {
          return fallo(400, 'La dirección web no es válida.');
        }
      }
      let promoTexto = null, promoHasta = null;
      if (body.promocion && limpiarTexto(body.promocion.texto, 140)) {
        const hasta = String(body.promocion.hasta || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta) || hasta < hoy()) return fallo(400, 'La promoción necesita una fecha de fin a partir de hoy.');
        const max = new Date(Date.now() + 92 * DIA).toISOString().slice(0, 10);
        if (hasta > max) return fallo(400, 'Una promoción puede durar como mucho 3 meses.');
        promoTexto = limpiarTexto(body.promocion.texto, 140);
        promoHasta = hasta;
      }
      db.ejecutar(
        `INSERT INTO fichas (estacion, servicios, telefono, web, descripcion, promo_texto, promo_hasta, actualizado, por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(estacion) DO UPDATE SET servicios = excluded.servicios, telefono = excluded.telefono, web = excluded.web,
           descripcion = excluded.descripcion, promo_texto = excluded.promo_texto, promo_hasta = excluded.promo_hasta,
           actualizado = excluded.actualizado, por = excluded.por`,
        estacion, JSON.stringify(servicios), telefono, web, limpiarTexto(body.descripcion, 400), promoTexto, promoHasta, Date.now(), u.id
      );
      return { ficha: this.ficha(estacion) };
    },

    /**
     * La gasolinera declara sus precios. Se muestran junto al oficial, no lo sustituyen.
     * precios: { gasoleoA: 1.459 | null (quitar), … }   oficiales: precios del Ministerio ahora mismo
     */
    declararPrecios(u, estacion, precios, oficiales = {}) {
      if (!esDueno(u.id, estacion)) return fallo(403, 'Esta gasolinera no está asociada a tu cuenta.');
      if (!precios || typeof precios !== 'object') return fallo(400, 'No hay precios que guardar.');
      const cambios = [];
      for (const [c, v] of Object.entries(precios)) {
        if (!COMBUSTIBLES_DECLARABLES.includes(c)) continue;
        if (v === null || v === '') {
          cambios.push([c, null]);
          continue;
        }
        const n = Math.round(Number(String(v).replace(',', '.')) * 1000) / 1000;
        if (!Number.isFinite(n) || n < PRECIO_MIN || n > PRECIO_MAX) return fallo(400, `El precio de ${c} no es válido (entre 0,300 y 4,000 €/l).`);
        const of = oficiales[c];
        if (of && Math.abs(n - of) / of > MAX_DESVIO) {
          return fallo(400, `El precio de ${c} (${n.toFixed(3).replace('.', ',')} €) se aleja más de un 25 % del oficial (${of.toFixed(3).replace('.', ',')} €). Revisa la cifra.`);
        }
        cambios.push([c, n]);
      }
      const ahora = Date.now();
      db.transaccion(() => {
        for (const [c, n] of cambios) {
          if (n === null) {
            db.ejecutar('DELETE FROM precios_declarados WHERE estacion = ? AND combustible = ?', estacion, c);
          } else {
            db.ejecutar(
              `INSERT INTO precios_declarados (estacion, combustible, precio, fecha, usuario) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(estacion, combustible) DO UPDATE SET precio = excluded.precio, fecha = excluded.fecha, usuario = excluded.usuario`,
              estacion, c, n, ahora, u.id
            );
          }
          // Historial para resolver disputas: qué declaró, cuándo y cuánto marcaba el Ministerio
          db.ejecutar('INSERT INTO precios_declarados_log (estacion, combustible, precio, oficial, fecha, usuario) VALUES (?, ?, ?, ?, ?, ?)', estacion, c, n, oficiales[c] ?? null, ahora, u.id);
        }
      });
      return { precios: declaradosDe(estacion) };
    },

    /**
     * Un usuario indica el precio real cuando no coincide con el que declara la gasolinera.
     * Solo cuentas personales con el correo confirmado; una indicación por persona y combustible (la última vale).
     */
    corregirPrecio(u, estacion, body, oficiales = {}) {
      if (u.rol !== 'usuario') return fallo(403, 'Solo las cuentas personales pueden corregir precios.');
      if (!u.verificado) return fallo(403, 'Confirma tu correo electrónico para poder corregir precios.');
      const combustible = String(body.combustible || '');
      const decl = db.uno('SELECT precio, fecha FROM precios_declarados WHERE estacion = ? AND combustible = ?', estacion, combustible);
      if (!decl) return fallo(404, 'Esta gasolinera no ha publicado precio para ese combustible.');
      const n = Math.round(Number(String(body.precio ?? '').replace(',', '.')) * 1000) / 1000;
      if (!Number.isFinite(n) || n < PRECIO_MIN || n > PRECIO_MAX) return fallo(400, 'Escribe el precio por litro que viste, por ejemplo 1,459.');
      const ref = oficiales[combustible] ?? decl.precio;
      if (Math.abs(n - ref) / ref > MAX_DESVIO) return fallo(400, 'Ese precio se aleja demasiado del habitual. Revisa la cifra.');
      db.ejecutar(
        `INSERT INTO correcciones_precio (estacion, combustible, usuario, precio, fecha) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(estacion, combustible, usuario) DO UPDATE SET precio = excluded.precio, fecha = excluded.fecha`,
        estacion, combustible, u.id, n, Date.now()
      );
      const c = consenso(estacion, combustible, decl);
      // Al formarse el consenso, quienes acertaron ganan fiabilidad y quienes indicaron otro precio la pierden
      if (c.alcanzado && reputacion) {
        const ref = `${estacion}:${combustible}:${decl.fecha}`;
        for (const y of c.grupo) reputacion.anotar(y.usuario, 'correccion_acertada', ref);
        for (const y of c.otros) if (Math.abs(y.precio - c.precio) > 0.03) reputacion.anotar(y.usuario, 'correccion_fallida', ref);
      }
      return {
        aplicada: c.alcanzado,
        coinciden: c.n,
        faltan: c.alcanzado ? 0 : Math.max(1, CONSENSO_MIN - c.n),
        precios: declaradosDe(estacion),
      };
    },

    // Para el panel: indicaciones recientes de usuarios que aún no forman consenso
    correccionesPendientes(estacion) {
      const out = {};
      for (const f of db.todos('SELECT combustible, precio, fecha FROM precios_declarados WHERE estacion = ?', estacion)) {
        const lista = indicaciones(estacion, f.combustible, f).filter((x) => Math.abs(x.precio - f.precio) >= 0.005);
        if (lista.length) out[f.combustible] = { n: lista.length, precios: lista.map((x) => x.precio) };
      }
      return out;
    },

    // ---- Pro: datos para las estadísticas avanzadas ----
    visitasDiarias(estacion, dias = 30) {
      const limite = new Date(Date.now() - dias * DIA).toISOString().slice(0, 10);
      return db.todos('SELECT dia, n FROM visitas WHERE estacion = ? AND dia >= ? ORDER BY dia', estacion, limite);
    },
    notaMensual(estacion, meses = 6) {
      const desde = Date.now() - meses * 31 * DIA;
      const filas = db.todos('SELECT puntuacion, fecha FROM reportes WHERE estacion = ? AND oculto = 0 AND fecha >= ?', estacion, desde);
      const porMes = new Map();
      for (const f of filas) {
        const mes = new Date(f.fecha).toISOString().slice(0, 7);
        const m = porMes.get(mes) || [0, 0];
        m[0] += f.puntuacion;
        m[1]++;
        porMes.set(mes, m);
      }
      return [...porMes].sort().map(([mes, [s, n]]) => ({ mes, media: Math.round((s / n) * 100) / 100, n }));
    },

    historialPrecios: (estacion) => db.todos('SELECT combustible, precio, oficial, fecha FROM precios_declarados_log WHERE estacion = ? ORDER BY fecha DESC LIMIT 100', estacion),

    // ---- Administración ----
    listarReclamaciones(estado) {
      if (!estado || estado === 'todas') return db.todos('SELECT * FROM reclamaciones ORDER BY creada DESC LIMIT 300');
      return db.todos('SELECT * FROM reclamaciones WHERE estado = ? ORDER BY creada DESC LIMIT 300', estado);
    },

    resolverReclamacion(id, accion, nota) {
      const r = db.uno('SELECT * FROM reclamaciones WHERE id = ?', id);
      if (!r) return fallo(404, 'No existe esa reclamación.');
      const nuevo = { aprobar: 'aprobada', rechazar: 'rechazada', revocar: 'revocada' }[accion];
      if (!nuevo) return fallo(400, 'Acción no válida (aprobar, rechazar o revocar).');
      if (nuevo === 'aprobada') {
        const otro = duenoDe(r.estacion);
        if (otro && otro.id !== r.id) return fallo(409, 'Esa gasolinera ya tiene otra cuenta aprobada. Revoca primero la anterior.');
        if (!r.usuario) return fallo(409, 'La cuenta que la reclamó ya no existe.');
      }
      db.transaccion(() => {
        db.ejecutar('UPDATE reclamaciones SET estado = ?, nota = ?, resuelta = ? WHERE id = ?', nuevo, limpiarTexto(nota, 300), Date.now(), id);
        // Si deja de ser suya, sus precios declarados dejan de mostrarse
        if (r.estado === 'aprobada' && nuevo !== 'aprobada') db.ejecutar('DELETE FROM precios_declarados WHERE estacion = ?', r.estacion);
      });
      return { reclamacion: db.uno('SELECT * FROM reclamaciones WHERE id = ?', id) };
    },

    // Al borrar una cuenta de gasolinera, sus gasolineras quedan libres
    olvidarUsuario(usuarioId) {
      for (const r of db.todos(`SELECT estacion FROM reclamaciones WHERE usuario = ? AND estado = 'aprobada'`, usuarioId)) {
        db.ejecutar('DELETE FROM precios_declarados WHERE estacion = ?', r.estacion);
      }
      db.ejecutar(`UPDATE reclamaciones SET estado = 'revocada', resuelta = ? WHERE usuario = ? AND estado IN ('pendiente', 'aprobada')`, Date.now(), usuarioId);
    },

    volcar: () => {},
  };
}
