// Base de datos SQLite.
// En Netlify no hay disco persistente, así que la base de datos es un único fichero SQLite que vive en
// el almacén (Netlify Blobs) y se abre en memoria con sql.js (SQLite compilado a WebAssembly, incluido
// en server/vendor; no depende de la versión de Node).
//
// Cada petición:
//   1. sincronizar(): comprueba con el ETag si alguien ha cambiado la base de datos y, si es así, la descarga.
//   2. La ruta lee y escribe con la misma API síncrona de siempre (uno, todos, ejecutar, transaccion).
//   3. guardar(): si hubo cambios, sube la base de datos SOLO si nadie la ha cambiado entretanto
//      (escritura condicional por ETag). Si otra petición se adelantó, se descarta y la petición se repite.
// Así nunca se pierden escrituras aunque Netlify ejecute varias copias de la función a la vez.
//
// - Claves foráneas activadas: al borrar una cuenta se borran sus sesiones, tokens y datos.
// - Esquema versionado con PRAGMA user_version: cada cambio futuro se añade al final de MIGRACIONES.

import initSqlJs from './vendor/sql-wasm.mjs';
import wasmBase64 from './vendor/sql-wasm-binario.js';

let motor = null;
const cargarMotor = () => (motor ||= initSqlJs({ wasmBinary: Buffer.from(wasmBase64, 'base64') }));

