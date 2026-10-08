// Cuentas de usuario y de gasolinera: registro, acceso, sesiones, verificación de correo,
// recuperación de contraseña, datos sincronizados y borrado de cuenta (SQLite).

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const DIA = 24 * 3600 * 1000;
const SESION_MS = 30 * DIA;
const VERIFICAR_MS = 3 * DIA;
const RESET_MS = 60 * 60 * 1000;
const INTENTOS_MAX = 8; // intentos fallidos de acceso…
const INTENTOS_VENTANA = 15 * 60 * 1000; // …por cada 15 minutos
const MAX_SYNC_BYTES = 512 * 1024;
export const VERSION_CONDICIONES = '2026-10-07.4'; // cambiarla cuando cambien las condiciones

const COMUNES = new Set(['12345678', '123456789', '1234567890', 'password', 'contraseña', 'contrasena', 'qwertyui', '11111111', '00000000', 'gasolina', 'iloveyou', 'abcd1234', 'password1', '12341234', 'espana123', 'madrid123']);

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const nuevoToken = () => crypto.randomBytes(32).toString('base64url');
const nuevoId = () => crypto.randomBytes(9).toString('base64url');
export const normEmail = (e) => String(e || '').trim().toLowerCase();

class ErrorCuenta extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}
const fallo = (status, msg) => {
  throw new ErrorCuenta(status, msg);
};

