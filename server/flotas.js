// GasoCheck Empresas: la empresa registra sus vehículos, sus conductores se unen con un código
// y los repostajes que marcan "de empresa" llegan a su panel con gasto, consumo y avisos de repostajes raros.
// Los conductores solo comparten los repostajes que ellos marcan como de empresa.

import crypto from 'node:crypto';

const COMBUSTIBLES = ['gasoleoA', 'gasoleoPremium', 'gasolina95', 'gasolina98', 'glp'];
export const MAX_VEHICULOS_GRATIS = 5;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para no confundirse al teclear
const fallo = (status, error) => ({ status, error });
const limpiar = (s, max) => String(s ?? '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, max);

function codigoNuevo() {
  const b = crypto.randomBytes(8);
  return Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join('');
}

// Avisos de cada repostaje (lista de { tipo, texto }), con el historial del vehículo ordenado por fecha
export function anomalias(r, vehiculo, anteriores) {
  const out = [];
  if (vehiculo) {
    if (r.litros > vehiculo.deposito * 1.05) out.push({ tipo: 'deposito', texto: `${r.litros} L con un depósito de ${vehiculo.deposito} L` });
    if (r.combustible !== vehiculo.combustible) out.push({ tipo: 'combustible', texto: 'Combustible distinto del del vehículo' });
  }
  const t = Date.parse(`${r.fecha}T${r.hora || '12:00'}:00`);
  const previo = anteriores[anteriores.length - 1];
  if (previo) {
    const tp = Date.parse(`${previo.fecha}T${previo.hora || '12:00'}:00`);
    if (r.hora && previo.hora && t - tp >= 0 && t - tp < 4 * 3600 * 1000) out.push({ tipo: 'seguidos', texto: 'Dos repostajes del mismo vehículo en menos de 4 horas' });
    if (r.km && previo.km && r.km < previo.km) out.push({ tipo: 'km', texto: `Kilómetros menores que en el repostaje anterior (${previo.km.toLocaleString('es-ES')})` });
  }
  if (r.importe && r.precio_oficial && r.importe / r.litros > r.precio_oficial * 1.08) {
    out.push({ tipo: 'caro', texto: `Pagado a ${(r.importe / r.litros).toFixed(3).replace('.', ',')} €/l; el oficial era ${r.precio_oficial.toFixed(3).replace('.', ',')} €/l` });
  }
  if (r.hora) {
    const h = +r.hora.slice(0, 2);
    const dia = new Date(`${r.fecha}T12:00:00Z`).getUTCDay();
    if (h >= 22 || h < 6 || dia === 0 || dia === 6) out.push({ tipo: 'horario', texto: 'Fuera del horario laboral habitual' });
  }
  return out;
}

// Consumo de un vehículo por el método "lleno a lleno"
function consumoVehiculo(reps) {
  const conKm = reps.filter((r) => r.km).sort((a, b) => a.km - b.km);
  let km = 0, litros = 0, ultimo = -1;
  for (let i = 0; i < conKm.length; i++) {
    if (!conKm[i].lleno) continue;
    if (ultimo >= 0) {
      const d = conKm[i].km - conKm[ultimo].km;
      let l = 0;
      for (let j = ultimo + 1; j <= i; j++) l += conKm[j].litros;
      if (d >= 30) {
        km += d;
        litros += l;
      }
    }
    ultimo = i;
  }
  return km ? Math.round((litros / km) * 1000) / 10 : null;
}

export function crearFlotas(db) {
  const nuevoId = () => crypto.randomBytes(9).toString('base64url');

  function flotaDe(u) {
    let f = db.uno('SELECT * FROM flotas WHERE usuario = ?', u.id);
    if (!f) {
      for (let i = 0; i < 5 && !f; i++) {
        try {
          db.ejecutar('INSERT INTO flotas (id, usuario, nombre, codigo, creada) VALUES (?, ?, ?, ?, ?)', nuevoId(), u.id, u.proveedor?.empresa || u.alias, codigoNuevo(), Date.now());
          f = db.uno('SELECT * FROM flotas WHERE usuario = ?', u.id);
        } catch {
          /* código repetido: otro intento */
        }
      }
    }
    return f;
  }

  return {
    flotaDe,

    regenerarCodigo(u) {
      const f = flotaDe(u);
      db.ejecutar('UPDATE flotas SET codigo = ? WHERE id = ?', codigoNuevo(), f.id);
      return { codigo: db.uno('SELECT codigo FROM flotas WHERE id = ?', f.id).codigo };
    },

    // ---- Vehículos ----
    guardarVehiculo(u, body, esPro) {
      const f = flotaDe(u);
      const matricula = limpiar(body.matricula, 12).toUpperCase().replace(/[\s-]/g, '');
      const combustible = String(body.combustible || '');
      const deposito = Number(String(body.deposito ?? '').replace(',', '.'));
      if (!/^[A-Z0-9]{4,10}$/.test(matricula)) return fallo(400, 'Escribe la matrícula (por ejemplo 1234ABC).');
      if (!COMBUSTIBLES.includes(combustible)) return fallo(400, 'Elige el combustible del vehículo.');
      if (!(deposito >= 10 && deposito <= 1500)) return fallo(400, 'La capacidad del depósito debe estar entre 10 y 1.500 litros.');
      const nombre = limpiar(body.nombre, 40);
      if (body.id) {
        const r = db.ejecutar('UPDATE vehiculos SET matricula = ?, nombre = ?, combustible = ?, deposito = ? WHERE id = ? AND flota = ?', matricula, nombre, combustible, deposito, String(body.id), f.id);
        if (!r.changes) return fallo(404, 'No existe ese vehículo.');
      } else {
        const n = db.uno('SELECT COUNT(*) AS n FROM vehiculos WHERE flota = ? AND activo = 1', f.id).n;
        if (!esPro && n >= MAX_VEHICULOS_GRATIS) return fallo(402, `El plan gratuito admite ${MAX_VEHICULOS_GRATIS} vehículos. Con GasoCheck Pro no hay límite.`);
        db.ejecutar('INSERT INTO vehiculos (id, flota, matricula, nombre, combustible, deposito) VALUES (?, ?, ?, ?, ?, ?)', nuevoId(), f.id, matricula, nombre, combustible, deposito);
      }
      return { ok: true };
    },
    bajaVehiculo(u, id) {
      const f = flotaDe(u);
      const r = db.ejecutar('UPDATE vehiculos SET activo = 0 WHERE id = ? AND flota = ?', id, f.id);
      return r.changes ? { ok: true } : fallo(404, 'No existe ese vehículo.');
    },

    // ---- Conductores ----
    unirse(u, codigo) {
      if (u.rol !== 'usuario') return fallo(403, 'Únete con tu cuenta personal de conductor.');
      const f = db.uno('SELECT id, nombre FROM flotas WHERE codigo = ?', String(codigo || '').trim().toUpperCase().replace(/\s/g, ''));
      if (!f) return fallo(404, 'Ese código no corresponde a ninguna empresa. Pídeselo de nuevo a tu empresa.');
      db.ejecutar('INSERT OR IGNORE INTO conductores (flota, usuario, unido) VALUES (?, ?, ?)', f.id, u.id, Date.now());
      return { flota: { id: f.id, nombre: f.nombre } };
    },
    dejar(u, flotaId) {
      db.ejecutar('DELETE FROM conductores WHERE flota = ? AND usuario = ?', flotaId, u.id);
      return { ok: true };
    },
    expulsar(u, usuarioId) {
      const f = flotaDe(u);
      db.ejecutar('DELETE FROM conductores WHERE flota = ? AND usuario = ?', f.id, usuarioId);
      return { ok: true };
    },
    // Las empresas a las que pertenece un conductor, con sus vehículos
    misFlotas(u) {
      return db.todos('SELECT f.id, f.nombre FROM conductores c JOIN flotas f ON f.id = c.flota WHERE c.usuario = ?', u.id).map((f) => ({
        ...f,
        vehiculos: db.todos('SELECT id, matricula, nombre, combustible FROM vehiculos WHERE flota = ? AND activo = 1 ORDER BY matricula', f.id),
      }));
    },

    // ---- Repostajes ----
    registrarRepostaje(u, body, { precioOficial, nombreEstacion }) {
      const flota = String(body.flota || '');
      if (!db.uno('SELECT 1 AS si FROM conductores WHERE flota = ? AND usuario = ?', flota, u.id)) return fallo(403, 'No perteneces a esa empresa.');
      const v = db.uno('SELECT * FROM vehiculos WHERE id = ? AND flota = ? AND activo = 1', String(body.vehiculo || ''), flota);
      if (!v) return fallo(400, 'Elige el vehículo de la empresa.');
      const fecha = String(body.fecha || '');
      const hora = /^\d{2}:\d{2}$/.test(String(body.hora || '')) ? body.hora : null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fallo(400, 'Fecha no válida.');
      const litros = Number(body.litros);
      if (!(litros > 0 && litros <= 1500)) return fallo(400, 'Litros no válidos.');
      const importe = body.importe == null || body.importe === '' ? null : Number(body.importe);
      if (importe != null && !(importe > 0 && importe < 5000)) return fallo(400, 'Importe no válido.');
      const km = body.km ? Math.round(Number(body.km)) : null;
      const combustible = COMBUSTIBLES.includes(body.combustible) ? body.combustible : v.combustible;
      const estacion = body.estacion ? String(body.estacion) : null;
      const id = nuevoId();
      db.ejecutar(
        `INSERT INTO repostajes_flota (id, flota, usuario, conductor, vehiculo, estacion, nombre_estacion, fecha, hora, combustible, litros, importe, km, lleno, precio_oficial, creado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, flota, u.id, u.alias, v.id, estacion, estacion ? nombreEstacion(estacion) : limpiar(body.nombreEstacion, 80), fecha, hora,
        combustible, litros, importe, km, body.lleno !== false, estacion ? precioOficial(estacion, combustible) : null, Date.now()
      );
      return { ok: true, id };
    },

    // ---- Panel de la empresa ----
    panel(u, { desde, hasta }) {
      const f = flotaDe(u);
      const vehiculos = db.todos('SELECT * FROM vehiculos WHERE flota = ? ORDER BY activo DESC, matricula', f.id);
      const porId = new Map(vehiculos.map((v) => [v.id, v]));
      const conductores = db.todos('SELECT c.usuario, c.unido, us.alias, us.email FROM conductores c JOIN usuarios us ON us.id = c.usuario WHERE c.flota = ? ORDER BY us.alias', f.id);
      // Historial completo para detectar anomalías y consumo; se devuelve solo el periodo pedido
      const todos = db.todos('SELECT * FROM repostajes_flota WHERE flota = ? ORDER BY fecha, hora', f.id);
      const historial = new Map();
      const filas = [];
      for (const r of todos) {
        const prev = historial.get(r.vehiculo) || [];
        const an = anomalias({ ...r, lleno: Boolean(r.lleno) }, porId.get(r.vehiculo), prev);
        prev.push(r);
        historial.set(r.vehiculo, prev);
        if ((!desde || r.fecha >= desde) && (!hasta || r.fecha <= hasta)) {
          filas.push({ ...r, lleno: Boolean(r.lleno), vehiculoMatricula: porId.get(r.vehiculo)?.matricula || '—', anomalias: an });
        }
      }
      const resumenVehiculos = vehiculos.map((v) => {
        const rs = filas.filter((r) => r.vehiculo === v.id);
        return {
          id: v.id,
          matricula: v.matricula,
          nombre: v.nombre,
          activo: Boolean(v.activo),
          repostajes: rs.length,
          litros: Math.round(rs.reduce((a, r) => a + r.litros, 0) * 10) / 10,
          gasto: Math.round(rs.reduce((a, r) => a + (r.importe || 0), 0) * 100) / 100,
          consumo: consumoVehiculo((historial.get(v.id) || []).map((r) => ({ ...r, lleno: Boolean(r.lleno) }))),
          anomalias: rs.reduce((a, r) => a + r.anomalias.length, 0),
        };
      });
      return {
        flota: { nombre: f.nombre, codigo: f.codigo },
        vehiculos: vehiculos.map((v) => ({ ...v, activo: Boolean(v.activo) })),
        conductores,
        repostajes: filas.reverse(),
        resumen: {
          gasto: Math.round(filas.reduce((a, r) => a + (r.importe || 0), 0) * 100) / 100,
          litros: Math.round(filas.reduce((a, r) => a + r.litros, 0) * 10) / 10,
          repostajes: filas.length,
          conAvisos: filas.filter((r) => r.anomalias.some((x) => x.tipo !== 'horario')).length,
          vehiculos: resumenVehiculos,
        },
      };
    },
  };
}