const MIGRACIONES = [
  // 1: esquema inicial
  `
  CREATE TABLE usuarios (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    alias TEXT NOT NULL,
    rol TEXT NOT NULL CHECK (rol IN ('usuario', 'proveedor')),
    sal TEXT NOT NULL,
    hash TEXT NOT NULL,
    verificado INTEGER NOT NULL DEFAULT 0,
    creado INTEGER NOT NULL,
    empresa TEXT, cif TEXT, telefono TEXT,
    -- Prueba del consentimiento (RGPD art. 7.1): qué versión de las condiciones aceptó y cuándo
    condiciones_version TEXT, condiciones_fecha INTEGER
  );
  CREATE TABLE sesiones (
    hash TEXT PRIMARY KEY,
    usuario TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    creada INTEGER NOT NULL,
    expira INTEGER NOT NULL,
    ua TEXT
  );
  CREATE INDEX sesiones_usuario ON sesiones(usuario);
  CREATE TABLE tokens (
    hash TEXT PRIMARY KEY,
    usuario TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    expira INTEGER NOT NULL
  );
  CREATE TABLE sync (
    usuario TEXT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    actualizado INTEGER NOT NULL,
    datos TEXT NOT NULL
  );
  CREATE TABLE reportes (
    id TEXT PRIMARY KEY,
    estacion TEXT NOT NULL,
    puntuacion INTEGER NOT NULL CHECK (puntuacion BETWEEN 1 AND 5),
    problemas TEXT NOT NULL DEFAULT '[]',
    combustible TEXT NOT NULL DEFAULT '',
    comentario TEXT NOT NULL DEFAULT '',
    fecha INTEGER NOT NULL,
    quien TEXT NOT NULL,
    usuario TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
    autor TEXT,
    autor_verificado INTEGER NOT NULL DEFAULT 0,
    oculto INTEGER NOT NULL DEFAULT 0,
    moderado TEXT,
    resp_texto TEXT, resp_empresa TEXT, resp_fecha INTEGER
  );
  CREATE INDEX reportes_estacion ON reportes(estacion, fecha);
  CREATE INDEX reportes_quien ON reportes(quien, fecha);
  CREATE INDEX reportes_usuario ON reportes(usuario);
  CREATE TABLE denuncias (
    reporte TEXT NOT NULL REFERENCES reportes(id) ON DELETE CASCADE,
    quien TEXT NOT NULL,
    fecha INTEGER NOT NULL,
    PRIMARY KEY (reporte, quien)
  );
  CREATE TABLE reclamaciones (
    id TEXT PRIMARY KEY,
    usuario TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
    estacion TEXT NOT NULL,
    estado TEXT NOT NULL CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'revocada')),
    mensaje TEXT NOT NULL DEFAULT '',
    nota TEXT NOT NULL DEFAULT '',
    creada INTEGER NOT NULL,
    resuelta INTEGER
  );
  CREATE INDEX reclamaciones_usuario ON reclamaciones(usuario);
  CREATE INDEX reclamaciones_estacion ON reclamaciones(estacion, estado);
  -- Como mucho una cuenta aprobada por gasolinera
  CREATE UNIQUE INDEX una_aprobada ON reclamaciones(estacion) WHERE estado = 'aprobada';
  CREATE TABLE fichas (
    estacion TEXT PRIMARY KEY,
    servicios TEXT NOT NULL DEFAULT '[]',
    telefono TEXT NOT NULL DEFAULT '',
    web TEXT NOT NULL DEFAULT '',
    descripcion TEXT NOT NULL DEFAULT '',
    promo_texto TEXT, promo_hasta TEXT,
    actualizado INTEGER NOT NULL,
    por TEXT
  );
  CREATE TABLE visitas (
    estacion TEXT NOT NULL,
    dia TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (estacion, dia)
  );
  `,
  // 2: precios declarados por la gasolinera, con historial de cambios para auditoría
  `
  CREATE TABLE precios_declarados (
    estacion TEXT NOT NULL,
    combustible TEXT NOT NULL,
    precio REAL NOT NULL,
    fecha INTEGER NOT NULL,
    usuario TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
    PRIMARY KEY (estacion, combustible)
  );
  CREATE TABLE precios_declarados_log (
    estacion TEXT NOT NULL,
    combustible TEXT NOT NULL,
    precio REAL,
    oficial REAL,
    fecha INTEGER NOT NULL,
    usuario TEXT
  );
  CREATE INDEX precios_log_estacion ON precios_declarados_log(estacion, fecha);
  `,
  // 3: reseñas editables y precios corregidos por los usuarios
  `
  ALTER TABLE reportes ADD COLUMN editado INTEGER;
  CREATE TABLE correcciones_precio (
    estacion TEXT NOT NULL,
    combustible TEXT NOT NULL,
    usuario TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    precio REAL NOT NULL,
    fecha INTEGER NOT NULL,
    PRIMARY KEY (estacion, combustible, usuario)
  );
  CREATE INDEX correcciones_estacion ON correcciones_precio(estacion, combustible, fecha);
  `,
  // 4: cuentas de empresa (flotas), plan Pro, reputación, tickets, avisos y notificaciones.
  // La tabla de usuarios se reconstruye para admitir el rol 'empresa' (SQLite no permite cambiar un CHECK).
  {
    sinClavesForaneas: true,
    sql: `
  CREATE TABLE usuarios_n (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    alias TEXT NOT NULL,
    rol TEXT NOT NULL CHECK (rol IN ('usuario', 'proveedor', 'empresa')),
    sal TEXT NOT NULL,
    hash TEXT NOT NULL,
    verificado INTEGER NOT NULL DEFAULT 0,
    creado INTEGER NOT NULL,
    empresa TEXT, cif TEXT, telefono TEXT,
    condiciones_version TEXT, condiciones_fecha INTEGER,
    plan TEXT NOT NULL DEFAULT 'gratis',
    plan_hasta TEXT
  );
  INSERT INTO usuarios_n (id, email, alias, rol, sal, hash, verificado, creado, empresa, cif, telefono, condiciones_version, condiciones_fecha)
    SELECT id, email, alias, rol, sal, hash, verificado, creado, empresa, cif, telefono, condiciones_version, condiciones_fecha FROM usuarios;
  DROP TABLE usuarios;
  ALTER TABLE usuarios_n RENAME TO usuarios;

  ALTER TABLE reportes ADD COLUMN ticket INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE tickets (
    hash TEXT PRIMARY KEY,
    reporte TEXT REFERENCES reportes(id) ON DELETE SET NULL,
    usuario TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
    estacion TEXT, fecha TEXT, litros REAL, importe REAL,
    creado INTEGER NOT NULL
  );
  CREATE TABLE reputacion_eventos (
    usuario TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    ref TEXT NOT NULL,
    fecha INTEGER NOT NULL,
    PRIMARY KEY (usuario, tipo, ref)
  );

  CREATE TABLE alertas_precio (
    id TEXT PRIMARY KEY,
    usuario TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    estacion TEXT NOT NULL,
    combustible TEXT NOT NULL,
    umbral REAL NOT NULL,
    creada INTEGER NOT NULL,
    ultimo_aviso INTEGER,
    ultimo_precio REAL,
    UNIQUE (usuario, estacion, combustible)
  );
  CREATE TABLE suscripciones_push (
    endpoint TEXT PRIMARY KEY,
    usuario TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    creada INTEGER NOT NULL
  );
  CREATE TABLE avisos (
    id TEXT PRIMARY KEY,
    usuario TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    titulo TEXT NOT NULL,
    texto TEXT NOT NULL,
    estacion TEXT,
    fecha INTEGER NOT NULL,
    leido INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX avisos_usuario ON avisos(usuario, fecha);
  CREATE TABLE avisos_calidad_enviados (
    usuario TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    estacion TEXT NOT NULL,
    problema TEXT NOT NULL,
    fecha INTEGER NOT NULL,
    PRIMARY KEY (usuario, estacion, problema)
  );
  CREATE TABLE mensajes_seguidores (
    id TEXT PRIMARY KEY,
    estacion TEXT NOT NULL,
    usuario TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
    texto TEXT NOT NULL,
    fecha INTEGER NOT NULL,
    enviados INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE flotas (
    id TEXT PRIMARY KEY,
    usuario TEXT NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    codigo TEXT NOT NULL UNIQUE,
    creada INTEGER NOT NULL
  );
  CREATE TABLE vehiculos (
    id TEXT PRIMARY KEY,
    flota TEXT NOT NULL REFERENCES flotas(id) ON DELETE CASCADE,
    matricula TEXT NOT NULL,
    nombre TEXT NOT NULL DEFAULT '',
    combustible TEXT NOT NULL,
    deposito REAL NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE conductores (
    flota TEXT NOT NULL REFERENCES flotas(id) ON DELETE CASCADE,
    usuario TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    unido INTEGER NOT NULL,
    PRIMARY KEY (flota, usuario)
  );
  CREATE TABLE repostajes_flota (
    id TEXT PRIMARY KEY,
    flota TEXT NOT NULL REFERENCES flotas(id) ON DELETE CASCADE,
    usuario TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
    conductor TEXT NOT NULL DEFAULT '',
    vehiculo TEXT REFERENCES vehiculos(id) ON DELETE SET NULL,
    estacion TEXT,
    nombre_estacion TEXT NOT NULL DEFAULT '',
    fecha TEXT NOT NULL,
    hora TEXT,
    combustible TEXT NOT NULL,
    litros REAL NOT NULL,
    importe REAL,
    km INTEGER,
    lleno INTEGER NOT NULL DEFAULT 1,
    precio_oficial REAL,
    creado INTEGER NOT NULL
  );
  CREATE INDEX repostajes_flota_fecha ON repostajes_flota(flota, fecha);
  `,
  },
];