function validarPassword(p, email) {
  if (typeof p !== 'string' || p.length < 8) fallo(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (p.length > 200) fallo(400, 'La contraseña es demasiado larga.');
  if (COMUNES.has(p.toLowerCase()) || (email && p.toLowerCase() === email)) fallo(400, 'Esa contraseña es demasiado fácil de adivinar. Elige otra.');
}
function validarEmail(e) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 200) fallo(400, 'Escribe un correo electrónico válido.');
}
function validarAlias(a) {
  if (a.length < 2 || a.length > 30 || !/^[\p{L}\p{N} ._'-]+$/u.test(a)) fallo(400, 'El nombre público debe tener entre 2 y 30 caracteres (letras, números, espacios y . _ \' -).');
}
// CIF/NIF/NIE: comprobación de formato (no de la letra de control)
const validarCif = (c) => /^([ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])$/.test(c);
const telefonoValido = (t) => /^\+?[\d\s]{9,15}$/.test(t);

async function hashPassword(p, sal = crypto.randomBytes(16)) {
  const h = await scrypt(p, sal, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { sal: sal.toString('base64'), hash: h.toString('base64') };
}
async function comprobarPassword(p, u) {
  const { hash } = await hashPassword(p, Buffer.from(u.sal, 'base64'));
  const a = Buffer.from(hash, 'base64');
  const b = Buffer.from(u.hash, 'base64');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Fila → usuario (con el bloque "proveedor" para las gasolineras)
function aUsuario(f) {
  if (!f) return null;
  return {
    id: f.id,
    email: f.email,
    alias: f.alias,
    rol: f.rol,
    sal: f.sal,
    hash: f.hash,
    verificado: Boolean(f.verificado),
    creado: f.creado,
    ...(f.rol !== 'usuario' ? { proveedor: { empresa: f.empresa, cif: f.cif, telefono: f.telefono } } : {}),
    plan: f.plan || 'gratis',
    planHasta: f.plan_hasta || null,
    condiciones: f.condiciones_version ? { version: f.condiciones_version, fecha: f.condiciones_fecha } : null,
  };
}

const hoyMadrid = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
// ¿Se cobra por GasoCheck Pro? Por defecto NO: la app es gratuita y sin actividad económica,
// así que todas las funciones Pro están abiertas a todas las gasolineras y empresas.
// Para activar los planes de pago en el futuro: variable de entorno GASOCHECK_PAGOS=1
// (y antes revisa tu situación fiscal y las condiciones de uso).
export const PAGOS = process.env.GASOCHECK_PAGOS === '1';
// GasoCheck Pro: sin pagos, lo tienen todas las cuentas de gasolinera y empresa;
// con pagos, si el plan es 'pro' y no ha caducado
export const esPro = (u) =>
  Boolean(u && (PAGOS ? u.plan === 'pro' && (!u.planHasta || u.planHasta >= hoyMadrid()) : u.rol === 'proveedor' || u.rol === 'empresa'));

export function crearCuentas(db, { correo, appUrl }) {
  const intentos = new Map(); // clave -> [tiempos] (en memoria: se reinicia con el servidor)
  const porId = (id) => aUsuario(db.uno('SELECT * FROM usuarios WHERE id = ?', id));
  const porEmail = (e) => aUsuario(db.uno('SELECT * FROM usuarios WHERE email = ?', e));

  // Hash ficticio para que un correo inexistente tarde lo mismo que una contraseña errónea
  let hashFalso = null;
  hashPassword('relleno-' + Math.random()).then((h) => (hashFalso = h));

  // Las sesiones y enlaces caducados se borran en el mantenimiento diario (app.js → mantenimiento)

  function limitar(clave) {
    const ahora = Date.now();
    const lista = (intentos.get(clave) || []).filter((t) => ahora - t < INTENTOS_VENTANA);
    intentos.set(clave, lista);
    if (lista.length >= INTENTOS_MAX) fallo(429, 'Demasiados intentos. Espera 15 minutos y vuelve a probar.');
    return () => {
      lista.push(ahora);
      intentos.set(clave, lista);
    };
  }

  function publico(u) {
    if (!u) return null;
    return {
      id: u.id,
      email: u.email,
      alias: u.alias,
      rol: u.rol,
      verificado: u.verificado,
      creado: u.creado,
      ...(u.rol !== 'usuario' ? { proveedor: { ...u.proveedor }, plan: { nombre: u.plan, hasta: u.planHasta, pro: esPro(u), gratis: !PAGOS } } : {}),
    };
  }

  function crearSesion(u, ua = '') {
    const token = nuevoToken();
    db.ejecutar('INSERT INTO sesiones (hash, usuario, creada, expira, ua) VALUES (?, ?, ?, ?, ?)', hashToken(token), u.id, Date.now(), Date.now() + SESION_MS, String(ua || '').slice(0, 120));
    return token;
  }

  async function enviarToken(u, tipo) {
    const token = nuevoToken();
    db.transaccion(() => {
      db.ejecutar('DELETE FROM tokens WHERE usuario = ? AND tipo = ?', u.id, tipo);
      db.ejecutar('INSERT INTO tokens (hash, usuario, tipo, expira) VALUES (?, ?, ?, ?)', hashToken(token), u.id, tipo, Date.now() + (tipo === 'reset' ? RESET_MS : VERIFICAR_MS));
    });
    const enlace = `${appUrl}/?${tipo === 'reset' ? 'restablecer' : 'verificar'}=${token}`;
    const texto =
      tipo === 'reset'
        ? `Hola ${u.alias}:\n\nHemos recibido una petición para cambiar la contraseña de tu cuenta de GasoCheck.\n\nPara elegir una nueva, abre este enlace (caduca en 1 hora):\n${enlace}\n\nSi no has sido tú, ignora este correo: tu contraseña no cambia.`
        : `Hola ${u.alias}:\n\nGracias por crear tu cuenta en GasoCheck. Confirma tu correo abriendo este enlace (caduca en 3 días):\n${enlace}\n\n${u.rol === 'proveedor' ? 'Después podrás reclamar tus gasolineras desde el panel de gasolinera. Las revisamos a mano antes de activarlas.\n\n' : u.rol === 'empresa' ? 'Después entra en el panel de empresa para dar de alta tus vehículos y compartir el código con tus conductores.\n\n' : ''}Si no has creado esta cuenta, ignora este correo.`;
    await correo.enviar({ para: u.email, asunto: tipo === 'reset' ? 'Cambia tu contraseña de GasoCheck' : 'Confirma tu correo en GasoCheck', texto });
  }

  // Los enlaces de los correos son de un solo uso
  function usarToken(token, tipo) {
    const h = hashToken(String(token || ''));
    return db.transaccion(() => {
      const t = db.uno('SELECT * FROM tokens WHERE hash = ? AND tipo = ? AND expira > ?', h, tipo, Date.now());
      if (!t) fallo(400, tipo === 'reset' ? 'El enlace para cambiar la contraseña no es válido o ha caducado. Pide uno nuevo.' : 'El enlace de verificación no es válido o ha caducado. Pide uno nuevo desde tu cuenta.');
      db.ejecutar('DELETE FROM tokens WHERE hash = ?', h);
      const u = porId(t.usuario);
      if (!u) fallo(400, 'La cuenta ya no existe.');
      return u;
    });
  }

  return {
    ErrorCuenta,
    publico,
    porId,

    // Devuelve el usuario de la cabecera Authorization, o null
    autenticar(req) {
      const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (!m) return null;
      const h = hashToken(m[1].trim());
      const s = db.uno('SELECT * FROM sesiones WHERE hash = ? AND expira > ?', h, Date.now());
      if (!s) return null;
      // Sesión deslizante: se renueva si se usa en la segunda mitad de su vida
      if (s.expira - Date.now() < SESION_MS / 2) db.ejecutar('UPDATE sesiones SET expira = ? WHERE hash = ?', Date.now() + SESION_MS, h);
      const u = porId(s.usuario);
      if (u) req.sesionHash = h; // para cerrar justo esta sesión
      return u;
    },

    async registrar(body, ip, ua) {
      const email = normEmail(body.email);
      validarEmail(email);
      validarPassword(body.password, email);
      const alias = String(body.alias || '').trim().replace(/\s+/g, ' ');
      validarAlias(alias);
      const tipo = ['proveedor', 'empresa'].includes(body.tipo) ? body.tipo : 'usuario';
      let empresa = null, cif = null, telefono = null;
      if (tipo !== 'usuario') {
        empresa = String(body.empresa || '').trim();
        cif = String(body.cif || '').trim().toUpperCase().replace(/[\s-]/g, '');
        telefono = String(body.telefono || '').trim().replace(/\s+/g, ' ');
        if (empresa.length < 2 || empresa.length > 80) fallo(400, 'Escribe la razón social o el nombre de la empresa.');
        if (!validarCif(cif)) fallo(400, 'El CIF/NIF no tiene un formato válido.');
        if (!telefonoValido(telefono)) fallo(400, 'Escribe un teléfono de contacto válido.');
      }
      if (body.acepto !== true) fallo(400, 'Debes confirmar que tienes al menos 14 años y aceptar las condiciones de uso y la política de privacidad.');
      const marcar = limitar('reg:' + ip);
      marcar();
      if (porEmail(email)) fallo(409, 'Ya hay una cuenta con ese correo. Prueba a entrar o a recuperar la contraseña.');
      const { sal, hash } = await hashPassword(body.password);
      const id = nuevoId();
      try {
        db.ejecutar(
          `INSERT INTO usuarios (id, email, alias, rol, sal, hash, verificado, creado, empresa, cif, telefono, condiciones_version, condiciones_fecha)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
          id, email, alias, tipo, sal, hash, Date.now(), empresa, cif, telefono, VERSION_CONDICIONES, Date.now()
        );
      } catch (e) {
        if (/UNIQUE/.test(e.message)) fallo(409, 'Ya hay una cuenta con ese correo. Prueba a entrar o a recuperar la contraseña.');
        throw e;
      }
      const u = porId(id);
      enviarToken(u, 'verificar').catch((e) => console.error('No se pudo enviar el correo de verificación:', e.message));
      return { token: crearSesion(u, ua), usuario: publico(u) };
    },

    async entrar(body, ip, ua) {
      const email = normEmail(body.email);
      const marcarIp = limitar('ip:' + ip);
      const marcarEmail = limitar('em:' + email);
      const u = porEmail(email);
      let ok = false;
      if (u) ok = await comprobarPassword(String(body.password || ''), u);
      else if (hashFalso) await comprobarPassword('x', hashFalso);
      if (!ok) {
        marcarIp();
        marcarEmail();
        fallo(401, 'Correo o contraseña incorrectos.');
      }
      intentos.delete('em:' + email);
      return { token: crearSesion(u, ua), usuario: publico(u) };
    },

    salir(u, h) {
      db.ejecutar('DELETE FROM sesiones WHERE hash = ? AND usuario = ?', h, u.id);
    },
    salirDeTodo(u) {
      db.ejecutar('DELETE FROM sesiones WHERE usuario = ?', u.id);
    },

    verificar(token) {
      const u = usarToken(token, 'verificar');
      db.ejecutar('UPDATE usuarios SET verificado = 1 WHERE id = ?', u.id);
      return publico(porId(u.id));
    },

    async reenviarVerificacion(u) {
      if (u.verificado) return;
      limitar('ver:' + u.id)();
      await enviarToken(u, 'verificar');
    },

    // Siempre responde igual, exista o no la cuenta (no revela qué correos están registrados)
    async olvido(body, ip) {
      limitar('olv:' + ip)();
      const u = porEmail(normEmail(body.email));
      if (u) await enviarToken(u, 'reset').catch((e) => console.error('No se pudo enviar el correo de recuperación:', e.message));
    },

    // Recuperar la cuenta con el enlace del correo: contraseña nueva y se entra directamente
    async restablecer(body, ua = '') {
      // Se valida la contraseña antes de gastar el enlace
      const h = hashToken(String(body.token || ''));
      const t = db.uno('SELECT usuario FROM tokens WHERE hash = ? AND tipo = ? AND expira > ?', h, 'reset', Date.now());
      const previo = t ? porId(t.usuario) : null;
      if (previo) validarPassword(body.password, previo.email);
      const u = usarToken(body.token, 'reset');
      const { sal, hash } = await hashPassword(body.password);
      db.transaccion(() => {
        // Ha demostrado acceso al correo: queda verificado. Se cierran las demás sesiones.
        db.ejecutar('UPDATE usuarios SET sal = ?, hash = ?, verificado = 1 WHERE id = ?', sal, hash, u.id);
        db.ejecutar('DELETE FROM sesiones WHERE usuario = ?', u.id);
      });
      const nuevo = porId(u.id);
      return { usuario: publico(nuevo), token: crearSesion(nuevo, ua) };
    },

    async cambiarPassword(u, body, ua) {
      if (!(await comprobarPassword(String(body.actual || ''), u))) fallo(401, 'La contraseña actual no es correcta.');
      validarPassword(body.nueva, u.email);
      const { sal, hash } = await hashPassword(body.nueva);
      db.transaccion(() => {
        db.ejecutar('UPDATE usuarios SET sal = ?, hash = ? WHERE id = ?', sal, hash, u.id);
        db.ejecutar('DELETE FROM sesiones WHERE usuario = ?', u.id);
      });
      return { token: crearSesion(u, ua) }; // nueva sesión para este dispositivo
    },

    actualizarPerfil(u, body) {
      if (body.alias !== undefined) {
        const alias = String(body.alias).trim().replace(/\s+/g, ' ');
        validarAlias(alias);
        db.ejecutar('UPDATE usuarios SET alias = ? WHERE id = ?', alias, u.id);
      }
      if (u.rol !== 'usuario' && body.telefono !== undefined) {
        const t = String(body.telefono).trim();
        if (!telefonoValido(t)) fallo(400, 'Escribe un teléfono de contacto válido.');
        db.ejecutar('UPDATE usuarios SET telefono = ? WHERE id = ?', t, u.id);
      }
      return publico(porId(u.id));
    },

    // ---- Datos sincronizados (favoritas, descuentos, diario, ajustes) ----
    leerDatos(u) {
      const f = db.uno('SELECT version, actualizado, datos FROM sync WHERE usuario = ?', u.id);
      return f ? { version: f.version, actualizado: f.actualizado, datos: JSON.parse(f.datos) } : { version: 0, datos: null };
    },

    guardarDatos(u, body) {
      const d = body.datos || {};
      const limpio = {
        favoritas: Array.isArray(d.favoritas) ? d.favoritas.filter((x) => typeof x === 'string').slice(0, 500) : [],
        descuentos: Array.isArray(d.descuentos) ? d.descuentos.slice(0, 50) : [],
        diario: Array.isArray(d.diario) ? d.diario.slice(-5000) : [],
        ajustes: d.ajustes && typeof d.ajustes === 'object' && !Array.isArray(d.ajustes) ? d.ajustes : {},
      };
      const txt = JSON.stringify(limpio);
      if (txt.length > MAX_SYNC_BYTES) fallo(413, 'Tus datos superan el tamaño máximo permitido.');
      return db.transaccion(() => {
        const actual = db.uno('SELECT version FROM sync WHERE usuario = ?', u.id)?.version ?? 0;
        if (typeof body.version === 'number' && body.version !== actual) fallo(409, 'Los datos cambiaron en otro dispositivo. Se van a combinar.');
        const ahora = Date.now();
        db.ejecutar(
          `INSERT INTO sync (usuario, version, actualizado, datos) VALUES (?, ?, ?, ?)
           ON CONFLICT(usuario) DO UPDATE SET version = excluded.version, actualizado = excluded.actualizado, datos = excluded.datos`,
          u.id, actual + 1, ahora, txt
        );
        return { version: actual + 1, actualizado: ahora };
      });
    },

    exportar(u) {
      return {
        cuenta: { ...publico(u), condicionesAceptadas: u.condiciones },
        sesiones: db.todos('SELECT creada, expira, ua FROM sesiones WHERE usuario = ?', u.id),
        datos: this.leerDatos(u).datos,
      };
    },

    // alBorrar se ejecuta dentro de la misma transacción, antes de borrar la cuenta
    // (p. ej. para dejar anónimas sus valoraciones)
    async borrar(u, body, alBorrar = () => {}) {
      if (!(await comprobarPassword(String(body.password || ''), u))) fallo(401, 'La contraseña no es correcta.');
      db.transaccion(() => {
        alBorrar(u);
        db.ejecutar('DELETE FROM usuarios WHERE id = ?', u.id); // sesiones, tokens y sync se borran en cascada
      });
    },

    // ---- Administración: cuentas de gasolinera y de empresa, y su plan ----
    listarProfesionales() {
      return db.todos(`SELECT * FROM usuarios WHERE rol IN ('proveedor', 'empresa') ORDER BY creado DESC LIMIT 500`).map((f) => publico(aUsuario(f)));
    },
    fijarPlan(id, plan, hasta) {
      const u = porId(id);
      if (!u || u.rol === 'usuario') fallo(404, 'No existe esa cuenta de gasolinera o empresa.');
      if (!['gratis', 'pro'].includes(plan)) fallo(400, 'Plan no válido (gratis o pro).');
      if (hasta && !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) fallo(400, 'Fecha no válida.');
      db.ejecutar('UPDATE usuarios SET plan = ?, plan_hasta = ? WHERE id = ?', plan, plan === 'pro' ? hasta || null : null, id);
      return publico(porId(id));
    },

    volcar: () => {},
  };
}
