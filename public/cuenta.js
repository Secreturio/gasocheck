/* GasoCheck — cuentas: acceso, registro (persona o gasolinera), perfil y sincronización entre dispositivos.
   La sesión es un token guardado en el dispositivo y enviado como "Authorization: Bearer". */
(() => {
  'use strict';
  const API = (window.GASOCHECK_API || '').replace(/\/$/, '');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const leer = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const guardar = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };

  let token = leer('gm.token', null);
  let usuario = leer('gm.usuario', null);
  let sync = leer('gm.sync', { version: 0, base: null, cuando: null });
  let opciones = { avisar: () => {}, obtenerLocal: () => ({}), aplicarRemoto: () => {}, alCambiarSesion: () => {}, abrirGasolinera: () => {}, alCambiarValoracion: () => {} };
  let temporizador = null;
  let sincronizando = false;
  let pendiente = false;

  const cabeceras = () => (token ? { Authorization: 'Bearer ' + token } : {});
  async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
    const r = await fetch(API + ruta, {
      method: metodo,
      headers: { ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...cabeceras() },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && token && ruta !== '/api/auth/entrar' && ruta !== '/api/cuenta/password' && ruta !== '/api/cuenta/borrar') {
      cerrarLocal({ vaciar: true }); // los datos siguen en la cuenta
      opciones.avisar('Tu sesión ha caducado. Vuelve a entrar.');
    }
    if (!r.ok) {
      const e = new Error(d.error || `Error ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return d;
  }

  // Los datos de este dispositivo (favoritas, coches, repostajes…) son de una cuenta concreta.
  // Si entra otra, se vacían antes de sincronizar: así no se mezclan los datos de dos personas.
  // Los datos sin cuenta (propietario null) sí se suben a la primera cuenta que se cree o con la que se entre.
  function fijarSesion(t, u) {
    const propietario = leer('gm.propietario', null);
    if (u && propietario && propietario !== u.id) {
      sync = { version: 0, base: null, cuando: null };
      guardar('gm.sync', null);
      opciones.vaciarLocal?.();
    }
    if (u) guardar('gm.propietario', u.id);
    token = t;
    usuario = u;
    guardar('gm.token', t);
    guardar('gm.usuario', u);
    pintarBoton();
    opciones.alCambiarSesion(u);
    window.GasoAvisos?.refrescar();
  }
  // vaciar: al cerrar sesión a propósito se borran del dispositivo los datos de la cuenta (siguen en ella)
  function cerrarLocal({ vaciar = false } = {}) {
    if (vaciar) {
      opciones.vaciarLocal?.();
      guardar('gm.propietario', null);
    }
    token = null;
    usuario = null;
    sync = { version: 0, base: null, cuando: null };
    guardar('gm.token', null);
    guardar('gm.usuario', null);
    guardar('gm.sync', null);
    pintarBoton();
    opciones.alCambiarSesion(null);
    window.GasoAvisos?.refrescar();
  }

  /* ---------- Sincronización (combinación a tres bandas) ----------
     base = lo último que este dispositivo sincronizó. Así se respetan también los borrados:
     lo que estaba en la base y ya no está en un lado, se ha borrado ahí. */
  function combinarLista(base, local, remoto, clave) {
    const k = clave || ((x) => x);
    const mapa = (l) => new Map((l || []).map((x) => [k(x), x]));
    const B = mapa(base), Lm = mapa(local), R = mapa(remoto);
    const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const out = new Map();
    // Un borrado en un lado gana, salvo que el otro lado lo haya editado (así no se pierden cambios)
    for (const [id, v] of R) if (!(B.has(id) && !Lm.has(id) && igual(v, B.get(id)))) out.set(id, v);
    for (const [id, v] of Lm) if (!(B.has(id) && !R.has(id) && igual(v, B.get(id)))) out.set(id, v); // lo local gana si está en ambos
    return [...out.values()];
  }
  function combinar(base, local, remoto) {
    const b = base || {};
    const porId = (x) => x.id;
    return {
      favoritas: combinarLista(b.favoritas, local.favoritas, remoto.favoritas),
      descuentos: combinarLista(b.descuentos, local.descuentos, remoto.descuentos, porId),
      diario: combinarLista(b.diario, local.diario, remoto.diario, porId),
      ajustes: combinarAjustes(b.ajustes, local.ajustes || {}, remoto.ajustes || {}),
    };
  }
  // Ajustes, clave a clave: si este dispositivo no la ha cambiado desde la última sincronización, gana la de la cuenta.
  // Sin sincronización previa (dispositivo nuevo o recién vaciado), gana la de la cuenta.
  // Los coches se combinan uno a uno, como el diario.
  function combinarAjustes(base, local, remoto) {
    const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remoto)])) {
      if (k === 'coches') {
        out.coches = combinarLista(base?.coches, local.coches || [], remoto.coches || [], (x) => x.id);
        continue;
      }
      const tieneR = Object.prototype.hasOwnProperty.call(remoto, k);
      if (!base || igual(local[k], base[k])) out[k] = tieneR ? remoto[k] : local[k];
      else out[k] = local[k];
    }
    if (out.coches && !out.coches.some((c) => c.id === out.cocheActivo)) out.cocheActivo = out.coches[0]?.id || null;
    return out;
  }

  async function sincronizar() {
    if (!token) return;
    if (sincronizando) {
      pendiente = true;
      return;
    }
    sincronizando = true;
    try {
      for (let intento = 0; intento < 3; intento++) {
        const remoto = await api('/api/cuenta/datos');
        const local = opciones.obtenerLocal();
        const datos = remoto.datos ? combinar(sync.base, local, remoto.datos) : local;
        if (remoto.datos) opciones.aplicarRemoto(datos);
        if (remoto.datos && JSON.stringify(datos) === JSON.stringify(remoto.datos)) {
          sync = { version: remoto.version, base: datos, cuando: Date.now() };
          break;
        }
        try {
          const r = await api('/api/cuenta/datos', { metodo: 'PUT', cuerpo: { version: remoto.version, datos } });
          sync = { version: r.version, base: datos, cuando: Date.now() };
          break;
        } catch (e) {
          if (e.status !== 409) throw e; // otro dispositivo escribió justo ahora: repetir
        }
      }
      guardar('gm.sync', sync);
      pintarEstadoSync();
      pintarBoton();
    } catch (e) {
      if (e.status !== 401) pintarEstadoSync('No se pudo sincronizar. Se reintentará.');
    } finally {
      sincronizando = false;
      if (pendiente) {
        pendiente = false;
        programar();
      }
    }
  }
  function programar() {
    if (!token) return;
    clearTimeout(temporizador);
    temporizador = setTimeout(sincronizar, 1500);
  }

  /* ---------- Interfaz ---------- */
  const panel = () => $('#cuentaPanel');

  function pintarBoton() {
    const b = $('#bCuenta');
    if (!b) return;
    const chev = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    if (usuario) {
      // Iniciales: "Antonio Fernández" → AF
      const ini = (usuario.alias || '?').trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('') || '?';
      b.classList.add('con-avatar');
      b.innerHTML = `<span class="avatar" aria-hidden="true">${esc(ini)}</span>${chev}<span class="sr">Mi cuenta (${esc(usuario.alias)})</span>`;
      b.title = `Mi cuenta · ${usuario.alias}`;
      ponerFotoPerfil($('.avatar', b));
    } else {
      b.classList.remove('con-avatar');
      b.innerHTML = `Entrar${opciones.alPulsarBoton ? chev : ''}`;
      b.title = 'Entrar o crear cuenta';
    }
  }

  /* ---------- Foto de perfil (privada: se guarda como las fotos de los tickets) ----------
     Cada foto nueva tiene su propio identificador (perfil-<versión>) y la versión viaja en los ajustes de la cuenta.
     Así, al cambiarla en un dispositivo, los demás ven otra versión, no la tienen en caché y la descargan.
     (Antes todas usaban el mismo identificador, y los otros dispositivos seguían enseñando su copia guardada.) */
  const FOTO_PERFIL_LEGADO = 'perfil-foto';
  const versionFotoPerfil = () => window.GasoApp?.ajustes().fotoPerfil || null;
  const tieneFotoPerfil = () => Boolean(versionFotoPerfil());
  const idFotoPerfil = (v = versionFotoPerfil()) => (v ? 'perfil-' + v : null);
  async function urlFotoPerfil() {
    const id = idFotoPerfil();
    if (!id || !window.GasoFotos) return null;
    let u = await window.GasoFotos.url(id).catch(() => null);
    // Foto subida con la versión anterior de la app (identificador fijo): se pide siempre a la cuenta
    if (!u) u = await window.GasoFotos.url(FOTO_PERFIL_LEGADO, { fresco: true }).catch(() => null);
    return u;
  }
  function quitarImagenAvatar(caja) {
    if (!caja.classList.contains('con-foto')) return;
    caja.textContent = caja.dataset.ini || '';
    caja.classList.remove('con-foto');
  }
  async function ponerFotoPerfil(caja) {
    if (!caja) return;
    if (caja.dataset.ini === undefined) caja.dataset.ini = caja.classList.contains('con-foto') ? '' : caja.textContent;
    const v = versionFotoPerfil();
    if (!v || !window.GasoFotos) return quitarImagenAvatar(caja);
    const u = await urlFotoPerfil();
    if (!caja.isConnected || versionFotoPerfil() !== v) return; // cambió mientras se cargaba
    if (!u) return quitarImagenAvatar(caja);
    caja.innerHTML = `<img src="${u}" alt="">`;
    caja.classList.add('con-foto');
  }
  // Se llama cuando los ajustes cambian desde otro dispositivo: repinta el avatar y los botones del perfil
  function refrescarFotoPerfil() {
    if (!usuario) return;
    pintarBoton();
    $$('.avatar-perfil').forEach((a) => ponerFotoPerfil(a));
    const tiene = tieneFotoPerfil();
    const txt = $('#pFotoTxt');
    if (txt) txt.textContent = tiene ? 'Cambiar foto' : 'Subir foto';
    $('#bQuitarFotoPerfil') && ($('#bQuitarFotoPerfil').hidden = !tiene);
    $('#bAjustarFotoPerfil') && ($('#bAjustarFotoPerfil').hidden = !tiene);
  }
  // Abre el editor (zoom, encuadre, giro…) y guarda el resultado como nueva versión de la foto
  async function cambiarFotoPerfil(origen) {
    if (!window.EditorImagen) return opciones.avisar('El editor de fotos no está disponible.');
    const blob = await window.EditorImagen.abrir(origen, { titulo: 'Ajustar foto de perfil', salida: 512 });
    if (!blob) return false;
    const anterior = idFotoPerfil();
    const version = Date.now();
    const r = await window.GasoFotos.guardar(idFotoPerfil(version), blob, { directo: true });
    // La versión se publica en los ajustes DESPUÉS de subir la foto, para que otros dispositivos la encuentren
    window.GasoApp.guardarAjustes({ fotoPerfil: version });
    if (anterior) window.GasoFotos.borrar(anterior).catch(() => {});
    window.GasoFotos.borrar(FOTO_PERFIL_LEGADO).catch(() => {});
    opciones.avisar(r.enCuenta ? 'Foto de perfil guardada' : 'Foto guardada solo en este dispositivo (no se pudo subir a tu cuenta)', r.enCuenta ? 2500 : 5000);
    refrescarFotoPerfil();
    return true;
  }

  function pintarEstadoSync(msg) {
    const el = $('#estadoSync');
    if (!el) return;
    if (msg) return (el.textContent = msg);
    el.textContent = sync.cuando
      ? `Favoritas, descuentos y diario sincronizados · ${new Date(sync.cuando).toLocaleString('es-ES', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}`
      : 'Sincronizando…';
  }

  const campo = (id, etiqueta, tipo = 'text', extra = '') =>
    `<label class="campo" for="${id}">${etiqueta}<input id="${id}" type="${tipo}" ${extra}></label>`;
  // El botón de ver/ocultar lo añade ojo.js a cualquier campo de contraseña
  const campoPassword = (id, etiqueta, auto) =>
    `<label class="campo" for="${id}">${etiqueta}<input id="${id}" type="password" autocomplete="${auto}" minlength="8" required></label>`;
  const condiciones = `<label class="check"><input type="checkbox" id="aAcepto"> Tengo 14 años o más, acepto las <a href="condiciones.html" target="_blank" rel="noopener">condiciones de uso</a> y he leído la <a href="privacidad.html" target="_blank" rel="noopener">política de privacidad</a></label>`;
  // Primera capa de información (art. 13 RGPD), junto al formulario donde se recogen los datos
  const infoDatos = (proveedor) => {
    const L = window.LEGAL || {};
    return `<details class="info-datos"><summary>Información básica sobre protección de datos</summary>
      <dl>
        <dt>Responsable</dt><dd>${esc(L.titular || '[titular de GasoCheck]')}</dd>
        <dt>Finalidad</dt><dd>Gestionar tu cuenta${proveedor ? ', comprobar que gestionas las gasolineras que reclames' : ''}, publicar tus valoraciones y sincronizar tus datos entre dispositivos.</dd>
        <dt>Legitimación</dt><dd>Ejecución del servicio que solicitas al registrarte.</dd>
        <dt>Destinatarios</dt><dd>No se ceden datos a terceros salvo obligación legal. Proveedores de alojamiento y de envío de correo.</dd>
        <dt>Derechos</dt><dd>Acceso, rectificación, supresión, portabilidad y otros: desde “Mi cuenta” o escribiendo a ${esc(L.email || '[correo de contacto]')}.</dd>
        <dt>Más información</dt><dd><a href="privacidad.html" target="_blank" rel="noopener">Política de privacidad</a></dd>
      </dl></details>`;
  };

  /* ---------- Pantallas de acceso (entrar, crear cuenta, recuperar…) ---------- */
  const ICONOS = {
    correo: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>',
    candado: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    persona: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"/>',
    empresa: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M10 21v-4h4v4"/>',
    tarjeta: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h6M7 14h10"/>',
    telefono: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    surtidor: '<path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M3 21h13M6.5 7h6v4h-6zM15 9h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
  };
  const ico = (n) => `<svg class="ico-campo" viewBox="0 0 24 24" aria-hidden="true">${ICONOS[n]}</svg>`;
  // Campo con icono a la izquierda (y, si es contraseña, el ojo a la derecha lo añade ojo.js)
  const campoIco = (id, etiqueta, tipo, icono, extra = '', ayuda = '') => `
    <div class="campo-acceso">
      <label for="${id}">${etiqueta}</label>
      <div class="entrada-ico">${ico(icono)}<input id="${id}" type="${tipo}" ${extra}></div>
      ${ayuda ? `<p class="ayuda-campo">${ayuda}</p>` : ''}
    </div>`;
  const pestanasAcceso = (activa) => `
    <div class="pestanas-acceso" role="tablist" aria-label="Entrar o crear cuenta">
      <button type="button" role="tab" data-vista="entrar" aria-selected="${activa === 'entrar'}">Entrar</button>
      <button type="button" role="tab" data-vista="registro" aria-selected="${activa === 'registro'}">Crear cuenta</button>
    </div>`;
  const otrasOpciones = (tengo) => `
    <div class="otras-opciones"><span>Otras opciones</span></div>
    <div class="enlaces-acceso">
      ${tengo ? '<p>¿Ya tienes cuenta? <button type="button" class="enlace" data-vista="entrar">Entrar</button></p>' : '<p>¿No tienes cuenta? <button type="button" class="enlace" data-vista="registro">Crear cuenta</button></p>'}
      <button type="button" class="enlace" data-vista="olvido">He olvidado mi contraseña</button>
    </div>
    <div class="perfiles-acceso">
      <button type="button" class="enlace-ico" data-vista="proveedor">${ico('surtidor')}Tengo una gasolinera</button>
      <button type="button" class="enlace-ico" data-vista="empresa">${ico('empresa')}Soy una empresa con vehículos</button>
    </div>`;
  const AYUDA_PASS = 'Mínimo 8 caracteres, con letras y números.';
  const passValida = (p) => p.length >= 8 && /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(p) && /\d/.test(p);
  const VISTAS_ACCESO = new Set(['entrar', 'registro', 'olvido', 'restablecer', 'proveedor', 'empresa']);

  const VISTAS = {
    entrar: () => `
      ${pestanasAcceso('entrar')}
      <h2 id="cuentaTitulo">Entrar</h2>
      <p class="sub-acceso">Bienvenido de nuevo. Tus favoritas, coches y repostajes te están esperando.</p>
      <form id="fCuenta" class="form-acceso" novalidate>
        ${campoIco('aEmail', 'Correo electrónico', 'email', 'correo', 'autocomplete="email" required placeholder="tu@email.com"')}
        ${campoIco('aPass', 'Contraseña', 'password', 'candado', 'autocomplete="current-password" required placeholder="Tu contraseña"')}
        <p class="error" id="aError" hidden></p>
        <button class="boton primario boton-acceso" type="submit">Entrar</button>
      </form>
      ${otrasOpciones(false)}`,

    registro: () => `
      ${pestanasAcceso('registro')}
      <h2 id="cuentaTitulo">Crear cuenta</h2>
      <p class="sub-acceso">Únete a GasoCheck y empieza a ahorrar desde hoy.</p>
      <form id="fCuenta" class="form-acceso" novalidate>
        ${campoIco('aAlias', 'Nombre', 'text', 'persona', 'autocomplete="nickname" maxlength="30" placeholder="Cómo quieres que te vean (puedes cambiarlo)"')}
        ${campoIco('aEmail', 'Correo electrónico', 'email', 'correo', 'autocomplete="email" required placeholder="tu@email.com"')}
        ${campoIco('aPass', 'Contraseña', 'password', 'candado', 'autocomplete="new-password" required minlength="8" placeholder="Crea una contraseña segura"', AYUDA_PASS)}
        ${campoIco('aPass2', 'Repetir contraseña', 'password', 'candado', 'autocomplete="new-password" required placeholder="Repite tu contraseña"')}
        <label class="check check-acceso"><input type="checkbox" id="aAcepto"><span>Tengo 14 años o más y acepto los <a href="condiciones.html" target="_blank" rel="noopener">Términos de uso</a> y la <a href="privacidad.html" target="_blank" rel="noopener">Política de privacidad</a> de GasoCheck.</span></label>
        <p class="error" id="aError" hidden></p>
        <button class="boton primario boton-acceso" type="submit">Crear cuenta</button>
        ${infoDatos(false)}
      </form>
      ${otrasOpciones(true)}`,

    proveedor: () => `
      <button type="button" class="enlace volver-acceso" data-vista="entrar">← Volver a entrar</button>
      <h2 id="cuentaTitulo">Cuenta de gasolinera</h2>
      <p class="sub-acceso">Para propietarios y gestores. Podrás responder a las valoraciones, añadir servicios, teléfono y promociones, y ver cuántas personas visitan tu ficha.</p>
      <ol class="pasos-prov"><li>Crea la cuenta y confirma tu correo.</li><li>Reclama tus gasolineras desde el panel.</li><li>Las revisamos a mano (puede que te llamemos) y te avisamos.</li></ol>
      <form id="fCuenta" class="form-acceso" novalidate>
        ${campoIco('aEmpresa', 'Razón social', 'text', 'empresa', 'autocomplete="organization" maxlength="80" required')}
        ${campoIco('aCif', 'CIF / NIF', 'text', 'tarjeta', 'autocomplete="off" maxlength="12" required placeholder="B12345674"')}
        ${campoIco('aTel', 'Teléfono de contacto', 'tel', 'telefono', 'autocomplete="tel" required')}
        ${campoIco('aAlias', 'Nombre comercial (público)', 'text', 'surtidor', 'maxlength="30" required placeholder="Ej.: Estación de Servicio Norte"')}
        ${campoIco('aEmail', 'Correo electrónico', 'email', 'correo', 'autocomplete="email" required placeholder="tu@email.com"')}
        ${campoIco('aPass', 'Contraseña', 'password', 'candado', 'autocomplete="new-password" required minlength="8" placeholder="Crea una contraseña segura"', AYUDA_PASS)}
        ${campoIco('aPass2', 'Repetir contraseña', 'password', 'candado', 'autocomplete="new-password" required placeholder="Repite tu contraseña"')}
        ${condiciones.replace('class="check"', 'class="check check-acceso"')}
        <p class="error" id="aError" hidden></p>
        <button class="boton primario boton-acceso" type="submit">Crear cuenta de gasolinera</button>
        ${infoDatos(true)}
      </form>`,

    empresa: () => `
      <button type="button" class="enlace volver-acceso" data-vista="entrar">← Volver a entrar</button>
      <h2 id="cuentaTitulo">GasoCheck Empresas</h2>
      <p class="sub-acceso">Para empresas con vehículos. Tus conductores apuntan los repostajes de empresa desde su móvil y tú ves el gasto, el consumo de cada vehículo y los repostajes raros (más litros que el depósito, dos seguidos, precio por encima del oficial…).</p>
      <form id="fCuenta" class="form-acceso" novalidate>
        ${campoIco('aEmpresa', 'Razón social', 'text', 'empresa', 'autocomplete="organization" maxlength="80" required')}
        ${campoIco('aCif', 'CIF / NIF', 'text', 'tarjeta', 'autocomplete="off" maxlength="12" required placeholder="B12345674"')}
        ${campoIco('aTel', 'Teléfono de contacto', 'tel', 'telefono', 'autocomplete="tel" required')}
        ${campoIco('aAlias', 'Nombre que verán tus conductores', 'text', 'persona', 'maxlength="30" required placeholder="Ej.: Transportes Norte"')}
        ${campoIco('aEmail', 'Correo electrónico', 'email', 'correo', 'autocomplete="email" required placeholder="tu@email.com"')}
        ${campoIco('aPass', 'Contraseña', 'password', 'candado', 'autocomplete="new-password" required minlength="8" placeholder="Crea una contraseña segura"', AYUDA_PASS)}
        ${campoIco('aPass2', 'Repetir contraseña', 'password', 'candado', 'autocomplete="new-password" required placeholder="Repite tu contraseña"')}
        ${condiciones.replace('class="check"', 'class="check check-acceso"')}
        <p class="error" id="aError" hidden></p>
        <button class="boton primario boton-acceso" type="submit">Crear cuenta de empresa</button>
        ${infoDatos(true)}
      </form>`,

    olvido: () => `
      <button type="button" class="enlace volver-acceso" data-vista="entrar">← Volver a entrar</button>
      <h2 id="cuentaTitulo">Recuperar tu cuenta</h2>
      <p class="sub-acceso">Escribe el correo con el que te registraste y te enviaremos un enlace para elegir una contraseña nueva y volver a entrar.</p>
      <ul class="lista-ayuda">
        <li>El enlace sirve durante <b>1 hora</b> y una sola vez.</li>
        <li>Al usarlo, se cierra la sesión en todos tus dispositivos por seguridad.</li>
        <li>Tus favoritas, coches y repostajes siguen guardados en tu cuenta.</li>
      </ul>
      <form id="fCuenta" class="form-acceso" novalidate>
        ${campoIco('aEmail', 'Correo electrónico', 'email', 'correo', `autocomplete="email" required placeholder="tu@email.com" value="${esc(emailRecuperar)}"`)}
        <p class="error" id="aError" hidden></p>
        <button class="boton primario boton-acceso" type="submit">Enviarme el enlace de recuperación</button>
      </form>`,

    restablecer: () => `
      <h2 id="cuentaTitulo">Recupera tu cuenta</h2>
      <p class="sub-acceso">Elige una contraseña nueva. Al guardarla entrarás directamente.</p>
      <form id="fCuenta" class="form-acceso" novalidate>
        ${campoIco('aPass', 'Contraseña nueva', 'password', 'candado', 'autocomplete="new-password" required minlength="8" placeholder="Crea una contraseña segura"', AYUDA_PASS)}
        ${campoIco('aPass2', 'Repetir contraseña', 'password', 'candado', 'autocomplete="new-password" required placeholder="Repite tu contraseña"')}
        <p class="error" id="aError" hidden></p>
        <button class="boton primario boton-acceso" type="submit">Guardar y entrar</button>
      </form>`,

    perfil: () => {
      const u = usuario;
      const esUsuario = u.rol === 'usuario';
      const ini = (u.alias || '?').trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('');
      const apartados = [
        ['resumen', 'Resumen', '<path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"/><circle cx="12" cy="8" r="4"/>'],
        esUsuario && ['coche', 'Mis coches', '<path d="M4 16.5v-4.5l2-5h12l2 5v4.5z"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/><path d="M4 12h16"/>'],
        esUsuario && ['valoraciones', 'Mis valoraciones', '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>'],
        ['datos', 'Datos personales', '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 16c.5-1.6 1.9-2.5 3.5-2.5s3 .9 3.5 2.5M14 10h4M14 13.5h3"/>'],
        ['seguridad', 'Seguridad y acceso', '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'],
        ['privacidad', 'Privacidad y datos', '<path d="M12 3l7 3v5.5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V6z"/>'],
      ].filter(Boolean);
      const ap = (id, titulo, cuerpo) => `<section class="apartado" data-apartado="${id}" role="tabpanel" aria-labelledby="ap-${id}" ${apartado === id ? '' : 'hidden'}><h3 class="apartado-tit">${titulo}</h3>${cuerpo}</section>`;
      return `
      <div class="perfil">
        <header class="perfil-cab">
          <span class="avatar-perfil" aria-hidden="true">${esc(ini)}</span>
          <div class="perfil-quien">
            <h2 id="cuentaTitulo">${esc(u.alias)}</h2>
            <p>${esc(u.email)} · ${{ proveedor: 'Cuenta de gasolinera', empresa: 'Cuenta de empresa', usuario: 'Cuenta personal' }[u.rol]}${u.plan?.pro && !u.plan?.gratis ? ' · <b class="ins-pro">PRO</b>' : ''}</p>
            ${u.verificado ? '<span class="sello-ok">✓ Correo confirmado</span>' : '<span class="sello-pendiente">Correo sin confirmar</span>'}
          </div>
        </header>
        <div class="perfil-cuerpo">
          <nav class="perfil-nav" role="tablist" aria-label="Apartados de tu perfil">
            ${apartados.map(([id, txt, ico]) => `<button type="button" role="tab" id="ap-${id}" data-ir="${id}" aria-selected="${apartado === id}"><svg viewBox="0 0 24 24" aria-hidden="true">${ico}</svg>${txt}</button>`).join('')}
          </nav>
          <div class="perfil-contenido">
            ${ap('resumen', 'Resumen', `
              ${u.verificado ? '' : `<div class="aviso-cuenta"><p><b>Confirma tu correo.</b> Te enviamos un enlace al registrarte. Así tus opiniones cuentan más y podrás recuperar la cuenta si olvidas la contraseña.</p><button type="button" class="boton" id="bReenviar">Reenviar el correo</button></div>`}
              ${u.rol === 'proveedor' ? '<a class="boton primario" href="proveedor.html">Abrir el panel de gasolinera</a>'
                : u.rol === 'empresa' ? '<a class="boton primario" href="empresa.html">Abrir el panel de empresa</a>'
                : `<p class="texto-ayuda" id="estadoSync"></p>${reputacionHTML()}`}
              ${esUsuario ? `<div class="accesos-perfil">
                <button type="button" class="acceso" data-ir="coche"><b>Mis coches</b><span id="resumenCoche">Modelo, foto y consumo medio</span></button>
                <button type="button" class="acceso" data-ir="valoraciones"><b>Mis valoraciones</b><span>Ver, editar o borrar tus opiniones</span></button>
                <button type="button" class="acceso" data-ir="seguridad"><b>Seguridad</b><span>Contraseña, recuperación y sesiones</span></button>
              </div>` : ''}`)}
            ${esUsuario ? `<section class="apartado" data-apartado="coche" id="perfilCoche" role="tabpanel" aria-labelledby="ap-coche" ${apartado === 'coche' ? '' : 'hidden'}></section>` : ''}
            ${esUsuario ? ap('valoraciones', 'Mis valoraciones', '<div id="misValoraciones"><p class="texto-ayuda">Cargando…</p></div>') : ''}
            ${ap('datos', 'Datos personales', `
              <div class="bloque-perfil">
                <h4>Foto de perfil</h4>
                <div class="foto-perfil">
                  <span class="avatar-perfil grande" id="avatarEditar" aria-hidden="true">${esc(ini)}</span>
                  <div class="foto-perfil-acc">
                    <label class="boton" for="pFoto"><span id="pFotoTxt">${tieneFotoPerfil() ? 'Cambiar foto' : 'Subir foto'}</span></label>
                    <input type="file" id="pFoto" accept="image/*" class="sr">
                    <button type="button" class="boton" id="bAjustarFotoPerfil" ${tieneFotoPerfil() ? '' : 'hidden'}>Ajustar encuadre</button>
                    <button type="button" class="boton texto-peligro" id="bQuitarFotoPerfil" ${tieneFotoPerfil() ? '' : 'hidden'}>Quitar foto</button>
                    <p class="texto-ayuda">Solo se ve en tu cuenta (en la cabecera y en tu perfil) y en todos tus dispositivos. Podrás hacer zoom, encuadrar y girarla antes de guardarla.</p>
                  </div>
                </div>
              </div>
              <div class="bloque-perfil">
                <h4>Nombre público</h4>
                <p class="texto-ayuda">Es el nombre que ven los demás junto a tus valoraciones.</p>
                <form id="fAlias" class="form-linea-cuenta" novalidate>
                  <input id="pAlias" value="${esc(u.alias)}" maxlength="30" aria-label="Nombre público">
                  <button class="boton" type="submit">Guardar</button>
                </form>
              </div>
              <div class="bloque-perfil">
                <h4>Correo electrónico</h4>
                <p class="dato-fijo">${esc(u.email)} ${u.verificado ? '<span class="sello-ok">✓ Confirmado</span>' : '<span class="sello-pendiente">Sin confirmar</span>'}</p>
                <p class="texto-ayuda">Es tu usuario para entrar y el correo al que te enviaremos el enlace si necesitas recuperar la cuenta.</p>
              </div>`)}
            ${ap('seguridad', 'Seguridad y acceso', `
              <div class="bloque-perfil">
                <h4>Cambiar contraseña</h4>
                <form id="fPass" class="form-cuenta" novalidate>
                  ${campoPassword('pActual', 'Contraseña actual', 'current-password')}
                  ${campoPassword('pNueva', 'Contraseña nueva (mínimo 8 caracteres)', 'new-password')}
                  <p class="error" id="pError" hidden></p>
                  <button class="boton" type="submit">Cambiar contraseña</button>
                </form>
              </div>
              <div class="bloque-perfil" id="recuperacion">
                <h4>Recuperación de la cuenta</h4>
                <p>Si algún día olvidas la contraseña, pulsa <b>«¿Has olvidado la contraseña? Recupera tu cuenta»</b> al entrar y te enviaremos un enlace a <b>${esc(u.email)}</b>.</p>
                ${u.verificado ? '' : '<p class="texto-peligro">Confirma tu correo para asegurarte de que te llegan los mensajes de recuperación.</p>'}
                <p class="texto-ayuda">¿No recuerdas tu contraseña actual y quieres cambiarla? Te enviamos el enlace ahora.</p>
                <button type="button" class="boton" id="bEnlaceRecuperar">Enviarme un enlace de recuperación</button>
              </div>
              <div class="bloque-perfil">
                <h4>Sesiones</h4>
                <div class="acciones">
                  <button type="button" class="boton" id="bSalir">Cerrar sesión</button>
                  <button type="button" class="boton" id="bSalirTodo">Cerrar en todos los dispositivos</button>
                </div>
              </div>`)}
            ${ap('privacidad', 'Privacidad y datos', `
              <div class="bloque-perfil">
                <h4>Tus datos</h4>
                <p class="texto-ayuda">Descarga una copia de todo lo que GasoCheck guarda de ti (cuenta, valoraciones, repostajes, coche…).</p>
                <div class="acciones"><button type="button" class="boton" id="bExportar">Descargar mis datos</button></div>
              </div>
              <div class="bloque-perfil">
                <h4>Textos legales</h4>
                <p class="enlaces-legales"><a href="aviso-legal.html">Aviso legal</a> · <a href="privacidad.html">Privacidad</a> · <a href="condiciones.html">Condiciones de uso</a> · <a href="almacenamiento.html">Cookies y almacenamiento</a></p>
              </div>
              <div class="bloque-perfil peligro">
                <h4>Borrar cuenta</h4>
                <p class="texto-ayuda">Se borran tu cuenta y tus datos sincronizados. Tus valoraciones se quedan, pero sin tu nombre.${u.rol === 'proveedor' ? ' Tus gasolineras dejarán de estar asociadas.' : ''}</p>
                <form id="fBorrar" class="form-cuenta" novalidate>
                  ${campoPassword('bPass', 'Escribe tu contraseña para confirmar', 'current-password')}
                  <p class="error" id="bError" hidden></p>
                  <button class="boton peligro" type="submit">Borrar mi cuenta para siempre</button>
                </form>
              </div>`)}
          </div>
        </div>
      </div>`;
    },
  };

  let tokenRestablecer = null;
  let emailRecuperar = '';
  let apartado = 'resumen';
  let reputacion = null;
  const NIVELES = { fiable: 'Conductor fiable', normal: 'Normal', baja: 'Baja', anonimo: '—' };
  function reputacionHTML() {
    if (!reputacion) return '';
    const d = reputacion.detalle || {};
    const pct = Math.round((reputacion.peso / 2) * 100);
    return `<div class="reputacion">
      <div class="rep-cab"><span>Tu fiabilidad</span><b class="nivel-${reputacion.nivel}">${NIVELES[reputacion.nivel] || reputacion.nivel}</b></div>
      <div class="rep-barra" role="meter" aria-valuemin="0.2" aria-valuemax="2" aria-valuenow="${reputacion.peso}" aria-label="Fiabilidad"><i style="width:${pct}%"></i></div>
      <p class="texto-ayuda">Tu opinión cuenta ×${String(reputacion.peso).replace('.', ',')} en la nota y en las alertas. ${d.tickets ? `${d.tickets} con ticket. ` : ''}${d.aciertos ? `${d.aciertos} precios corregidos con acierto. ` : ''}Sube con valoraciones con foto del ticket y correcciones de precio que se confirman${d.verificado ? '' : ', y al confirmar tu correo'}.</p>
    </div>`;
  }

  // La cuenta se abre a pantalla completa, sin mapa (como Mis repostajes y Mi coche)
  const ANCLAS = { perfilCoche: 'coche', recuperacion: 'seguridad', misValoraciones: 'valoraciones' };
  function abrir(vista, ancla) {
    const p = panel();
    vista = vista || (usuario ? 'perfil' : 'entrar');
    if (vista === 'perfil' && ancla && ANCLAS[ancla]) apartado = ANCLAS[ancla];
    p.innerHTML = VISTAS_ACCESO.has(vista)
      ? `<div class="acceso-fondo"><div class="acceso-tarjeta">
          <div class="acceso-img">
            <picture>
              <source media="(max-width: 760px)" srcset="img/acceso-movil.jpg">
              <img src="img/acceso.jpg" width="654" height="812" alt="Ahorra en cada repostaje. Encuentra los mejores precios, compara gasolineras y reposta con total confianza. Tus gasolineras favoritas, alertas de precios e historial de repostajes.">
            </picture>
            <p class="acceso-lema" aria-hidden="true">Ahorra en cada <span>repostaje</span></p>
          </div>
          <div class="acceso-form cuerpo-cuenta">${VISTAS[vista]()}</div>
        </div></div>`
      : `<div class="ficha-cab cab-cuenta"><button class="volver" type="button" id="cerrarCuenta">← Volver</button></div><div class="cuerpo-cuenta ${vista === 'perfil' ? 'ancho' : ''}">${VISTAS[vista]()}</div>`;
    p.dataset.vista = vista;
    p.hidden = false;
    p.scrollTop = 0;
    if ($('#vMiCoche')) $('#vMiCoche').innerHTML = ''; // se vuelve a pintar al cerrar la cuenta
    document.body.classList.add('pagina-completa', 'con-cuenta');
    window.GasoHoja?.('alto');
    $('#cerrarCuenta')?.addEventListener('click', cerrar);
    $$('[data-vista]', p).forEach((b) => b.addEventListener('click', () => abrir(b.dataset.vista)));
    $$('[data-ir]', p).forEach((b) => b.addEventListener('click', () => irApartado(b.dataset.ir, true)));
    activar(vista);
    const destino = ancla && !ANCLAS[ancla] && $('#' + ancla, p);
    if (destino) setTimeout(() => destino.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    else if (vista !== 'perfil') {
      ($('#fCuenta input', p) || $('#cuentaTitulo', p))?.focus({ preventScroll: true });
      requestAnimationFrame(() => { const f = $('.acceso-form', p); if (f) f.scrollTop = 0; p.scrollTop = 0; });
    }
    else $('#cerrarCuenta')?.focus({ preventScroll: true });
  }
  function irApartado(id, foco) {
    apartado = id;
    const p = panel();
    $$('.perfil-nav [data-ir]', p).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ir === id)));
    $$('.apartado', p).forEach((s) => (s.hidden = s.dataset.apartado !== id));
    p.scrollTop = 0;
    if (foco) $(`.perfil-nav [data-ir="${id}"]`, p)?.focus({ preventScroll: true });
  }
  function cerrar() {
    panel().hidden = true;
    document.body.classList.remove('con-cuenta');
    window.GasoApp?.alCerrarCuenta?.();
    $('#bCuenta')?.focus();
  }

  async function enviarForm(form, errorEl, fn) {
    const btn = $('button[type="submit"]', form);
    const texto = btn.textContent;
    errorEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Un momento…';
    try {
      await fn();
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = texto;
    }
  }
  const valor = (id) => ($('#' + id)?.value || '').trim();

  function activar(vista) {
    const f = $('#fCuenta');
    const err = $('#aError');
    if (vista === 'entrar') {
      f.addEventListener('submit', (ev) => {
        ev.preventDefault();
        enviarForm(f, err, async () => {
          let r;
          try {
            r = await api('/api/auth/entrar', { metodo: 'POST', cuerpo: { email: valor('aEmail'), password: $('#aPass').value } });
          } catch (e) {
            // Si no puede entrar, se le ofrece recuperar la cuenta con ese mismo correo
            emailRecuperar = valor('aEmail');
            $('#aPass').value = ''; // por si el navegador rellenó una contraseña antigua
            if (!$('#ayudaEntrar')) {
              err.insertAdjacentHTML('afterend', '<p class="ayuda-login" id="ayudaEntrar">Escríbela a mano (el navegador puede haber rellenado una antigua). ¿No la recuerdas? <button type="button" class="enlace" id="bIrRecuperar">Recupera tu cuenta</button></p>');
              $('#bIrRecuperar').addEventListener('click', () => abrir('olvido'));
            }
            requestAnimationFrame(() => { const fo = $('.acceso-form'); if (fo) fo.scrollTop = 0; });
            $('#aPass').focus({ preventScroll: true });
            throw e;
          }
          fijarSesion(r.token, r.usuario);
          opciones.avisar(`Hola, ${r.usuario.alias}`);
          await sincronizar();
          abrir('perfil');
        });
      });
    }
    if (vista === 'registro' || vista === 'proveedor' || vista === 'empresa') {
      f.addEventListener('submit', (ev) => {
        ev.preventDefault();
        enviarForm(f, err, async () => {
          const pass = $('#aPass').value;
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(valor('aEmail'))) throw new Error('Escribe un correo electrónico válido.');
          if (!passValida(pass)) throw new Error('La contraseña necesita al menos 8 caracteres, con letras y números.');
          if ($('#aPass2') && $('#aPass2').value !== pass) throw new Error('Las dos contraseñas no coinciden.');
          if (!$('#aAcepto').checked) throw new Error('Para crear la cuenta tienes que aceptar los Términos de uso y la Política de privacidad.');
          // Cuenta personal: el nombre público se pone solo y se cambia luego en Mi cuenta → Datos personales
          const aliasAuto = 'Conductor ' + String(Math.floor(1000 + Math.random() * 9000));
          const cuerpo = {
            tipo: vista === 'registro' ? 'usuario' : vista,
            alias: vista === 'registro' ? (valor('aAlias') || aliasAuto) : valor('aAlias'),
            email: valor('aEmail'),
            password: $('#aPass').value,
            acepto: $('#aAcepto').checked,
            ...(vista !== 'registro' ? { empresa: valor('aEmpresa'), cif: valor('aCif'), telefono: valor('aTel') } : {}),
          };
          const r = await api('/api/auth/registro', { metodo: 'POST', cuerpo });
          fijarSesion(r.token, r.usuario);
          opciones.avisar(vista === 'registro' && !valor('aAlias')
            ? `Cuenta creada. Tu nombre público es «${r.usuario.alias}»: puedes cambiarlo en Datos personales. Revisa tu correo para confirmarla.`
            : 'Cuenta creada. Revisa tu correo para confirmarla.', 7000);
          if (vista === 'registro') await sincronizar();
          abrir('perfil');
        });
      });
    }
    if (vista === 'olvido') {
      f.addEventListener('submit', (ev) => {
        ev.preventDefault();
        enviarForm(f, err, async () => {
          const email = valor('aEmail');
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Escribe un correo electrónico válido.');
          await api('/api/auth/olvido', { metodo: 'POST', cuerpo: { email } });
          emailRecuperar = email;
          $('.cuerpo-cuenta', panel()).innerHTML = `<h2 id="cuentaTitulo">Revisa tu correo</h2>
            <p>Si hay una cuenta con <b>${esc(email)}</b>, te hemos enviado un enlace para recuperarla. Ábrelo desde este mismo dispositivo o desde cualquier otro: sirve durante 1 hora.</p>
            <p class="texto-ayuda">¿No llega? Espera un par de minutos y mira en la carpeta de correo no deseado o de promociones.</p>
            <div class="acciones"><button type="button" class="boton" id="bReenviarRec">Enviar otra vez</button><button type="button" class="boton" id="bVolverEntrar">Volver a entrar</button></div>`;
          $('#bVolverEntrar').addEventListener('click', () => abrir('entrar'));
          $('#bReenviarRec').addEventListener('click', async (ev) => {
            const b = ev.currentTarget;
            b.disabled = true;
            try {
              await api('/api/auth/olvido', { metodo: 'POST', cuerpo: { email } });
              b.textContent = 'Enviado de nuevo';
            } catch (x) {
              b.textContent = x.message;
            }
          });
        });
      });
    }
    if (vista === 'restablecer') {
      f.addEventListener('submit', (ev) => {
        ev.preventDefault();
        enviarForm(f, err, async () => {
          if (!passValida($('#aPass').value)) throw new Error('La contraseña necesita al menos 8 caracteres, con letras y números.');
          if ($('#aPass2').value !== $('#aPass').value) throw new Error('Las dos contraseñas no coinciden.');
          const r = await api('/api/auth/restablecer', { metodo: 'POST', cuerpo: { token: tokenRestablecer, password: $('#aPass').value } });
          tokenRestablecer = null;
          if (r.token) {
            fijarSesion(r.token, r.usuario);
            await sincronizar().catch(() => {});
            opciones.avisar('Cuenta recuperada. ¡Bienvenido de nuevo!', 4000);
            apartado = 'resumen';
            abrir('perfil');
          } else {
            cerrarLocal();
            opciones.avisar('Contraseña cambiada. Ya puedes entrar.', 4000);
            abrir('entrar');
          }
        });
      });
    }
    if (vista === 'perfil') activarPerfil();
  }

  async function pintarMisValoraciones() {
    const caja = $('#misValoraciones');
    if (!caja) return;
    try {
      const { reportes } = await api('/api/cuenta/reportes');
      if (!reportes.length) {
        caja.innerHTML = '<p class="texto-ayuda">Aún no has valorado ninguna gasolinera con esta cuenta.</p>';
        return;
      }
      caja.innerHTML = `<ul class="mis-val">${reportes
        .map((r) => `<li data-r="${esc(r.id)}">
          <div class="cab"><span><b>${'★'.repeat(r.puntuacion)}${'☆'.repeat(5 - r.puntuacion)}</b> ${esc(r.gasolinera?.rotulo || 'Gasolinera')} · ${esc(r.gasolinera?.localidad || '')}</span>
          <small>${new Date(r.fecha).toLocaleDateString('es-ES')}${r.editado ? ' · editada' : ''}${r.oculto ? ' · <span class="texto-peligro">oculta por denuncias</span>' : ''}</small></div>
          ${r.comentario ? `<p>${esc(r.comentario)}</p>` : ''}
          ${r.respuesta ? `<p class="texto-ayuda">Respuesta de ${esc(r.respuesta.empresa)}: ${esc(r.respuesta.texto)}</p>` : ''}
          <div class="acc">${r.oculto ? '' : `<button type="button" class="enlace" data-ver="${esc(r.estacion)}">Ver o editar</button>`}<button type="button" class="enlace texto-peligro" data-borrar="${esc(r.id)}">Eliminar</button></div>
        </li>`)
        .join('')}</ul>`;
      $$('[data-ver]', caja).forEach((b) => b.addEventListener('click', () => {
        cerrar();
        opciones.abrirGasolinera(b.dataset.ver);
      }));
      $$('[data-borrar]', caja).forEach((b) => b.addEventListener('click', async () => {
        if (b.dataset.paso !== 'confirmar') {
          b.dataset.paso = 'confirmar';
          b.textContent = '¿Seguro? Pulsa para eliminar';
          return;
        }
        try {
          const r = await api('/api/reportes/' + encodeURIComponent(b.dataset.borrar), { metodo: 'DELETE' });
          opciones.alCambiarValoracion(r.estacion, r.resumen);
          opciones.avisar('Valoración eliminada');
          pintarMisValoraciones();
        } catch (e) {
          b.textContent = e.message;
        }
      }));
    } catch (e) {
      caja.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  /* ---------- Mi coche (en el perfil): mis coches, foto, bastidor y consumo medio (coches.js) ---------- */
  function pintarCochePerfil() {
    const caja = $('#perfilCoche');
    if (!caja || !window.GasoCoches) return;
    caja.innerHTML = '<h3 class="apartado-tit">Mis coches</h3><p class="texto-ayuda">Pulsa la foto de un coche para elegirlo. El coche elegido es el que se usa en la calculadora de ahorro y al apuntar repostajes.</p><div id="gestorPerfil"></div><div id="consumoPerfil"></div>';
    const refrescar = () => {
      GasoCoches.pintarGestor($('#gestorPerfil'), { conGaleria: true, alCambiar: refrescar });
      GasoCoches.pintarConsumo($('#consumoPerfil'), { alCambiar: refrescar });
    };
    refrescar();
  }

  function activarPerfil() {
    pintarCochePerfil();
    $$('.avatar-perfil').forEach((a) => ponerFotoPerfil(a));
    $('#pFoto')?.addEventListener('change', async (ev) => {
      const f = ev.target.files?.[0];
      ev.target.value = ''; // permite elegir el mismo archivo otra vez
      if (!f) return;
      if (!/^image\//.test(f.type)) return opciones.avisar('Elige una imagen (JPG, PNG…).');
      try {
        await cambiarFotoPerfil(f);
      } catch (e) {
        opciones.avisar('No se pudo guardar la foto: ' + e.message, 5000);
      }
    });
    $('#bAjustarFotoPerfil')?.addEventListener('click', async () => {
      try {
        const u = await urlFotoPerfil();
        if (!u) return opciones.avisar('No se encuentra la foto actual. Sube una nueva.', 4000);
        await cambiarFotoPerfil(await (await fetch(u)).blob());
      } catch (e) {
        opciones.avisar('No se pudo abrir la foto: ' + e.message, 5000);
      }
    });
    $('#bQuitarFotoPerfil')?.addEventListener('click', async () => {
      const id = idFotoPerfil();
      if (id) await window.GasoFotos?.borrar(id).catch(() => {});
      await window.GasoFotos?.borrar(FOTO_PERFIL_LEGADO).catch(() => {});
      window.GasoApp.guardarAjustes({ fotoPerfil: null });
      refrescarFotoPerfil();
    });
    const coches = window.GasoCoches?.lista() || [];
    if (coches.length && $('#resumenCoche')) {
      $('#resumenCoche').textContent = coches.length === 1
        ? [GasoCoches.nombre(coches[0]), coches[0].anio].filter(Boolean).join(' · ')
        : `${coches.length} coches: ${coches.map((c) => GasoCoches.nombre(c)).join(', ')}`;
    }
    $('#bEnlaceRecuperar')?.addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        await api('/api/auth/olvido', { metodo: 'POST', cuerpo: { email: usuario.email } });
        b.textContent = `Enviado a ${usuario.email}`;
      } catch (e) {
        b.textContent = e.message;
        b.disabled = false;
      }
    });
    if (usuario?.rol === 'usuario') {
      api('/api/auth/yo').then((r) => {
        reputacion = r.reputacion || null;
        const viejo = $('.reputacion');
        if (viejo) viejo.outerHTML = reputacionHTML();
        else $('#estadoSync')?.insertAdjacentHTML('afterend', reputacionHTML());
      }).catch(() => {});
    }
    pintarMisValoraciones();
    pintarEstadoSync();
    $('#bReenviar')?.addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        await api('/api/auth/reenviar', { metodo: 'POST', cuerpo: {} });
        b.textContent = 'Enviado. Revisa tu correo';
      } catch (e) {
        b.textContent = e.message;
      }
    });
    $('#fAlias').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const r = await api('/api/cuenta/perfil', { metodo: 'POST', cuerpo: { alias: $('#pAlias').value } });
        fijarSesion(token, r.usuario);
        opciones.avisar('Nombre guardado');
        abrir('perfil');
      } catch (e) {
        opciones.avisar(e.message, 5000);
      }
    });
    const fp = $('#fPass');
    fp.addEventListener('submit', (ev) => {
      ev.preventDefault();
      enviarForm(fp, $('#pError'), async () => {
        const r = await api('/api/cuenta/password', { metodo: 'POST', cuerpo: { actual: $('#pActual').value, nueva: $('#pNueva').value } });
        fijarSesion(r.token, usuario);
        fp.reset();
        opciones.avisar('Contraseña cambiada. Se han cerrado las demás sesiones.', 4000);
      });
    });
    $('#bSalir').addEventListener('click', async () => {
      await sincronizar().catch(() => {}); // que no se pierda nada pendiente
      await api('/api/auth/salir', { metodo: 'POST', cuerpo: {} }).catch(() => {});
      cerrarLocal({ vaciar: true });
      opciones.avisar('Sesión cerrada. Tus datos siguen guardados en tu cuenta.');
      abrir('entrar');
    });
    $('#bSalirTodo').addEventListener('click', async () => {
      await sincronizar().catch(() => {});
      await api('/api/auth/salir', { metodo: 'POST', cuerpo: { todas: true } }).catch(() => {});
      cerrarLocal({ vaciar: true });
      opciones.avisar('Sesión cerrada en todos los dispositivos.');
      abrir('entrar');
    });
    $('#bExportar').addEventListener('click', async () => {
      try {
        const d = await api('/api/cuenta/exportar');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
        a.download = 'mis-datos-gasocheck.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch (e) {
        opciones.avisar(e.message);
      }
    });
    const fb = $('#fBorrar');
    fb.addEventListener('submit', (ev) => {
      ev.preventDefault();
      enviarForm(fb, $('#bError'), async () => {
        await api('/api/cuenta/borrar', { metodo: 'POST', cuerpo: { password: $('#bPass').value } });
        cerrarLocal({ vaciar: true });
        opciones.avisar('Cuenta borrada.', 4000);
        cerrar();
      });
    });
  }

  /* ---------- Arranque ---------- */
  async function init(op) {
    opciones = { ...opciones, ...op };
    pintarBoton();
    $('#bCuenta')?.addEventListener('click', (ev) => (opciones.alPulsarBoton ? opciones.alPulsarBoton(ev) : abrir()));

    // Enlaces de los correos: ?verificar=… y ?restablecer=…
    const q = new URLSearchParams(location.search);
    const limpiarURL = () => history.replaceState(null, '', location.pathname + location.hash);
    if (q.get('verificar')) {
      const t = q.get('verificar');
      limpiarURL();
      try {
        const r = await api('/api/auth/verificar', { metodo: 'POST', cuerpo: { token: t } });
        if (usuario && usuario.id === r.usuario.id) fijarSesion(token, r.usuario);
        opciones.avisar('Correo confirmado. ¡Gracias!', 4000);
      } catch (e) {
        opciones.avisar(e.message, 6000);
      }
    } else if (q.get('restablecer')) {
      tokenRestablecer = q.get('restablecer');
      limpiarURL();
      abrir('restablecer');
    }

    // Cambios hechos en otro dispositivo (foto de perfil, favoritas, coches…): se traen al volver a la app y cada minuto
    let ultimaSync = 0;
    const alVolver = () => {
      if (!token || document.hidden || Date.now() - ultimaSync < 8000) return;
      ultimaSync = Date.now();
      sincronizar().catch(() => {});
    };
    document.addEventListener('visibilitychange', alVolver);
    window.addEventListener('focus', alVolver);
    window.addEventListener('online', alVolver);
    setInterval(alVolver, 60000);

    if (token) {
      try {
        const r = await api('/api/auth/yo');
        reputacion = r.reputacion || null;
        fijarSesion(token, r.usuario);
        sincronizar();
      } catch {
        /* sin conexión: se usa lo guardado */
      }
    }
  }

  window.Cuenta = {
    init,
    repintarBoton: () => pintarBoton(),
    refrescarFotoPerfil,
    abrir,
    cabeceras,
    usuario: () => usuario,
    cambioLocal: programar,
    sincronizar,
    _combinar: combinar, // para pruebas
  };
})();