export const CLAVE_BD = 'bd/gasocheck.sqlite';

export async function abrirBD(almacen, clave = CLAVE_BD) {
  const SQL = await cargarMotor();
  let bd = null; // SQL.Database
  let etag = null; // ETag de la copia que tenemos en memoria
  let sucio = false; // hay cambios sin subir
  let cache = new Map();
  let version = 0;
  let enTransaccion = 0;

  function prepararConexion() {
    cache = new Map();
    bd.exec('PRAGMA foreign_keys = ON;');
  }

  function migrar() {
    version = bd.exec('PRAGMA user_version')[0].values[0][0];
    while (version < MIGRACIONES.length) {
      const m = MIGRACIONES[version];
      const sql = typeof m === 'string' ? m : m.sql;
      // Reconstruir una tabla con referencias exige desactivar las claves foráneas (fuera de la transacción)
      if (m.sinClavesForaneas) bd.exec('PRAGMA foreign_keys = OFF');
      bd.exec('BEGIN');
      try {
        bd.exec(sql);
        if (m.sinClavesForaneas) {
          const rotas = bd.exec('PRAGMA foreign_key_check');
          if (rotas.length && rotas[0].values.length) throw new Error(`referencias rotas: ${JSON.stringify(rotas[0].values.slice(0, 3))}`);
        }
        bd.exec(`PRAGMA user_version = ${version + 1}`);
        bd.exec('COMMIT');
      } catch (e) {
        bd.exec('ROLLBACK');
        throw new Error(`Fallo al actualizar la base de datos a la versión ${version + 1}: ${e.message}`);
      } finally {
        if (m.sinClavesForaneas) bd.exec('PRAGMA foreign_keys = ON');
      }
      version++;
      sucio = true;
    }
  }

  function abrir(bytes) {
    if (bd) {
      try {
        bd.close();
      } catch {
        /* ya cerrada */
      }
    }
    bd = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
    sucio = false;
    prepararConexion();
    migrar();
  }

  function descartar() {
    if (bd) {
      try {
        bd.close();
      } catch {
        /* ya cerrada */
      }
    }
    bd = null;
    etag = null;
    sucio = false;
    cache = new Map();
  }

  const conexion = () => {
    if (!bd) throw new Error('Base de datos no cargada (falta sincronizar)');
    return bd;
  };
  const sentencia = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = conexion().prepare(sql)));
    return s;
  };
  // SQLite no acepta booleanos ni undefined como parámetros
  const limpiar = (ps) => ps.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

  function filas(sql, ps, max) {
    const s = sentencia(sql);
    const out = [];
    try {
      s.bind(limpiar(ps));
      while (out.length < max && s.step()) out.push(s.getAsObject());
    } finally {
      s.reset();
    }
    return out;
  }

  return {
    uno: (sql, ...ps) => filas(sql, ps, 1)[0] || null,
    todos: (sql, ...ps) => filas(sql, ps, Infinity),
    ejecutar(sql, ...ps) {
      const s = sentencia(sql);
      sucio = true;
      try {
        s.run(limpiar(ps));
      } finally {
        s.reset();
      }
      return { changes: conexion().getRowsModified() };
    },
    exec(sql) {
      sucio = true;
      conexion().exec(sql);
    },
    // Transacción (anidable: las internas se integran en la externa)
    transaccion(fn) {
      if (enTransaccion) return fn();
      enTransaccion++;
      conexion().exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        bd.exec('COMMIT');
        return r;
      } catch (e) {
        bd.exec('ROLLBACK');
        throw e;
      } finally {
        enTransaccion--;
      }
    },

    // Trae la última versión del almacén si ha cambiado (o si no hay ninguna cargada)
    async sincronizar() {
      if (bd && sucio) descartar(); // cambios de una petición anterior que no se llegaron a subir
      const r = await almacen.leer(clave, { tipo: 'buffer', etag: bd && etag ? etag : undefined });
      if (!r) {
        // Todavía no existe: base de datos nueva (se creará al guardar)
        if (!bd || etag) {
          abrir(null);
          etag = null;
          sucio = true;
        }
        return;
      }
      if (r.datos === null && bd) return; // la que tenemos sigue siendo la última
      abrir(r.datos);
      etag = r.etag || null;
    },

    // Sube los cambios. Devuelve false si otra petición cambió la base de datos entretanto
    async guardar() {
      if (!bd || !sucio) return true;
      const bytes = bd.export(); // export() cierra y reabre la conexión: se preparan de nuevo
      prepararConexion();
      const r = await almacen.escribir(clave, bytes, etag ? { siEtag: etag } : { siNuevo: true });
      if (!r.ok) {
        descartar();
        return false;
      }
      sucio = false;
      if (r.etag) etag = r.etag;
      else descartar(); // sin ETag no podemos saber si está al día: se volverá a descargar
      return true;
    },

    descartar,
    sucia: () => sucio,
    version: () => version,
  };
}
