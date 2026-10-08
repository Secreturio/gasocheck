/* GasoCheck — cliente web (sin build; funciona igual dentro de Capacitor/Tauri) */
(() => {
  'use strict';

  const API = (window.GASOCHECK_API || '').replace(/\/$/, '');
  const NOMBRES = {
    gasoleoA: 'Diésel',
    gasoleoPremium: 'Gasoil+',
    gasolina95: 'Gasolina 95',
    gasolina98: 'Gasolina 98',
    glp: 'Autogás (GLP)',
  };
  const LIMITE_LISTA = 80;
  const CONSENSO = 3; // usuarios que deben coincidir para corregir el precio de una gasolinera (igual que en el servidor)
  const RADIO_ZONA_KM = 10; // para comparar con "la zona" en la calculadora
  const FACTOR_CARRETERA = 1.3; // línea recta → distancia aproximada por carretera

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const euros = (n, dec = 3) => (n == null || Number.isNaN(n) ? '—' : n.toFixed(dec).replace('.', ','));
  const num1 = (n) => n.toFixed(1).replace('.', ',');
  const leer = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const CLAVES_SYNC = new Set(['gm.favoritas', 'gm.descuentos', 'gm.diario', 'gm.ajustes']);
  const guardarLocal = (k, v, { sinSync = false } = {}) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ }
    if (!sinSync && CLAVES_SYNC.has(k) && window.Cuenta) Cuenta.cambioLocal();
  };
  const api = async (ruta, opts = {}) => {
    const r = await fetch(API + ruta, { ...opts, headers: { ...(opts.headers || {}), ...(window.Cuenta ? Cuenta.cabeceras() : {}) } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    return d;
  };

  const nuevoIdCoche = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const estado = {
    estaciones: [],
    porId: new Map(),
    lugares: [],
    calidad: {},
    variaciones: {},
    extras: {},
    soloRegistrados: false,
    combustible: leer('gm.combustible', 'gasoleoA'),
    favoritas: new Set(leer('gm.favoritas', [])),
    ajustes: MiCoche.migrarAjustes({ litros: 50, consumo: 6.5, ...leer('gm.ajustes', {}) }, nuevoIdCoche),
    descuentos: leer('gm.descuentos', []),
    verDescuento: leer('gm.verDescuento', false),
    diario: leer('gm.diario', []),
    recientes: leer('gm.recientes', []),
    soloAbiertas: false,
    solo24: false,
    calidadMin: false,
    sinAlertas: false,
    marca: '',
    servicios: new Set(),
    cerca: false,
    radio: leer('gm.radio', 50),
    orden: 'precio',
    lugar: null, // { nombre, provincia?, filtro(e) }
    texto: '',
    yo: null,
    sel: null,
    pestana: 'buscar',
    ambito: [],
    cortes: [0, 0],
    tendencias: new Map(),
  };

  /* ---------- Avisos ---------- */
  let avisoT;
  function avisar(msg, ms = 3500) {
    const a = $('#aviso');
    a.textContent = msg;
    a.hidden = false;
    clearTimeout(avisoT);
    avisoT = setTimeout(() => (a.hidden = true), ms);
  }

  /* ---------- Precio que ve el usuario (oficial o con sus descuentos) ---------- */
  const hayDescuentos = () => estado.descuentos.length > 0;
  const conDescuento = () => estado.verDescuento && hayDescuentos();
  // Precio en el hueco "de la gasolinera": el que publica ella o, si varios usuarios coinciden
  // en que no es ese, el que indican ellos. { precio, fecha, usuarios: n | 0 } o null
  function declarado(e, c = estado.combustible) {
    const d = estado.extras[e.id]?.d?.[c];
    return d ? { precio: d[0], fecha: d[1], usuarios: d[2] === 'u' ? d[3] || 0 : 0 } : null;
  }
  // Tras publicar o corregir un precio, actualiza lo que se sabe de esa gasolinera
  function aplicarPreciosDeclarados(id, precios) {
    const d = {};
    for (const [c, v] of Object.entries(precios || {})) d[c] = v.origen === 'usuarios' ? [v.precio, v.fecha, 'u', v.n] : [v.precio, v.fecha, 'g'];
    estado.extras[id] = { ...(estado.extras[id] || {}), d };
  }
  // Precio de referencia: el oficial; si el Ministerio no lo tiene, el que declara la gasolinera
  const base = (e, c = estado.combustible) => e.precios[c] ?? declarado(e, c)?.precio ?? null;
  const soloDeclarado = (e, c = estado.combustible) => e.precios[c] == null && declarado(e, c) != null;
  function hace(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return `hace ${Math.max(1, m)} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.round(h / 24);
    return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
  }

  const ahorroDe = (e, c = estado.combustible) => MiCoche.mejorDescuento(estado.descuentos, e.rotulo, base(e, c));
  function precio(e, c = estado.combustible) {
    const p = base(e, c);
    if (p == null) return null;
    if (!conDescuento()) return p;
    const d = ahorroDe(e, c);
    return d ? p - d.ahorro : p;
  }

  /* ---------- Horario ---------- */
  const horarioDe = (e) => Horario.estado(e.horario, e.provincia);

  /* ---------- Calidad y variaciones ---------- */
  function claseCalidad(id) {
    const q = estado.calidad[id];
    if (!q || !q.total) return '';
    if (q.alerta) return 'mala';
    return q.puntuacion >= 7 ? 'buena' : q.puntuacion >= 5 ? 'regular' : 'mala';
  }
  const alertaDe = (id) => estado.calidad[id]?.alerta || null;
  const variacion = (id, c = estado.combustible) => estado.variaciones[id]?.[c] ?? 0;

  function htmlVariacion(id) {
    const v = variacion(id);
    if (!v) return '';
    const baja = v < 0;
    return `<span class="var ${baja ? 'baja' : 'sube'}" title="${baja ? 'Ha bajado' : 'Ha subido'} en 7 días">${baja ? '▼' : '▲'} ${euros(Math.abs(v))}</span>`;
  }

  /* ---------- Mapa ---------- */
  const oscuro = () =>
    document.documentElement.dataset.theme === 'dark' ||
    (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  // Mapa base: OpenStreetMap, gratuito y sin clave. En modo oscuro se oscurece con un filtro CSS.
  // Para usar otro proveedor (p. ej. MapTiler con tu clave), define antes de cargar app.js:
  //   window.GASOCHECK_TESELAS = { url: 'https://…/{z}/{x}/{y}.png?key=…', atribucion: '…', oscurecer: true }
  const T = window.GASOCHECK_TESELAS || {};
  const mapa = L.map('mapa', { zoomControl: false }).setView([40.2, -3.7], 6);
  L.control.scale({ imperial: false, position: 'bottomright', maxWidth: 110 }).addTo(mapa);
  const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">colaboradores de OpenStreetMap</a>';
  const fuentesMapa = [
    T.url ? { url: T.url, atribucion: T.atribucion || OSM, maxZoom: T.maxZoom, subdominios: T.subdominios } : null,
    { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', atribucion: OSM },
    // Reserva si el servidor principal falla: OpenStreetMap Francia (estilo humanitario), también gratuito
    { url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', atribucion: OSM + ', estilo <a href="https://www.hotosm.org/">HOT</a> (OSM France)', maxZoom: 19 },
  ].filter(Boolean);
  let fuenteMapa = 0;
  let fallosMapa = 0;
  let cargadasMapa = 0;
  const crearCapaBase = () => {
    const f = fuentesMapa[fuenteMapa];
    const capa = L.tileLayer(f.url, {
      maxZoom: f.maxZoom || 19,
      subdomains: f.subdominios || 'abc',
      attribution: f.atribucion,
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    capa.on('tileload', () => cargadasMapa++);
    capa.on('tileerror', () => {
      // Si fallan muchos mosaicos y casi ninguno carga, se pasa a la siguiente fuente
      if (++fallosMapa >= 6 && cargadasMapa < 2 && fuenteMapa < fuentesMapa.length - 1) {
        fuenteMapa++;
        fallosMapa = cargadasMapa = 0;
        mapa.removeLayer(capa);
        crearCapaBase();
        console.warn('Mapa base: cambio a', fuentesMapa[fuenteMapa].url);
      }
    });
    capa.addTo(mapa);
  };
  crearCapaBase();
  const tonoMapa = () => mapa.getContainer().classList.toggle('mapa-oscuro', T.oscurecer !== false && oscuro());
  tonoMapa();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', tonoMapa);
  new MutationObserver(tonoMapa).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const grupo = L.markerClusterGroup({
    chunkedLoading: true,
    showCoverageOnHover: false,
    maxClusterRadius: (z) => (z >= 13 ? 30 : 60),
    disableClusteringAtZoom: 15,
    iconCreateFunction(c) {
      let min = Infinity;
      let alerta = false;
      let suma = 0, n2 = 0;
      for (const m of c.getAllChildMarkers()) {
        if (m.precio != null && m.precio < min) min = m.precio;
        if (m.precio != null) { suma += m.precio; n2++; }
        if (m.alerta) alerta = true;
      }
      // Anillo verde: de media, esta zona está entre las más baratas de lo que se ve
      const barata = n2 && estado.cortes[0] && suma / n2 <= estado.cortes[0];
      const n = c.getChildCount();
      return L.divIcon({
        className: 'grupo',
        html: `<div class="${alerta ? 'con-alerta' : ''}${barata ? ' barata' : ''}" title="${n} gasolineras${min === Infinity ? '' : ' · desde ' + euros(min) + ' €/l'}${alerta ? ' · alguna con alerta de calidad' : ''}"><span>${n}</span></div>`,
        iconSize: [50, 50],
      });
    },
  });
  mapa.addLayer(grupo);
  let marcadorYo = null;
  const marcadores = new Map();

  function tier(p) {
    if (p == null) return 't-sin';
    if (p <= estado.cortes[0]) return 't-barato';
    if (p >= estado.cortes[1]) return 't-caro';
    return 't-medio';
  }

  function icono(e) {
    const p = precio(e);
    const q = claseCalidad(e.id);
    const dot = q === 'buena' && !alertaDe(e.id) ? '<span class="q buena"></span>' : '';
    const dto = conDescuento() && ahorroDe(e) ? '<span class="dto" title="Con tu descuento">%</span>' : '';
    const cls = [tier(p), estado.sel === e.id ? 'sel' : '', alertaDe(e.id) ? 'alerta' : '', estado.favoritas.has(e.id) ? 'fav' : '']
      .filter(Boolean)
      .join(' ');
    // La gasolinera abierta en la ficha: chincheta azul grande y recuadro con nombre y precio
    if (estado.sel === e.id) {
      return L.divIcon({
        className: 'pin-sel',
        html: `<div class="chincheta"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-surtidor"/></svg></div><div class="globo"><span class="globo-ico"><svg aria-hidden="true"><use href="#i-surtidor"/></svg></span><span><b>${esc(e.rotulo)}</b><strong class="${tier(p)}">${euros(p)} <small>€/l</small></strong></span></div>`,
        iconSize: [0, 0],
        zIndexOffset: 1000,
      });
    }
    return L.divIcon({ className: 'pin', html: `<div class="${cls}"><span class="pin-ico" aria-hidden="true"><svg><use href="#i-surtidor"/></svg></span>${euros(p)}${dto}${dot}</div>`, iconSize: [0, 0] });
  }
  const repintarIcono = (id) => {
    const m = marcadores.get(id);
    if (!m) return;
    m.setIcon(icono(estado.porId.get(id)));
    m.setZIndexOffset(estado.sel === id ? 1000 : 0);
  };

  function pintarMapa() {
    grupo.clearLayers();
    marcadores.clear();
    const capas = [];
    for (const e of estado.ambito) {
      const m = L.marker([e.lat, e.lng], { icon: icono(e), title: `${e.rotulo} · ${e.localidad}`, keyboard: false });
      m.precio = precio(e);
      m.alerta = !!alertaDe(e.id);
      m.on('click', () => abrirFicha(e.id));
      marcadores.set(e.id, m);
      capas.push(m);
    }
    grupo.addLayers(capas);
  }

  /* ---------- Filtrado y listas ---------- */
  function percentil(ord, q) {
    if (!ord.length) return 0;
    return ord[Math.min(ord.length - 1, Math.max(0, Math.floor(q * (ord.length - 1))))];
  }

  function calcularAmbito() {
    const c = estado.combustible;
    const palabras = norm(estado.texto).trim().split(/\s+/).filter(Boolean);
    estado.ambito = estado.estaciones.filter((e) => {
      if (base(e, c) == null || e.venta !== 'publico') return false;
      if (estado.solo24 && !/24\s*h/i.test(e.horario)) return false;
      if (estado.soloAbiertas && horarioDe(e)?.abierta === false) return false; // horario desconocido: se muestra
      if (estado.marca && e.rotulo !== estado.marca) return false;
      if (estado.servicios.size) {
        const s = estado.extras[e.id]?.s || [];
        for (const k of estado.servicios) if (!s.includes(k)) return false;
      }
      if (estado.cerca && estado.yo && estado.radio > 0 && distanciaKm(estado.yo, e) > estado.radio) return false;
      if (estado.calidadMin && !(estado.calidad[e.id]?.puntuacion >= 7)) return false;
      if (estado.sinAlertas && alertaDe(e.id)) return false;
      if (estado.lugar && !estado.lugar.filtro(e)) return false;
      if (palabras.length && !palabras.every((w) => e._txt.includes(w))) return false;
      return true;
    });
    const precios = estado.ambito.map((e) => precio(e, c)).sort((a, b) => a - b);
    estado.cortes = [percentil(precios, 0.33), percentil(precios, 0.67)];
  }

  function distanciaKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function ordenar(lista) {
    const c = estado.combustible;
    const porPrecio = (a, b) => (precio(a, c) ?? 99) - (precio(b, c) ?? 99);
    if (estado.orden === 'distancia' && estado.yo) {
      lista.forEach((e) => (e._d = distanciaKm(estado.yo, e)));
      return lista.sort((a, b) => a._d - b._d);
    }
    if (estado.orden === 'calidad') {
      const q = (e) => estado.calidad[e.id]?.puntuacion ?? -1;
      return lista.sort((a, b) => q(b) - q(a) || porPrecio(a, b));
    }
    if (estado.orden === 'bajada') return lista.sort((a, b) => variacion(a.id) - variacion(b.id) || porPrecio(a, b));
    return lista.sort(porPrecio);
  }

  // "Logo" de la marca: no usamos logotipos reales (son marcas registradas), sino un distintivo con su nombre
  const COLORES_MARCA = ['#e4572e', '#1d6cf2', '#0f9d58', '#d93025', '#8e44ad', '#f29900', '#00897b', '#c2185b', '#3949ab', '#6d4c41'];
  function logoMarca(rotulo) {
    const t = String(rotulo || '?').replace(/^(E\.?S\.?|ESTACI[OÓ]N DE SERVICIO|GASOLINERA)\s+/i, '').trim() || String(rotulo || '?');
    let h = 0;
    for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const color = COLORES_MARCA[h % COLORES_MARCA.length];
    const corto = t.split(/\s+/).slice(0, 2).join(' ').slice(0, 16);
    // Tamaño de letra según lo larga que sea la palabra más larga, para que no se parta
    const larga = Math.max(...corto.split(' ').map((w) => w.length));
    const tam = larga <= 6 ? 13 : larga <= 8 ? 11 : larga <= 10 ? 9.5 : 8.5;
    return `<span class="logo-marca" style="--c:${color};font-size:${tam}px" aria-hidden="true"><span><b>${esc(t.charAt(0))}</b>${esc(corto)}</span></span>`;
  }
  // "Abierta · 24h", "Abierta · Cierra 22:00", "Cerrada · Abre 06:00"
  function lineaHorario(e) {
    const h = horarioDe(e);
    if (!h) return '<span class="estado-linea"><span class="pt"></span>Horario no disponible</span>';
    let extra = '';
    const t = h.texto || '';
    let m;
    if (/24 h/.test(t)) extra = '24h';
    else if ((m = t.match(/hasta las (\d\d:\d\d)/))) extra = 'Cierra ' + m[1];
    else if (/sin cierre/.test(t)) extra = 'Sin cierre esta noche';
    else if ((m = t.match(/abre (.*?)\s*a las (\d\d:\d\d)/))) extra = `Abre ${m[1] ? m[1] + ' ' : ''}${m[2]}`;
    return `<span class="estado-linea ${h.abierta ? 'abierta' : 'cerrada'}"><span class="pt"></span><b>${h.abierta ? 'Abierta' : 'Cerrada'}</b>${extra ? ' • ' + esc(extra) : ''}</span>`;
  }
  const SERVICIOS_LISTA = {
    tienda: ['Tienda', 'i-tienda'],
    lavado: ['Autolavado', 'i-lavado'],
    cafeteria: ['Cafetería', 'i-cafe'],
    adblue: ['AdBlue', 'i-gota', 'azul'],
  };
  const chipServicio = ([txt, ico, cls = '']) => `<span class="serv ${cls}"><svg aria-hidden="true"><use href="#${ico}"/></svg>${txt}</span>`;

  function filaHTML(e) {
    const c = estado.combustible;
    const q = estado.calidad[e.id];
    const p = precio(e, c);
    const oficial = base(e, c);
    const dto = oficial != null ? ahorroDe(e, c) : null;
    const decl = declarado(e, c);
    // Si la gasolinera declara un precio distinto del oficial, se ve al lado
    const chipDecl = decl && e.precios[c] != null && Math.abs(decl.precio - e.precios[c]) >= 0.0005
      ? (decl.usuarios
        ? `<span class="serv decl usuarios" title="Precio que indican ${decl.usuarios} usuarios, ${hace(decl.fecha)}">Usuarios: ${euros(decl.precio)}</span>`
        : `<span class="serv decl" title="Precio que declara la gasolinera, ${hace(decl.fecha)}">Gasolinera: ${euros(decl.precio)}</span>`)
      : '';
    // Debajo del precio: la "otra" vista, para poder comparar sin cambiar de modo
    const sub =
      p == null ? 'no vende'
      : soloDeclarado(e, c) ? (decl?.usuarios ? 'según usuarios' : 'declarado')
      : dto && conDescuento() ? `oficial ${euros(oficial)}`
      : dto ? `<span class="tu-precio">tú ${euros(oficial - dto.ahorro)}</span>`
      : '€/litro';
    const al = alertaDe(e.id);
    const valoracion = q && q.total
      ? `<span class="valoracion ${claseCalidad(e.id)}" title="Nota de calidad: ${num1(q.puntuacion)} sobre 10 (${q.total} ${q.total === 1 ? 'valoración' : 'valoraciones'})"><svg aria-hidden="true"><use href="#i-estrella"/></svg>${num1(q.puntuacion)}</span>`
      : '<span class="valoracion sin" title="Aún nadie ha valorado el combustible de esta gasolinera">Sin valorar</span>';
    const dist = estado.yo ? `<span class="dist"><svg aria-hidden="true"><use href="#i-pin"/></svg>A ${num1(distanciaKm(estado.yo, e))} km</span>` : '';
    const fav = estado.favoritas.has(e.id) ? '<span class="estrella-fav" aria-label="Favorita">★</span>' : '';
    const ex = estado.extras[e.id] || {};
    const verif = ex.v ? '<svg class="verif" role="img" aria-label="Gasolinera verificada"><title>Gasolinera verificada: la gestiona su propietario</title><use href="#i-check"/></svg>' : '';
    const servicios = (ex.s || []).filter((k) => SERVICIOS_LISTA[k]).slice(0, 3).map((k) => chipServicio(SERVICIOS_LISTA[k])).join('');
    const etiquetas = [
      al ? `<span class="serv aviso" title="${esc(al.texto)}">⚠ Alerta de calidad</span>` : '',
      ex.p ? '<span class="serv promo">Promo</span>' : '',
      chipDecl,
      servicios,
      htmlVariacion(e.id),
    ].join('');
    return `<li class="fila${estado.sel === e.id ? ' sel' : ''}" tabindex="0" data-id="${esc(e.id)}">
      ${logoMarca(e.rotulo)}
      <span class="nombre">${fav}<span class="txt">${esc(e.rotulo)}</span>${verif}</span>
      <span class="precio ${p == null ? 't-sin' : tier(p)}${dto && conDescuento() ? ' con-dto' : ''}">${euros(p)}<small>${sub}</small></span>
      <span class="dir">${esc(e.direccion)} • ${esc(e.localidad)}</span>
      ${lineaHorario(e)}
      <span class="pie-fila">${dist}${etiquetas}</span>
      ${valoracion}
    </li>`;
  }

  function pintarLista() {
    if (!estado.estaciones.length) return;
    const c = estado.combustible;
    const b = mapa.getBounds();
    const vis = ordenar(estado.ambito.filter((e) => b.contains([e.lat, e.lng])));
    const resumen = $('#resumen');
    if (!vis.length) {
      resumen.innerHTML = estado.ambito.length
        ? `<b>${estado.ambito.length.toLocaleString('es-ES')}</b> gasolineras encontradas fuera de la vista del mapa.`
        : 'Sin resultados.';
      $('#lista').innerHTML = `<li class="vacio">${
        estado.ambito.length ? 'Aleja el mapa o mueve la vista para verlas en la lista.' : 'Ninguna gasolinera coincide. Prueba con otra búsqueda o quita filtros.'
      }</li>`;
      return;
    }
    const ps = vis.map((e) => precio(e, c));
    const media = ps.reduce((a, x) => a + x, 0) / ps.length;
    const lugar = estado.lugar ? ` en <b>${esc(estado.lugar.nombre)}</b>` : ' en la vista';
    resumen.innerHTML = `<b>${vis.length.toLocaleString('es-ES')}</b> gasolineras${lugar} · ${esc(NOMBRES[c])}: mín. <b>${euros(Math.min(...ps))}</b> · media <b>${euros(media)}</b> €/l${
      conDescuento() ? ' <span class="etq-dto">con tus descuentos</span>' : ''
    }`;
    $('#lista').innerHTML =
      vis.slice(0, LIMITE_LISTA).map(filaHTML).join('') +
      (vis.length > LIMITE_LISTA ? `<li class="vacio">Se muestran las ${LIMITE_LISTA} primeras. Acerca el mapa para ver el resto.</li>` : '');
  }

  function pintarFavoritas() {
    $('#nFav').textContent = estado.favoritas.size ? String(estado.favoritas.size) : '';
    const el = $('#listaFav');
    if (!estado.estaciones.length) return;
    if (!conSesion()) {
      el.innerHTML = `<li class="fav-vacio">
        <img src="img/favoritos-vacio.jpg" alt="" width="486" height="310">
        <h3>Guarda tus favoritas con una cuenta</h3>
        <p>Entra o crea una cuenta gratis para guardar gasolineras con <span class="estrella-ico">☆</span> y tenerlas en todos tus dispositivos.</p>
        <div class="acciones-sin-sesion"><button type="button" class="boton primario boton-grande" data-cuenta="entrar">Entrar</button><button type="button" class="boton boton-grande" data-cuenta="registro">Crear cuenta gratis</button></div>
      </li>`;
      activarSinSesion(el);
      return;
    }
    const favs = [...estado.favoritas].map((id) => estado.porId.get(id)).filter(Boolean);
    if (!favs.length) {
      el.innerHTML = `<li class="fav-vacio">
        <img src="img/favoritos-vacio.jpg" alt="" width="486" height="310">
        <h3>Aún no tienes favoritas</h3>
        <p>Guarda una gasolinera y pulsa <span class="estrella-ico" aria-label="Guardar">☆</span> para tenerla siempre a mano y comparar sus precios de un vistazo.</p>
        <button type="button" class="boton primario boton-grande" id="bExplorar"><svg aria-hidden="true"><use href="#i-brujula"/></svg>Explorar gasolineras</button>
      </li>`;
      $('#bExplorar').addEventListener('click', () => {
        cambiarPestana('buscar');
        hoja('medio');
      });
      return;
    }
    const c = estado.combustible;
    favs.sort((a, b) => (precio(a, c) ?? 99) - (precio(b, c) ?? 99));
    el.innerHTML = favs.map(filaHTML).join('');
  }

  /* ---------- ¿Lleno ahora o espero? ---------- */
  const consejos = new Map();
  function provinciaActual() {
    if (estado.lugar?.provincia) return estado.lugar.provincia;
    if (estado.yo) {
      let mejor = null, d = Infinity;
      for (const e of estado.estaciones) {
        const x = Math.abs(e.lat - estado.yo.lat) + Math.abs(e.lng - estado.yo.lng);
        if (x < d) { d = x; mejor = e; }
      }
      return mejor?.provincia || '';
    }
    return '';
  }
  async function pintarConsejo() {
    const caja = $('#consejo');
    if (!caja || !estado.estaciones.length) return;
    const prov = provinciaActual();
    const k = prov + '|' + estado.combustible;
    try {
      if (!consejos.has(k)) consejos.set(k, api(`/api/consejo?combustible=${estado.combustible}${prov ? '&provincia=' + encodeURIComponent(prov) : ''}`));
      const c = await consejos.get(k);
      if (prov + '|' + estado.combustible !== k) return;
      if (c.decision === 'sin_datos') return (caja.hidden = true);
      const icono = { ahora: '⛽', esperar: '⏳', igual: '≈' }[c.decision] || '•';
      caja.className = `consejo c-${c.decision}`;
      caja.innerHTML = `<span class="consejo-ico" aria-hidden="true">${icono}</span><div><b>${esc(c.titulo)}</b> <small>· ${esc(NOMBRES[estado.combustible])} en ${esc(c.ambito)}</small><p>${esc(c.texto)}</p></div>`;
      caja.hidden = false;
    } catch {
      caja.hidden = true;
    }
  }

  function refrescar({ conMapa = true } = {}) {
    calcularAmbito();
    if (conMapa) pintarMapa();
    pintarLista();
    pintarFavoritas();
    if (estado.pestana === 'estadisticas') pintarEstadisticas();
    pintarInterruptorPrecio();
  }

  /* ---------- Interruptor: precio oficial / con mis descuentos ---------- */
  function pintarInterruptorPrecio() {
    const caja = $('#vistaPrecio');
    caja.hidden = !hayDescuentos();
    if (!hayDescuentos()) return;
    $$('button', caja).forEach((b) => b.setAttribute('aria-checked', String((b.dataset.v === 'dto') === conDescuento())));
  }
  $$('#vistaPrecio button').forEach((b) =>
    b.addEventListener('click', () => {
      estado.verDescuento = b.dataset.v === 'dto';
      guardarLocal('gm.verDescuento', estado.verDescuento);
      refrescar();
      if (estado.sel) abrirFicha(estado.sel, { sinMover: true });
      avisar(estado.verDescuento ? 'Mostrando precios con tus descuentos' : 'Mostrando precios oficiales', 1800);
    })
  );

  /* ---------- Carga de datos ---------- */
  async function cargar() {
    try {
      const [datos, cal, vari, ext] = await Promise.all([
        api('/api/estaciones'),
        api('/api/calidad').catch(() => ({ calidad: {} })),
        api('/api/variaciones').catch(() => ({ variaciones: {} })),
        api('/api/extras').catch(() => ({ extras: {} })),
      ]);
      estado.extras = ext.extras || {};
      estado.calidad = cal.calidad || {};
      estado.variaciones = vari.variaciones || {};
      estado.estaciones = datos.estaciones;
      estado.porId.clear();

      const lugares = new Map();
      const marcas = new Map();
      for (const e of datos.estaciones) {
        e._txt = norm(`${e.rotulo} ${e.direccion} ${e.localidad} ${e.municipio} ${e.provincia} ${e.cp}`);
        estado.porId.set(e.id, e);
        marcas.set(e.rotulo, (marcas.get(e.rotulo) || 0) + 1);
        for (const [tipo, nombre, extra] of [
          ['municipio', e.municipio, e.provincia],
          ['provincia', e.provincia, 'Provincia'],
        ]) {
          const k = tipo + '|' + nombre + '|' + extra;
          let l = lugares.get(k);
          if (!l) lugares.set(k, (l = { tipo, nombre, extra, n: 0, s: -90, w: 180, nn: 90, ee: -180, _n: norm(nombre) }));
          l.n++;
          l.nn = Math.min(l.nn, e.lat);
          l.s = Math.max(l.s, e.lat);
          l.w = Math.min(l.w, e.lng);
          l.ee = Math.max(l.ee, e.lng);
        }
      }
      estado.lugares = [...lugares.values()];

      // Marcas con más gasolineras, en orden alfabético
      const top = [...marcas].sort((a, b) => b[1] - a[1]).slice(0, 40).sort((a, b) => a[0].localeCompare(b[0], 'es'));
      $('#fMarca').innerHTML = '<option value="">Todas</option>' + top.map(([m, n]) => `<option value="${esc(m)}">${esc(m)} (${n})</option>`).join('');
      $('#fMarca').value = estado.marca;

      estado.fechaDatos = datos.fecha || '';
      const fecha = datos.demo ? 'Datos de DEMOSTRACIÓN (no reales)' : `Precios oficiales · ${datos.fecha}`;
      $('#fuente').textContent = datos.desactualizado ? `${fecha} · sin conexión con el Ministerio` : fecha;
      refrescar();
      abrirDesdeHash();
      pintarConsejo();
    } catch (err) {
      $('#fuente').textContent = 'Sin datos';
      $('#resumen').textContent = '';
      $('#lista').innerHTML = `<li class="vacio">No se pudieron cargar los precios. ${esc(err.message)}<br><br><button class="boton" id="reintentar" type="button">Reintentar</button></li>`;
      $('#reintentar')?.addEventListener('click', cargar);
    }
  }

  /* ---------- Buscador ---------- */
  const q = $('#q');
  const buscadores = []; // el del panel y el que está sobre el mapa

  function elegirLugar(l) {
    const filtro = l.tipo === 'provincia' ? (e) => e.provincia === l.nombre : (e) => e.municipio === l.nombre && e.provincia === l.extra;
    setTimeout(pintarConsejo, 0);
    estado.lugar = {
      nombre: l.tipo === 'provincia' ? `provincia de ${l.nombre}` : l.nombre,
      provincia: l.tipo === 'provincia' ? l.nombre : l.extra,
      filtro,
    };
    estado.texto = '';
    buscadores.forEach((b) => { b.input.value = l.nombre; b.cerrar(); });
    cambiarPestana('buscar');
    calcularAmbito();
    pintarMapa();
    const pad = 0.01;
    mapa.fitBounds([[l.nn - pad, l.w - pad], [l.s + pad, l.ee + pad]], { maxZoom: 14, padding: [20, 20] });
    pintarLista();
    irA('lista');
    cerrarTeclado();
    hoja('medio');
  }
  // Búsqueda libre (marca, calle, código postal…)
  function buscarTexto(texto) {
    buscadores.forEach((b) => { b.input.value = texto; b.cerrar(); });
    estado.lugar = null;
    estado.texto = texto;
    cambiarPestana('buscar');
    calcularAmbito();
    pintarMapa();
    if (estado.ambito.length) mapa.fitBounds(L.latLngBounds(estado.ambito.map((e) => [e.lat, e.lng])), { maxZoom: 14, padding: [20, 20] });
    pintarLista();
    cerrarTeclado();
    hoja('medio');
  }

  // Conecta un cuadro de búsqueda con su lista de sugerencias (municipios y provincias)
  function conectarBuscador(input, sug, prefijo, { alEnterVacio } = {}) {
    let opciones = [];
    let activa = -1;
    const cerrar = () => {
      sug.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
    const mostrar = () => {
      const t = norm(input.value).trim();
      if (t.length < 2) return cerrar();
      opciones = estado.lugares
        .filter((l) => l._n.includes(t))
        .sort((a, b) => b._n.startsWith(t) - a._n.startsWith(t) || (b.tipo === 'provincia') - (a.tipo === 'provincia') || b.n - a.n)
        .slice(0, 7);
      activa = -1;
      if (!opciones.length) return cerrar();
      sug.innerHTML = opciones
        .map((l, i) => `<li role="option" id="${prefijo}${i}" data-i="${i}" aria-selected="false"><span>${esc(l.nombre)}</span><small>${l.tipo === 'provincia' ? 'Provincia' : esc(l.extra)} · ${l.n}</small></li>`)
        .join('');
      sug.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    let tBusq;
    input.addEventListener('input', () => {
      mostrar();
      clearTimeout(tBusq);
      tBusq = setTimeout(() => {
        if (!input.value.trim() && (estado.lugar || estado.texto)) {
          estado.lugar = null;
          estado.texto = '';
          buscadores.forEach((b) => b.input !== input && (b.input.value = ''));
          refrescar();
        }
      }, 250);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (sug.hidden) return;
        ev.preventDefault();
        activa = (activa + (ev.key === 'ArrowDown' ? 1 : -1) + opciones.length) % opciones.length;
        $$('li', sug).forEach((li, i) => li.setAttribute('aria-selected', String(i === activa)));
        input.setAttribute('aria-activedescendant', prefijo + activa);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (!sug.hidden && activa >= 0) return elegirLugar(opciones[activa]);
        if (!input.value.trim() && alEnterVacio) return alEnterVacio();
        // Si lo escrito coincide con un municipio o provincia, se va a él; si no, búsqueda libre
        const t = norm(input.value).trim();
        const exacto = estado.lugares.filter((l) => l._n === t).sort((a, b) => (b.tipo === 'provincia') - (a.tipo === 'provincia') || b.n - a.n)[0];
        if (exacto) return elegirLugar(exacto);
        buscarTexto(input.value);
      } else if (ev.key === 'Escape') {
        cerrar();
      }
    });
    sug.addEventListener('mousedown', (ev) => {
      const li = ev.target.closest('li');
      if (li) {
        ev.preventDefault();
        elegirLugar(opciones[+li.dataset.i]);
      }
    });
    input.addEventListener('blur', () => setTimeout(cerrar, 120));
    const b = { input, cerrar };
    buscadores.push(b);
    return b;
  }
  conectarBuscador(q, $('#sugerencias'), 'op');

  /* ---------- Filtros ---------- */
  $$('.combustibles button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.c === estado.combustible));
    b.addEventListener('click', () => {
      estado.combustible = b.dataset.c;
      guardarLocal('gm.combustible', estado.combustible);
      pintarConsejo();
      $$('.combustibles button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      refrescar();
      if (estado.sel) abrirFicha(estado.sel, { sinMover: true });
      window.GasoGPS?.alCambiarCombustible();
    });
  });
  $('#f24').addEventListener('change', (e) => { estado.solo24 = e.target.checked; refrescar(); });
  $('#fCalidad').addEventListener('change', (e) => { estado.calidadMin = e.target.checked; refrescar(); });
  $('#fAlertas').addEventListener('change', (e) => { estado.sinAlertas = e.target.checked; refrescar(); });
  $('#fAbiertas').addEventListener('change', (e) => { estado.soloAbiertas = e.target.checked; refrescar(); });
  // Las gasolineras abren y cierran: recalcular cada 5 minutos si el filtro está activo
  setInterval(() => { if (estado.soloAbiertas && estado.estaciones.length) refrescar(); else pintarLista(); }, 5 * 60 * 1000);
  $('#fMarca').addEventListener('change', (e) => { estado.marca = e.target.value; refrescar(); marcarFiltros(); });
  // Servicios: solo los conocemos de las gasolineras verificadas que los indican en su ficha
  $('#fLavado').addEventListener('change', (e) => { estado.servicios[e.target.checked ? 'add' : 'delete']('lavado'); refrescar(); });
  $('#fTienda').addEventListener('change', (e) => { estado.servicios[e.target.checked ? 'add' : 'delete']('tienda'); refrescar(); });
  $('#fCalidad').addEventListener('change', marcarFiltros);
  $('#fAlertas').addEventListener('change', marcarFiltros);

  // Ordenar por: Precio · Distancia · Confianza (nota de calidad)
  function fijarOrden(o) {
    estado.orden = o;
    $$('.segmentos [data-orden]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.orden === (o === 'bajada' ? '' : o))));
    $('#fBajada').checked = o === 'bajada';
    if (o === 'distancia' && !estado.yo) localizar({ orden: 'distancia' });
    pintarLista();
  }
  $$('.segmentos [data-orden]').forEach((b) => b.addEventListener('click', () => fijarOrden(b.dataset.orden)));
  $('#fBajada').addEventListener('change', (e) => { fijarOrden(e.target.checked ? 'bajada' : 'precio'); marcarFiltros(); });

  // Más filtros (calidad, alertas, marca, ruta)
  function marcarFiltros() {
    $('#puntoFiltros').hidden = !(estado.calidadMin || estado.sinAlertas || estado.marca || estado.orden === 'bajada');
  }
  $('#bFiltros').addEventListener('click', () => {
    const caja = $('#masFiltros');
    caja.hidden = !caja.hidden;
    $('#bFiltros').setAttribute('aria-expanded', String(!caja.hidden));
  });

  // Lista compacta
  $('#bCompacta').addEventListener('click', () => {
    const on = !$('#lista').classList.contains('compacta');
    $$('.lista.tarjetas').forEach((l) => l.classList.toggle('compacta', on));
    $('#bCompacta').setAttribute('aria-pressed', String(on));
    guardarLocal('gm.compacta', on);
  });
  if (leer('gm.compacta', false)) $('#bCompacta').click();

  // Cerca de mí + radio
  $('#radio').value = String(estado.radio);
  $('#radio').addEventListener('change', (e) => {
    estado.radio = Number(e.target.value);
    guardarLocal('gm.radio', estado.radio);
    if (estado.cerca) { refrescar(); encuadrarRadio(); }
  });
  $('#cercaMi').addEventListener('click', () => {
    if (estado.cerca) {
      estado.cerca = false;
      $('#cercaMi').setAttribute('aria-pressed', 'false');
      refrescar();
      return;
    }
    localizar({ cerca: true });
  });
  function encuadrarRadio() {
    if (!estado.yo) return;
    if (estado.radio > 0) mapa.fitBounds(L.latLng(estado.yo.lat, estado.yo.lng).toBounds(estado.radio * 2000), { maxZoom: 14 });
    else mapa.setView([estado.yo.lat, estado.yo.lng], 11);
  }

  // Controles del mapa
  $('#zMas').addEventListener('click', () => mapa.zoomIn());
  $('#zMenos').addEventListener('click', () => mapa.zoomOut());
  $('#zYo').addEventListener('click', () => (estado.yo ? mapa.setView([estado.yo.lat, estado.yo.lng], Math.max(mapa.getZoom(), 13)) : localizar()));
  // Cuadro "Buscar en esta zona" sobre el mapa: se puede escribir una ciudad, código postal o marca.
  // Vacío (Intro o la lupa): enseña las gasolineras de lo que se ve en el mapa.
  conectarBuscador($('#qMapa'), $('#sugMapa'), 'opm', { alEnterVacio: buscarEnZona });
  $('#fZona').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const t = $('#qMapa').value.trim();
    if (!t) return buscarEnZona();
    $('#qMapa').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  function buscarEnZona() {
    estado.lugar = null;
    estado.texto = '';
    q.value = '';
    estado.cerca = false;
    $('#cercaMi').setAttribute('aria-pressed', 'false');
    cambiarPestana('buscar');
    refrescar();
    $('#qMapa').value = '';
    if (mapa.getZoom() < 9) avisar('Acerca un poco más el mapa para ver las gasolineras de la zona en la lista.', 3000);
    else avisar('Mostrando las gasolineras de esta zona', 1800);
  }
  $('#zonaYo').addEventListener('click', () => localizar());
  // Botón de capas (móvil): enseña u oculta la leyenda completa
  $('#zCapas').addEventListener('click', () => {
    const ley = $('#leyenda');
    const ver = !ley.classList.contains('abierta');
    ley.classList.toggle('abierta', ver);
    $('#leyendaMas').hidden = !ver;
    $('#zCapas').setAttribute('aria-expanded', String(ver));
  });
  $('#bLeyenda').addEventListener('click', () => {
    const mas = $('#leyendaMas');
    mas.hidden = !mas.hidden;
    $('#bLeyenda').setAttribute('aria-expanded', String(!mas.hidden));
  });
  // Lupa de la cabecera: lleva al buscador
  $('#bBuscarSup').addEventListener('click', () => {
    cambiarPestana('buscar');
    hoja('alto');
    $('#q').focus();
  });

  // En el móvil el pie legal va dentro del menú de la cuenta: se copia ahí el estado de los precios
  (() => {
    const o = $('#fuente'), d = $('#fuenteMenu');
    if (!o || !d) return;
    const copiar = () => { d.textContent = o.textContent; };
    new MutationObserver(copiar).observe(o, { childList: true, characterData: true, subtree: true });
    copiar();
  })();

  // Menú de la cuenta (avatar)
  const menuCuenta = $('#menuCuenta');
  function cerrarMenuCuenta() {
    menuCuenta.hidden = true;
    $('#bCuenta').setAttribute('aria-expanded', 'false');
  }
  function abrirMenuCuenta() {
    $('[data-menu="avisos"]', menuCuenta).hidden = !Cuenta.usuario();
    $('[data-menu="cuenta"]', menuCuenta).textContent = Cuenta.usuario() ? 'Mi cuenta' : 'Entrar o crear cuenta';
    menuCuenta.hidden = false;
    $('#bCuenta').setAttribute('aria-expanded', 'true');
    $('button, a', menuCuenta).focus();
  }
  menuCuenta.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-menu]');
    if (!b) return;
    cerrarMenuCuenta();
    if (b.dataset.menu === 'cuenta') Cuenta.abrir();
    if (b.dataset.menu === 'estadisticas') cambiarPestana('estadisticas');
    if (b.dataset.menu === 'avisos') window.GasoAvisos?.abrir();
  });
  document.addEventListener('click', (ev) => {
    if (!menuCuenta.hidden && !ev.target.closest('.cuenta-sup')) cerrarMenuCuenta();
  });
  menuCuenta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { cerrarMenuCuenta(); $('#bCuenta').focus(); }
  });

  mapa.on('moveend', () => pintarLista());

  for (const id of ['#lista', '#listaFav', '#vEstadisticas', '#vMiCoche', '#vRepostajes']) {
    const el = $(id);
    el.addEventListener('click', (ev) => {
      const f = ev.target.closest('[data-id]');
      if (f) abrirFicha(f.dataset.id);
    });
    el.addEventListener('keydown', (ev) => {
      const f = ev.target.closest('.fila');
      if (f && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        abrirFicha(f.dataset.id);
      }
    });
  }

  /* ---------- Pestañas ---------- */
  function cambiarPestana(p) {
    estado.pestana = p;
    // La ficha de una gasolinera y el panel de avisos se cierran al ir a otra sección
    if (!$('#ficha').hidden) {
      $('#ficha').hidden = true;
      const prev = estado.sel;
      estado.sel = null;
      if (prev) repintarIcono(prev);
      history.replaceState(null, '', location.pathname + location.search);
    }
    if ($('#avisosPanel') && !$('#avisosPanel').hidden) $('#avisosPanel').hidden = true;
    // Si la cuenta estaba abierta (a pantalla completa), se cierra al ir a otra sección
    if (!$('#cuentaPanel').hidden) {
      $('#cuentaPanel').hidden = true;
      document.body.classList.remove('con-cuenta');
    }
    $$('.pestanas [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.p === p)));
    $('#vBuscar').hidden = p !== 'buscar';
    $('#vFavoritas').hidden = p !== 'favoritas';
    $('#vEstadisticas').hidden = p !== 'estadisticas';
    $('#vMiCoche').hidden = p !== 'micoche';
    $('#vRepostajes').hidden = p !== 'repostajes';
    $('#vGps').hidden = p !== 'gps';
    window.GasoGPS?.alCambiar(p);
    if (p === 'favoritas') pintarFavoritas();
    if (p === 'estadisticas') pintarEstadisticas();
    if (p === 'micoche') pintarMiCoche();
    if (p === 'repostajes') pintarRepostajes();
    // Mis repostajes y Mi coche se abren como páginas completas, sin mapa
    const completa = p === 'repostajes' || p === 'micoche' || (p === 'favoritas' && esMovil());
    const antes = document.body.classList.contains('pagina-completa');
    document.body.classList.toggle('pagina-completa', completa);
    document.body.dataset.pagina = p;
    $('#tituloPagina').hidden = !(p === 'repostajes' || p === 'micoche');
    if (completa) {
      $('#tituloPagina').textContent = p === 'repostajes' ? 'Mis repostajes' : 'Mi coche';
      $('#panel').scrollTop = 0;
      $(p === 'repostajes' ? '#vRepostajes' : '#vMiCoche').scrollTop = 0;
    } else if (antes) {
      setTimeout(() => mapa.invalidateSize(), 0); // el mapa vuelve a verse: recalcula su tamaño
    }
    hoja(p === 'buscar' ? 'minimo' : p === 'gps' ? 'medio' : 'alto'); // el mapa se abre con el panel mínimo (combustible y buscador)
  }
  $$('.pestanas [role="tab"]').forEach((t) => {
    t.addEventListener('click', () => cambiarPestana(t.dataset.p));
    t.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const tabs = $$('.pestanas [role="tab"]');
      const i = (tabs.indexOf(t) + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[i].focus();
      cambiarPestana(tabs[i].dataset.p);
    });
  });

  /* ---------- Estadísticas ---------- */
  async function tendencia(provincia) {
    const k = provincia || '';
    if (!estado.tendencias.has(k)) {
      estado.tendencias.set(k, api('/api/tendencia' + (k ? '?provincia=' + encodeURIComponent(k) : '')).then((d) => d.serie).catch(() => []));
    }
    return estado.tendencias.get(k);
  }

  function cambioEn(serie, c, dias) {
    const pts = serie.filter((p) => p[c] != null);
    if (pts.length < 2) return null;
    const ult = pts[pts.length - 1];
    const ref = pts[Math.max(0, pts.length - 1 - dias)];
    return ult[c] - ref[c];
  }

  let tokenEst = 0;
  async function pintarEstadisticas() {
    const el = $('#vEstadisticas');
    if (!estado.estaciones.length) return (el.innerHTML = '<p class="vacio">Cargando…</p>');
    const c = estado.combustible;
    const token = ++tokenEst;
    const provSel = el.querySelector('#ambitoTend')?.value ?? estado.lugar?.provincia ?? '';
    const publicas = estado.estaciones.filter((e) => e.venta === 'publico' && e.precios[c] != null);

    // Provincias por precio medio
    const porProv = new Map();
    const porMarca = new Map();
    for (const e of publicas) {
      const a = porProv.get(e.provincia) || [0, 0];
      a[0] += e.precios[c]; a[1]++;
      porProv.set(e.provincia, a);
      const b = porMarca.get(e.rotulo) || [0, 0];
      b[0] += e.precios[c]; b[1]++;
      porMarca.set(e.rotulo, b);
    }
    const provincias = [...porProv].map(([p, [s, n]]) => ({ nombre: p, media: s / n, n })).sort((a, b) => a.media - b.media);
    const minMarca = publicas.length > 2000 ? 40 : 3;
    const marcas = [...porMarca]
      .filter(([, [, n]]) => n >= minMarca)
      .map(([m, [s, n]]) => ({ nombre: m, media: s / n, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 12)
      .sort((a, b) => a.media - b.media);

    const barras = (items, attr) => {
      if (!items.length) return '<p class="texto-ayuda">Sin datos.</p>';
      const lo = items[0].media, hi = items[items.length - 1].media;
      return `<ol class="barras-h">${items
        .map((it) => {
          const w = hi > lo ? 18 + (82 * (it.media - lo)) / (hi - lo) : 60;
          return `<li><button type="button" ${attr}="${esc(it.nombre)}"><span class="bn">${esc(it.nombre)}</span><span class="bb"><i style="width:${w.toFixed(1)}%"></i></span><b>${euros(it.media)}</b></button></li>`;
        })
        .join('')}</ol>`;
    };

    // Valoraciones
    const valoradas = Object.entries(estado.calidad)
      .filter(([id, q2]) => q2.total >= 3 && !q2.alerta && estado.porId.has(id))
      .sort((a, b) => b[1].puntuacion - a[1].puntuacion)
      .slice(0, 8)
      .map(([id]) => estado.porId.get(id));
    const alertas = Object.entries(estado.calidad)
      .filter(([id, q2]) => q2.alerta && estado.porId.has(id))
      .map(([id]) => estado.porId.get(id));

    const opcionesProv = ['<option value="">España</option>']
      .concat(provincias.map((p) => p.nombre).sort((a, b) => a.localeCompare(b, 'es')).map((p) => `<option value="${esc(p)}" ${p === provSel ? 'selected' : ''}>${esc(p)}</option>`))
      .join('');

    el.innerHTML = `
      <section class="bloque">
        <div class="bloque-cab"><h3>Evolución del precio medio · ${esc(NOMBRES[c])}</h3>
          <label class="sel"><span class="sr">Ámbito</span><select id="ambitoTend">${opcionesProv}</select></label></div>
        <div id="tendCaja"><p class="texto-ayuda">Cargando…</p></div>
      </section>
      <section class="bloque">
        <h3>Provincias, de más barata a más cara</h3>
        <p class="texto-ayuda">Media oficial de hoy, sin descuentos. Toca una para ver sus gasolineras.</p>
        ${barras(provincias, 'data-prov')}
      </section>
      <section class="bloque">
        <h3>Precio medio por marca</h3>
        <p class="texto-ayuda">Las ${marcas.length} marcas con más gasolineras.</p>
        ${barras(marcas, 'data-marca')}
      </section>
      <section class="bloque">
        <h3>Alertas de calidad activas</h3>
        ${alertas.length
          ? `<p class="texto-ayuda">Varios conductores han reportado el mismo problema en los últimos 7 días.</p><ol class="lista tarjetas">${alertas.map(filaHTML).join('')}</ol>`
          : '<p class="texto-ayuda">Ninguna ahora mismo.</p>'}
      </section>
      <section class="bloque">
        <h3>Mejor valoradas</h3>
        ${valoradas.length
          ? `<p class="texto-ayuda">Con al menos 3 valoraciones.</p><ol class="lista tarjetas">${valoradas.map(filaHTML).join('')}</ol>`
          : '<p class="texto-ayuda">Todavía no hay gasolineras con 3 valoraciones o más.</p>'}
      </section>`;

    el.querySelector('#ambitoTend').addEventListener('change', () => pintarEstadisticas());
    $$('[data-prov]', el).forEach((b) =>
      b.addEventListener('click', () => {
        const l = estado.lugares.find((x) => x.tipo === 'provincia' && x.nombre === b.dataset.prov);
        if (l) elegirLugar(l);
      })
    );
    $$('[data-marca]', el).forEach((b) =>
      b.addEventListener('click', () => {
        estado.marca = b.dataset.marca;
        $('#fMarca').value = estado.marca;
        cambiarPestana('buscar');
        refrescar();
      })
    );

    const serie = await tendencia(provSel);
    if (token !== tokenEst) return;
    const caja = $('#tendCaja');
    if (!caja) return;
    const puntos = serie.filter((p) => p[c] != null).map((p) => ({ x: p.dia, y: p[c] }));
    const s7 = cambioEn(serie, c, 7);
    const s30 = cambioEn(serie, c, 30);
    const chip = (v, txt) =>
      v == null ? '' : `<span class="var ${v < 0 ? 'baja' : v > 0 ? 'sube' : ''}">${v < 0 ? '▼' : v > 0 ? '▲' : '='} ${euros(Math.abs(v))} ${txt}</span>`;
    const hoy = puntos.length ? puntos[puntos.length - 1].y : null;
    caja.innerHTML = `
      <div class="cifra"><strong>${euros(hoy)}</strong><span>€/l hoy en ${esc(provSel || 'España')}</span></div>
      <div class="chips-var">${chip(s7, 'en 7 días')}${chip(s30, 'en 30 días')}</div>
      ${Graficas.linea([{ nombre: provSel || 'España', clase: 's-principal', puntos }])}`;
  }

  /* ---------- Ubicación ---------- */
  // Sin opciones: centra el mapa en ti y ordena por distancia.
  // { cerca: true }: además filtra por el radio elegido ("Cerca de mí").
  function localizar({ cerca = false, orden = 'distancia' } = {}) {
    if (!navigator.geolocation) return avisar('Tu navegador no permite obtener la ubicación.');
    avisar('Buscando tu ubicación…', 8000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        estado.yo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setTimeout(pintarConsejo, 0);
        if (marcadorYo) marcadorYo.remove();
        marcadorYo = L.marker([estado.yo.lat, estado.yo.lng], {
          icon: L.divIcon({ className: '', html: '<div class="yo"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
          interactive: false,
        }).addTo(mapa);
        estado.lugar = null;
        estado.texto = '';
        q.value = '';
        if (cerca) {
          estado.cerca = true;
          $('#cercaMi').setAttribute('aria-pressed', 'true');
        }
        cambiarPestana('buscar');
        fijarOrden(orden);
        calcularAmbito();
        pintarMapa();
        if (estado.cerca) encuadrarRadio();
        else mapa.setView([estado.yo.lat, estado.yo.lng], 13);
        $('#aviso').hidden = true;
      },
      (err) => avisar(err.code === 1 ? 'Permiso de ubicación denegado. Actívalo en el navegador para ver las cercanas.' : 'No se pudo obtener tu ubicación.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }
  $('#cerca').addEventListener('click', () => localizar());

  /* ---------- Móvil: panel inferior deslizable ----------
     Cuatro alturas: "minimo" (solo combustible y buscador), "bajo" (se ve el mapa), "medio" (mapa y lista) y
     "alto" (lista o ficha completas). Se arrastra desde el asa o se toca para cambiar. Al tocar o mover el mapa,
     el panel se encoge. */
  const panel = $('#panel');
  const asa = $('#asa');
  const esMovil = () => matchMedia('(max-width: 760px)').matches;
  const ALTURAS = ['minimo', 'bajo', 'medio', 'alto'];
  // Altura exacta de "minimo": asa + combustibles + caja de búsqueda (se mide, así vale para cualquier tamaño de pantalla)
  function medirMinimo() {
    const vb = $('#vBuscar');
    const caja = vb && $('.buscar', vb);
    if (!caja || vb.hidden) return 0;
    return Math.ceil(caja.getBoundingClientRect().bottom + vb.scrollTop - panel.getBoundingClientRect().top) + 10;
  }
  function hoja(e) {
    if (!esMovil()) return;
    // "minimo" solo existe en el mapa y sin ficha abierta; en otras vistas se queda en "bajo"
    if (e === 'minimo') {
      const alto = document.body.dataset.pagina === 'buscar' || !document.body.dataset.pagina ? medirMinimo() : 0;
      if (!alto || !ficha.hidden) e = 'bajo';
      else {
        panel.style.setProperty('--alto-minimo', alto + 'px');
        $('#vBuscar').scrollTop = 0;
      }
    }
    if (panel.dataset.hoja === e) return;
    panel.dataset.hoja = e;
    asa.setAttribute('aria-label', e === 'alto' ? 'Reducir el panel' : 'Ampliar el panel');
    setTimeout(() => mapa.invalidateSize(), 300);
  }
  window.GasoHoja = hoja; // para cuenta.js y avisos.js
  // Compatibilidad con el resto del código: 'mapa' baja el panel, 'ficha' lo sube del todo
  function irA(v) {
    hoja(v === 'mapa' ? 'bajo' : v === 'ficha' ? 'alto' : panel.dataset.hoja === 'bajo' ? 'medio' : panel.dataset.hoja);
  }
  (() => {
    let inicioY = 0, inicioH = 0, movido = false, activo = false;
    const alturaDe = (e) => {
      const max = window.innerHeight - 56 - 60;
      return e === 'minimo' ? medirMinimo() || 150 : e === 'bajo' ? 168 : e === 'medio' ? window.innerHeight * 0.52 : max;
    };
    asa.addEventListener('pointerdown', (ev) => {
      if (!esMovil()) return;
      activo = true;
      movido = false;
      inicioY = ev.clientY;
      inicioH = panel.getBoundingClientRect().height;
      panel.classList.add('arrastrando');
      asa.setPointerCapture(ev.pointerId);
    });
    asa.addEventListener('pointermove', (ev) => {
      if (!activo) return;
      const d = inicioY - ev.clientY;
      if (Math.abs(d) > 6) movido = true;
      const h = Math.max(alturaDe('minimo'), Math.min(alturaDe('alto'), inicioH + d));
      panel.style.setProperty('--alto-hoja', h + 'px');
    });
    const soltar = (ev) => {
      if (!activo) return;
      activo = false;
      panel.classList.remove('arrastrando');
      const h = panel.getBoundingClientRect().height;
      panel.style.removeProperty('--alto-hoja');
      if (!movido) {
        // Toque: sube un nivel; desde arriba, vuelve a "bajo"
        const i = ALTURAS.indexOf(panel.dataset.hoja);
        return hoja(i >= ALTURAS.length - 1 ? 'bajo' : ALTURAS[i + 1]);
      }
      // Arrastre: la altura más cercana, favoreciendo la dirección del gesto
      const sube = ev.clientY < inicioY;
      const cerca = ALTURAS.map((e) => ({ e, d: Math.abs(alturaDe(e) - h) })).sort((a, b) => a.d - b.d)[0].e;
      const i = ALTURAS.indexOf(cerca);
      const actual = ALTURAS.indexOf(panel.dataset.hoja);
      hoja(i === actual ? ALTURAS[Math.max(0, Math.min(ALTURAS.length - 1, actual + (sube ? 1 : -1)))] : cerca);
    };
    asa.addEventListener('pointerup', soltar);
    asa.addEventListener('pointercancel', soltar);
    asa.addEventListener('keydown', (ev) => {
      const i = ALTURAS.indexOf(panel.dataset.hoja);
      if (ev.key === 'ArrowUp') hoja(ALTURAS[Math.min(ALTURAS.length - 1, i + 1)]);
      else if (ev.key === 'ArrowDown') hoja(ALTURAS[Math.max(0, i - 1)]);
      else if (ev.key === 'Enter' || ev.key === ' ') hoja(i >= ALTURAS.length - 1 ? 'bajo' : ALTURAS[i + 1]);
      else return;
      ev.preventDefault();
    });
    // Al tocar o mover el mapa, el panel se encoge (con una ficha abierta queda la tarjeta compacta)
    const plegar = () => {
      if (document.activeElement === $('#q')) $('#q').blur();
      hoja('minimo');
    };
    mapa.on('click', plegar);
    mapa.on('dragstart', plegar);
    $('#q').addEventListener('focus', () => hoja('alto'));
  })();

  // Arranque: el panel empieza en "minimo"; se fija su altura real cuando ya hay diseño y tipografías
  function ajustarMinimo() {
    if (!esMovil() || panel.dataset.hoja !== 'minimo') return;
    const a = medirMinimo();
    if (a) panel.style.setProperty('--alto-minimo', a + 'px');
  }
  requestAnimationFrame(ajustarMinimo);
  window.addEventListener('load', ajustarMinimo);
  window.addEventListener('resize', ajustarMinimo);
  document.fonts?.ready.then(ajustarMinimo);

  /* ---------- Móvil: teclado abierto ----------
     Con el teclado, el área visible (visualViewport) es más pequeña que la ventana. La hoja y las pestañas se
     colocaban según la ventana entera y la interfaz se descuadraba. Mientras se escribe en un campo del panel,
     el panel ocupa exactamente el área visible y se ocultan las pestañas (CSS: body.teclado). */
  (() => {
    const vv = window.visualViewport;
    const raiz = document.documentElement;
    const CAMPO = 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=button]):not([type=submit]), textarea';
    let enCampo = false;
    let raf = 0;
    const aplicar = () => {
      raf = 0;
      const activo = enCampo && esMovil();
      document.body.classList.toggle('teclado', activo);
      if (!activo) {
        raiz.style.removeProperty('--vv-alto');
        raiz.style.removeProperty('--vv-top');
        return;
      }
      raiz.style.setProperty('--vv-alto', (vv ? vv.height : window.innerHeight) + 'px');
      raiz.style.setProperty('--vv-top', (vv ? vv.offsetTop : 0) + 'px');
      // iOS desplaza la página para enseñar el campo: se devuelve a su sitio (el panel ya sigue al área visible)
      if (window.scrollY || document.scrollingElement?.scrollTop) window.scrollTo(0, 0);
    };
    const pedir = () => { if (!raf) raf = requestAnimationFrame(aplicar); };
    vv?.addEventListener('resize', pedir);
    vv?.addEventListener('scroll', pedir);
    panel.addEventListener('focusin', (ev) => {
      if (!ev.target.matches?.(CAMPO)) return;
      enCampo = true;
      if (ev.target.id === 'q') $('#vBuscar').scrollTop = 0; // que el buscador quede a la vista
      pedir();
    });
    panel.addEventListener('focusout', () => {
      // si el foco pasa a otro campo del panel, focusin lo volverá a activar
      setTimeout(() => {
        enCampo = Boolean(document.activeElement?.matches?.(CAMPO) && panel.contains(document.activeElement));
        pedir();
        if (!enCampo) setTimeout(() => window.scrollTo(0, 0), 60); // iOS deja la página desplazada al cerrar el teclado
      }, 60);
    });
    // Al desplazar la lista con el dedo, se baja el teclado (así se ve la lista entera, como en las apps de mapas)
    $('#vBuscar').addEventListener('touchmove', () => {
      if (enCampo && document.activeElement?.matches?.(CAMPO) && !$('#sugerencias').matches(':hover')) document.activeElement.blur();
    }, { passive: true });
    window.addEventListener('orientationchange', pedir);
  })();
  // Tras elegir un lugar o buscar, se cierra el teclado: la lista y el mapa quedan visibles
  const cerrarTeclado = () => {
    if (!esMovil()) return;
    const a = document.activeElement;
    if (a && a.matches?.('input, textarea') && panel.contains(a)) a.blur();
    if (document.activeElement === $('#qMapa')) $('#qMapa').blur();
  };

  /* ---------- Favoritas ---------- */
  // Favoritas, coches, descuentos y repostajes son de una cuenta: sin sesión no se guardan
  const conSesion = () => Boolean(window.Cuenta?.usuario());
  function pedirCuenta(para) {
    avisar(`Entra o crea una cuenta gratis para ${para}.`, 3500);
    Cuenta.abrir('entrar');
  }
  // Pantalla para las secciones personales cuando no hay sesión
  function sinSesionHTML(titulo, texto) {
    return `<div class="sin-sesion">
      <img src="img/favoritos-vacio.jpg" alt="" width="486" height="310">
      <h3>${titulo}</h3>
      <p>${texto}</p>
      <div class="acciones-sin-sesion">
        <button type="button" class="boton primario boton-grande" data-cuenta="entrar">Entrar</button>
        <button type="button" class="boton boton-grande" data-cuenta="registro">Crear cuenta gratis</button>
      </div>
    </div>`;
  }
  function activarSinSesion(el) {
    $$('[data-cuenta]', el).forEach((b) => b.addEventListener('click', () => Cuenta.abrir(b.dataset.cuenta)));
  }

  function alternarFavorita(id) {
    if (!conSesion()) {
      pedirCuenta('guardar tus gasolineras favoritas');
      return false;
    }
    if (estado.favoritas.has(id)) estado.favoritas.delete(id);
    else estado.favoritas.add(id);
    guardarLocal('gm.favoritas', [...estado.favoritas]);
    repintarIcono(id);
    pintarFavoritas();
    pintarLista();
    return estado.favoritas.has(id);
  }

  /* ---------- Ficha de gasolinera ---------- */
  const ficha = $('#ficha');
  const ESTRELLA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';
  const TEXTO_NOTA = ['', 'Muy mala', 'Mala', 'Normal', 'Muy buena', 'Excelente'];
  let problemas = {};
  let servicios = {};
  const problemasListos = api('/api/problemas')
    .then((d) => {
      problemas = d.problemas || {};
      servicios = d.servicios || {};
      estado.soloRegistrados = Boolean(d.soloRegistrados);
    })
    .catch(() => {});

  function cerrarFicha() {
    ficha.hidden = true;
    hoja('medio');
    const prev = estado.sel;
    estado.sel = null;
    if (prev) repintarIcono(prev);
    history.replaceState(null, '', location.pathname + location.search);
    if (prev) $(`.fila[data-id="${CSS.escape(prev)}"]`)?.focus();
  }

  function abrirDesdeHash() {
    const m = location.hash.match(/^#e(\w+)$/);
    if (m && estado.porId.has(m[1])) abrirFicha(m[1]);
  }

  function mediaZona(e) {
    const c = estado.combustible;
    let s = 0, n = 0;
    for (const o of estado.estaciones) {
      if (o.id === e.id || o.venta !== 'publico' || base(o, c) == null) continue;
      if (Math.abs(o.lat - e.lat) > 0.12 || Math.abs(o.lng - e.lng) > 0.16) continue; // descarte rápido
      if (distanciaKm(e, o) <= RADIO_ZONA_KM) { s += precio(o, c); n++; }
    }
    return n ? { media: s / n, n } : null;
  }

  // Móvil: centra la gasolinera en la parte del mapa que no tapa la hoja inferior
  function centrarEnVisible(e) {
    if (!esMovil() || !e) return;
    setTimeout(() => {
      mapa.invalidateSize();
      const caja = mapa.getContainer().getBoundingClientRect();
      const alto = Math.max(60, panel.getBoundingClientRect().top - caja.top);
      const p = mapa.latLngToContainerPoint([e.lat, e.lng]);
      mapa.panBy([p.x - caja.width / 2, p.y - alto / 2], { animate: true });
    }, 320);
  }

  async function abrirFicha(id, { sinMover = false } = {}) {
    const e = estado.porId.get(id);
    if (!e) return;
    // Desde una página completa (repostajes, mi coche) se vuelve al mapa para ver la gasolinera
    if (document.body.classList.contains('pagina-completa')) cambiarPestana('buscar');
    const prev = estado.sel;
    estado.sel = id;
    if (prev && prev !== id) repintarIcono(prev);
    repintarIcono(id);
    const m = marcadores.get(id);
    if (!sinMover) {
      if (m) grupo.zoomToShowLayer(m, () => {});
      else mapa.setView([e.lat, e.lng], Math.max(mapa.getZoom(), 15));
    }
    history.replaceState(null, '', '#e' + id);
    // Si la ficha estaba plegada (viendo el mapa), la nueva gasolinera también se queda plegada y centrada
    const plegada = esMovil() && !ficha.hidden && panel.dataset.hoja === 'bajo';
    if (plegada) centrarEnVisible(e);
    else irA('ficha');
    estado.recientes = [id, ...estado.recientes.filter((x) => x !== id)].slice(0, 12);
    guardarLocal('gm.recientes', estado.recientes);

    const c = estado.combustible;
    const dtoActual = ahorroDe(e, c);
    // Precios por litro: una fila por combustible; la del combustible elegido, destacada
    const COLOR_COMB = { gasoleoA: '#f5b62a', gasoleoPremium: '#f59e0b', gasolina95: '#3ddc7e', gasolina98: '#22c55e', glp: '#22d3ee' };
    const filasPrecio = Object.keys(NOMBRES)
      .map((k) => {
        const of = base(e, k);
        const v = variacion(id, k);
        const icono = `<span class="ico-comb" style="--cc:${COLOR_COMB[k] || '#8f9db5'}" aria-hidden="true"><svg><use href="#i-surtidor"/></svg></span>`;
        if (of == null) {
          return `<li class="sin"><button type="button" data-comb="${k}" disabled>${icono}<span class="pc-nom">${NOMBRES[k]}</span><span class="pc-precio">— <small>€/l</small></span><span class="pc-flecha" aria-hidden="true">–</span></button></li>`;
        }
        const d = ahorroDe(e, k);
        const dec = declarado(e, k);
        const solo = soloDeclarado(e, k);
        const grande = d && conDescuento() ? of - d.ahorro : of;
        const lineas = [];
        const quien = dec?.usuarios ? `Según ${dec.usuarios} usuarios` : 'Declarado por la gasolinera';
        if (solo) lineas.push(`<b class="t-decl${dec.usuarios ? ' usuarios' : ''}">${quien} · ${hace(dec.fecha)} · sin dato del Ministerio</b>`);
        if (d) lineas.push(`<b class="t-alt">${conDescuento() ? `${solo ? 'sin descuento' : 'oficial'} ${euros(of)}` : `con tu descuento ${euros(of - d.ahorro)}`}</b>`);
        if (dec && !solo) {
          lineas.push(
            dec.usuarios
              ? `<b class="t-decl usuarios">${dec.usuarios} usuarios indican ${euros(dec.precio)} € · ${hace(dec.fecha)}</b>`
              : Math.abs(dec.precio - of) < 0.0005
                ? `<b class="t-decl">La gasolinera confirma este precio · ${hace(dec.fecha)}</b>`
                : `<b class="t-decl">La gasolinera declara ${euros(dec.precio)} € · ${hace(dec.fecha)}</b>`
          );
        }
        if (v) lineas.push(`<b class="t-var ${v < 0 ? 'baja' : 'sube'}">${v < 0 ? '▼' : '▲'} ${euros(Math.abs(v))} en 7 días</b>`);
        return `<li class="${k === c ? 'activo' : ''}"><button type="button" data-comb="${k}" aria-pressed="${k === c}" title="Ver los precios de ${NOMBRES[k]}">${icono}<span class="pc-nom">${NOMBRES[k]}${lineas.length ? `<span class="pc-lineas">${lineas.join('')}</span>` : ''}</span><span class="pc-precio">${euros(grande)} <small>€/l</small></span><span class="pc-flecha" aria-hidden="true">›</span></button></li>`;
      })
      .join('');
    const destino = `https://www.google.com/maps/dir/?api=1&destination=${e.lat},${e.lng}`;
    const al = alertaDe(id);
    const fav = estado.favoritas.has(id);
    const hor = horarioDe(e);
    const ex = estado.extras[id] || {};
    const serviciosTxt = (ex.s || []).map((k) => ({ tienda: 'Tienda', lavado: 'Lavado', cafeteria: 'Cafetería', adblue: 'AdBlue', aseos: 'Aseos', cargador_ev: 'Cargador eléctrico', pago_movil: 'Pago con el móvil', aire_agua: 'Aire y agua', atendida: 'Atendida', autoservicio: 'Autoservicio' }[k])).filter(Boolean);
    // "Actualizado: hoy 13:24" con la fecha de los datos del Ministerio (dd/mm/aaaa hh:mm:ss)
    const actualizado = (() => {
      const m = String(estado.fechaDatos || '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
      if (!m) return '';
      const hoy = hoyISO();
      const dia = `${m[3]}-${m[2]}-${m[1]}`;
      return `${dia === hoy ? 'hoy' : `${m[1]}/${m[2]}`} ${m[4].padStart(2, '0')}:${m[5]}`;
    })();
    const svg = (d, cls = '') => `<svg class="ico-acc ${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
    const SVG_IR = svg('<path d="M3 11l18-8-8 18-2-8z"/>');
    const SVG_FAV = svg('<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>', 'ico-fav');
    const SVG_COMP = svg('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>');
    const SVG_REP = svg('<path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M3 21h13M6.5 7h6v4h-6zM15 9h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3"/>', 'ico-rojo');
    const SVG_AV = svg('<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>', 'ico-amarillo');
    const INFO = (t) => `<span class="info-i" tabindex="0" role="img" aria-label="${esc(t)}" title="${esc(t)}">i</span>`;

    ficha.innerHTML = `
      <div class="ficha-cab ficha-cab2">
        <button class="volver" type="button" id="volver">← Volver</button>
        <div class="ficha-tit">
          <div class="tit-linea"><h2 id="fichaTitulo">${esc(e.rotulo)}</h2>${hor ? `<span class="pill-estado ${hor.abierta ? 'abierta' : 'cerrada'}">${hor.abierta ? (/24 h/.test(hor.texto) ? 'Abierta 24 h' : 'Abierta') : 'Cerrada'}</span>` : ''}</div>
          <p>${esc(e.direccion)}<br>${esc(e.cp)} ${esc(e.localidad)}, ${esc(e.provincia)}</p>
          <button type="button" class="ver-mapa-mov" id="bVerMapa" aria-label="Ocultar la ficha para ver la gasolinera en el mapa o volver a mostrarla"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5zM9 4v13.5M15 6.5V20"/></svg><span class="vm-map">Ver en el mapa</span><span class="vm-det">Ver detalles</span></button>
        </div>
        <img class="ficha-foto" src="img/gasolinera.jpg" alt="" width="360" height="260">
        <div class="fp-mini" aria-hidden="true">${base(e, c) != null ? euros(precio(e, c)) : '—'}<small>€/litro</small></div>
      </div>
      <div class="ficha-cuerpo">
        ${al ? `<div class="banner-alerta" role="alert"><b>⚠ Alerta de calidad</b>${al.n} conductores distintos han reportado “${esc(al.texto)}” en los últimos 7 días.</div>` : ''}
        <div class="acciones-ficha">
          <a class="boton primario" href="${destino}" target="_blank" rel="noopener">${SVG_IR}Cómo llegar</a>
          <button class="boton" type="button" id="bFav" aria-pressed="${fav}">${SVG_FAV}<span>${fav ? 'Guardada' : 'Guardar'}</span></button>
          <button class="boton" type="button" id="bCompartir">${SVG_COMP}Compartir</button>
          <button class="boton doble" type="button" id="bRepostar">${SVG_REP}Apuntar repostaje</button>
          ${base(e, c) != null ? `<button class="boton doble" type="button" id="bAlerta">${SVG_AV}Avisarme si baja</button>` : ''}
        </div>
        <div id="extraCaja"></div>
        <section class="tarjeta-ficha" aria-labelledby="tPrecios">
          <div class="tf-cab"><h3 id="tPrecios">Precios por litro${conDescuento() && dtoActual ? ' · con tus descuentos' : ''}</h3>${actualizado ? `<span class="tf-nota">Actualizado: ${actualizado} ${INFO('Precios oficiales del Ministerio para la Transición Ecológica. Se actualizan cada 30 minutos.')}</span>` : ''}</div>
          <ul class="lista-precios">${filasPrecio}</ul>
          ${Object.keys(ex.d || {}).length ? `<p class="texto-ayuda fuente-precios">Los precios “declarados” los publica la propia gasolinera. Si ${CONSENSO} usuarios con cuenta coinciden en que el precio real es otro, se muestra el suyo en su lugar.</p>` : ''}
          <div id="alertaCaja"></div>
          ${Object.keys(ex.d || {}).length ? '<div id="correccionCaja"><button type="button" class="enlace" id="bCorregir">¿El precio de la gasolinera no es el que viste?</button></div>' : ''}
        </section>
        <section class="tarjeta-ficha" aria-labelledby="tInfo">
          <h3 id="tInfo">Información del establecimiento</h3>
          <div class="info-est">
            <div><span class="info-ico">${svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>')}</span><span><b class="${hor ? (hor.abierta ? 'ok' : 'ko') : ''}">${hor ? esc(hor.abierta ? (/24 h/.test(hor.texto) ? 'Abierta 24 h' : hor.texto) : hor.texto) : 'Horario no indicado'}</b><small>${esc(e.horario || '')}</small></span></div>
            <div><span class="info-ico">${svg('<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>')}</span><span><b>${serviciosTxt.length ? esc(serviciosTxt.slice(0, 3).join(' · ')) : 'Venta al público'}</b><small>${estado.yo ? `A ${num1(distanciaKm(estado.yo, e))} km de ti` : ex.v ? 'Gasolinera verificada' : 'Datos del Ministerio'}</small></span></div>
          </div>
          ${dtoActual ? `<p class="texto-ayuda">Tu descuento: ${esc(MiCoche.textoRegla(dtoActual.regla))} → −${euros(dtoActual.ahorro)} €/l</p>` : ''}
        </section>
        ${base(e, c) != null ? calculadoraHTML(INFO) : ''}
        <section class="tarjeta-ficha experiencia" aria-labelledby="tExp"><h3 id="tExp">Tu experiencia ${INFO('Valora el combustible si has repostado aquí. Las opiniones con ticket cuentan más.')}</h3><div id="formCaja"></div></section>
        <section class="tarjeta-ficha" id="calidadSec" aria-live="polite"><h3>Calidad del combustible</h3><p class="texto-ayuda">Cargando valoraciones…</p></section>
        <section class="tarjeta-ficha"><h3>Evolución · ${esc(NOMBRES[c])}</h3><div id="histCaja"><p class="texto-ayuda">Cargando historial…</p></div></section>
        <section id="opinionesSec"></section>
      </div>`;
    ficha.hidden = false;
    ficha.scrollTop = 0;
    $('#volver').addEventListener('click', cerrarFicha);
    $('#volver').focus({ preventScroll: true });
    // Móvil: plegar la ficha para ver la gasolinera en el mapa (como en el ordenador) y desplegarla de nuevo
    $('#bVerMapa').addEventListener('click', () => {
      if (panel.dataset.hoja === 'bajo') hoja('alto');
      else {
        hoja('bajo');
        centrarEnVisible(e);
      }
    });
    $('#bFav').addEventListener('click', (ev) => {
      if (!conSesion()) return pedirCuenta('guardar tus gasolineras favoritas');
      const ahora = alternarFavorita(id);
      $('span', ev.currentTarget).textContent = ahora ? 'Guardada' : 'Guardar';
      ev.currentTarget.setAttribute('aria-pressed', String(ahora));
      avisar(ahora ? 'Guardada en favoritas' : 'Quitada de favoritas', 2000);
    });
    $('#bCompartir').addEventListener('click', () => compartir(e));
    $$('.lista-precios [data-comb]:not([disabled])', ficha).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.comb !== estado.combustible) $(`.combustibles [data-c="${b.dataset.comb}"]`)?.click();
    }));
    $('#bCorregir')?.addEventListener('click', () => formularioCorreccion(e));
    $('#bAlerta')?.addEventListener('click', () => {
      window.GasoAvisos?.formularioAlerta($('#alertaCaja'), id, c, precio(e, c));
      $('#alertaCaja').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    $('#bRepostar').addEventListener('click', () => {
      if (!conSesion()) return pedirCuenta('apuntar tus repostajes');
      cerrarFicha();
      prepararRepostaje(e);
    });
    if (base(e, c) != null) activarCalculadora(e);

    await problemasListos;
    if (estado.sel !== id) return;
    $('#formCaja').innerHTML = formulario(e);
    activarFormulario(e);
    cargarReportes(id);
    cargarHistorial(e);
    cargarExtra(id);
  }

  // Información que añade la propia gasolinera (si está verificada)
  async function cargarExtra(id) {
    try {
      const f = await api(`/api/estaciones/${encodeURIComponent(id)}/ficha`);
      if (estado.sel !== id) return;
      const partes = [];
      if (f.verificada) partes.push('<p class="sello-verif">✓ Gasolinera verificada · la gestiona su propietario</p>');
      if (f.promocion) partes.push(`<div class="promo"><b>Promoción</b>${esc(f.promocion.texto)}<small>Hasta el ${new Date(f.promocion.hasta + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}</small></div>`);
      if (f.descripcion) partes.push(`<p class="desc-gas">${esc(f.descripcion)}</p>`);
      if (f.servicios.length) partes.push(`<ul class="servicios">${f.servicios.map((s) => `<li>${esc(servicios[s] || s)}</li>`).join('')}</ul>`);
      const contacto = [];
      if (f.telefono) contacto.push(`<a href="tel:${esc(f.telefono.replace(/\s/g, ''))}">${esc(f.telefono)}</a>`);
      if (f.web) contacto.push(`<a href="${esc(f.web)}" target="_blank" rel="noopener nofollow">${esc(f.web.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`);
      if (contacto.length) partes.push(`<p class="contacto-gas">${contacto.join(' · ')}</p>`);
      $('#extraCaja').innerHTML = partes.length ? `<section class="extra-gas">${partes.join('')}</section>` : '';
    } catch {
      /* sin información extra */
    }
  }

  // Un usuario indica el precio real que vio. Con varios que coinciden, sustituye al de la gasolinera.
  function formularioCorreccion(e) {
    const caja = $('#correccionCaja');
    const u = Cuenta.usuario();
    if (!u) {
      caja.innerHTML = '<div class="aviso-cuenta"><p>Para corregir un precio necesitas una cuenta con el correo confirmado. Así evitamos cambios falsos.</p><button type="button" class="boton primario" id="bEntrarCorr">Entrar o crear cuenta</button></div>';
      $('#bEntrarCorr').addEventListener('click', () => Cuenta.abrir());
      return;
    }
    if (u.rol !== 'usuario') {
      caja.innerHTML = '<p class="texto-ayuda">Las cuentas de gasolinera no pueden corregir precios.</p>';
      return;
    }
    const conPrecio = Object.keys(estado.extras[e.id]?.d || {});
    caja.innerHTML = `<form class="form-correccion" novalidate>
      <p><b>¿Qué precio había en el surtidor?</b> Si ${CONSENSO} usuarios coincidís, vuestro precio sustituye al que publica la gasolinera.</p>
      <div class="fila-corr">
        <label for="corrComb">Combustible<select id="corrComb">${conPrecio.map((k) => `<option value="${k}" ${k === estado.combustible ? 'selected' : ''}>${NOMBRES[k] || k}</option>`).join('')}</select></label>
        <label for="corrPrecio">Precio (€/l)<input id="corrPrecio" inputmode="decimal" placeholder="1,459" autocomplete="off"></label>
      </div>
      <p class="error" hidden></p>
      <div class="acciones"><button class="boton primario" type="submit">Enviar precio</button><button class="boton" type="button" id="corrCancelar">Cancelar</button></div>
    </form>`;
    $('#corrCancelar').addEventListener('click', () => {
      caja.innerHTML = '<button type="button" class="enlace" id="bCorregir">¿El precio de la gasolinera no es el que viste?</button>';
      $('#bCorregir').addEventListener('click', () => formularioCorreccion(e));
    });
    $('#corrPrecio').focus();
    $('form', caja).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('.error', caja);
      try {
        const r = await enviarCorreccion(e, $('#corrComb').value, $('#corrPrecio').value);
        caja.innerHTML = `<p class="ok-cuenta">${r.aplicada ? `Precio actualizado: ya sois ${r.coinciden} usuarios con el mismo precio.` : `Gracias. Hace${r.faltan === 1 ? '' : 'n'} falta${r.faltan === 1 ? '' : 'n'} ${r.faltan} usuario${r.faltan === 1 ? '' : 's'} más que coincida${r.faltan === 1 ? '' : 'n'} para cambiarlo.`}</p>`;
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
      }
    });
  }

  async function enviarCorreccion(e, combustible, precioTxt) {
    const r = await api(`/api/estaciones/${encodeURIComponent(e.id)}/precios/correccion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ combustible, precio: String(precioTxt).trim().replace(',', '.') }),
    });
    if (r.aplicada) {
      aplicarPreciosDeclarados(e.id, r.precios);
      repintarIcono(e.id);
      pintarLista();
      setTimeout(() => estado.sel === e.id && abrirFicha(e.id, { sinMover: true }), 1500);
    }
    return r;
  }

  async function compartir(e) {
    const url = location.href.split('#')[0] + '#e' + e.id;
    const texto = `${e.rotulo} (${e.localidad}): ${NOMBRES[estado.combustible]} a ${euros(e.precios[estado.combustible])} €/l`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'GasoCheck', text: texto, url });
        return;
      }
      await navigator.clipboard.writeText(`${texto} ${url}`);
      avisar('Enlace copiado');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      avisar('No se pudo compartir. Copia el enlace de la barra de direcciones.');
    }
  }

  /* Calculadora: ¿cuánto cuesta llenar y compensa ir hasta aquí? */
  function calculadoraHTML(INFO = () => '') {
    return `<section class="tarjeta-ficha calc"><h3>Calculadora de ahorro ${INFO('Compara lo que pagarías aquí con el precio medio de las gasolineras a menos de ' + RADIO_ZONA_KM + ' km.')}</h3>
      <div class="calc-campos">
        <label for="cLitros">Litros a repostar<input id="cLitros" type="number" inputmode="decimal" min="1" max="200" step="1" value="${estado.ajustes.litros}"></label>
        <label for="cConsumo">Consumo (l/100 km)<input id="cConsumo" type="number" inputmode="decimal" min="2" max="30" step="0.1" value="${estado.ajustes.consumo}"></label>
      </div>
      <div id="calcRes" class="calc-res" aria-live="polite"></div></section>`;
  }

  function activarCalculadora(e) {
    const zona = mediaZona(e);
    const pintar = () => {
      const litros = Math.max(0, parseFloat(String($('#cLitros').value).replace(',', '.')) || 0);
      const consumo = Math.max(0, parseFloat(String($('#cConsumo').value).replace(',', '.')) || 0);
      // Solo se guardan los litros y el consumo, y solo si cambian (antes se borraba el resto de ajustes, como los coches)
      if (litros > 0 && consumo > 0 && (litros !== estado.ajustes.litros || consumo !== estado.ajustes.consumo)) {
        estado.ajustes = { ...estado.ajustes, litros, consumo };
        guardarLocal('gm.ajustes', estado.ajustes);
      }
      const p = precio(e);
      const total = litros * p;
      const lt = litros.toLocaleString('es-ES');
      const gasto = `<div class="calc-tile"><span>Gasto en esta gasolinera</span><strong>${euros(total, 2)} €</strong><small>para ${lt} litros${conDescuento() && ahorroDe(e) ? ' con tu descuento' : ''}</small></div>`;
      let html = '';
      if (zona) {
        const dif = (zona.media - p) * litros;
        const MONEDAS = '<svg class="monedas" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="9" cy="6" rx="6" ry="2.5"/><path d="M3 6v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6M3 10v4c0 1.4 2.7 2.5 6 2.5"/><ellipse cx="15" cy="14" rx="6" ry="2.5"/><path d="M9 14v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4"/></svg>';
        const tile = Math.abs(dif) < 0.005
          ? `<div class="calc-tile"><span>Frente a la zona</span><strong>Igual</strong><small>que el precio medio (${zona.n} gasolineras)</small></div>`
          : dif > 0
            ? `<div class="calc-tile ahorro"><span>Te ahorras</span><strong>${euros(dif, 2)} €</strong><small>vs. precio medio de la zona</small>${MONEDAS}</div>`
            : `<div class="calc-tile caro"><span>Pagas de más</span><strong>${euros(-dif, 2)} €</strong><small>vs. precio medio de la zona</small></div>`;
        html = `<div class="calc-tiles">${gasto}${tile}</div><p class="texto-ayuda">Media de ${zona.n} gasolineras a menos de ${RADIO_ZONA_KM} km: ${euros(zona.media)} €/l.</p>`;
        if (estado.yo) {
          const km = distanciaKm(estado.yo, e) * FACTOR_CARRETERA * 2;
          const coste = (km * consumo * p) / 100;
          const neto = dif - coste;
          html += `<p>Ir y volver desde tu ubicación son unos ${Math.round(km)} km (≈ ${euros(coste, 2)} € de combustible). ${
            neto > 0 ? `<b class="ok">Compensa: ahorro neto ${euros(neto, 2)} €</b>` : `<b class="ko">No compensa: pierdes ${euros(-neto, 2)} €</b>`
          }</p>`;
        } else {
          html += '<p class="texto-ayuda">Pulsa el botón de ubicación para saber si compensa el desplazamiento.</p>';
        }
      } else {
        html = `<div class="calc-tiles">${gasto}</div>`;
      }
      $('#calcRes').innerHTML = html;
    };
    $('#cLitros').addEventListener('input', pintar);
    $('#cConsumo').addEventListener('input', pintar);
    pintar();
  }

  async function cargarHistorial(e) {
    const caja = $('#histCaja');
    const c = estado.combustible;
    try {
      const [{ serie }, nac] = await Promise.all([api(`/api/estaciones/${encodeURIComponent(e.id)}/historico`), tendencia(e.provincia)]);
      if (estado.sel !== e.id) return;
      const propia = serie.filter((p) => p[c] != null).map((p) => ({ x: p.dia, y: p[c] }));
      const desde = propia.length ? propia[0].x : '';
      const prov = nac.filter((p) => p[c] != null && p.dia >= desde).map((p) => ({ x: p.dia, y: p[c] }));
      if (propia.length < 2) {
        caja.innerHTML = '<p class="texto-ayuda">Aún no hay historial suficiente. El servidor guarda un precio al día; en unos días verás aquí la gráfica.</p>';
        return;
      }
      const min = Math.min(...propia.map((p) => p.y));
      const max = Math.max(...propia.map((p) => p.y));
      caja.innerHTML =
        Graficas.linea([
          { nombre: 'Esta gasolinera', clase: 's-principal', puntos: propia },
          { nombre: `Media de ${e.provincia}`, clase: 's-referencia', puntos: prov },
        ]) + `<p class="texto-ayuda">En los últimos ${propia.length} días: mínimo ${euros(min)} €, máximo ${euros(max)} €.</p>`;
    } catch {
      caja.innerHTML = '<p class="texto-ayuda">No se pudo cargar el historial.</p>';
    }
  }

  function formulario(e) {
    const u = window.Cuenta ? Cuenta.usuario() : null;
    if (u && u.rol === 'proveedor') return '<p class="texto-ayuda">Las cuentas de gasolinera no pueden valorar. Para opinar como cliente, usa una cuenta personal.</p>';
    if (!u && estado.soloRegistrados) return '<div class="aviso-cuenta"><p>Para valorar gasolineras necesitas una cuenta.</p><button type="button" class="boton primario" data-abrir-cuenta>Entrar o crear cuenta</button></div>';
    const como = u
      ? `<p class="texto-ayuda">Valoras como <b>${esc(u.alias)}</b>${u.verificado ? '' : ' (confirma tu correo para que se vea la marca de verificado)'}.</p>`
      : '<p class="texto-ayuda">Valoras de forma anónima. <button type="button" class="enlace" data-abrir-cuenta>Entra</button> para que tu opinión aparezca con tu nombre y cuente como verificada.</p>';
    const estrellas = [1, 2, 3, 4, 5]
      .map((n) => `<input type="radio" name="puntuacion" id="p${n}" value="${n}"><label for="p${n}" title="${n} de 5">${ESTRELLA}<span class="sr">${n} de 5</span></label>`)
      .join('');
    const chips = Object.entries(problemas)
      .map(([k, t]) => `<label><input type="checkbox" name="problemas" value="${k}"><span>${esc(t)}</span></label>`)
      .join('');
    const combs = Object.keys(NOMBRES)
      .filter((k) => base(e, k) != null)
      .map((k) => `<option value="${k}" ${k === estado.combustible ? 'selected' : ''}>${NOMBRES[k]}</option>`)
      .join('');
    return `<form class="reporte reporte2" id="formReporte" novalidate>
      <div class="fila-estrellas">
        <fieldset class="estrellas"><legend>¿Qué tal fue el combustible?</legend>${estrellas}</fieldset>
        <span class="nota-texto" id="textoNota" aria-live="polite">Toca para puntuar</span>
      </div>
      <label class="campo campo-linea" for="rCombustible"><span>Combustible que repostaste</span>
        <select id="rCombustible" name="combustible">${combs}</select>
      </label>
      ${chips ? `<fieldset class="chips"><legend>¿Notaste algún problema? (opcional)</legend>${chips}</fieldset>` : ''}
      ${Object.keys(estado.extras[e.id]?.d || {}).length && u && u.rol === 'usuario' ? `<label class="campo" for="rPrecioReal" id="rPrecioCaja" hidden>¿Qué precio había? (€/l, opcional)<input id="rPrecioReal" inputmode="decimal" placeholder="1,459" autocomplete="off"></label>` : ''}
      <label class="campo campo-comentario" for="rComentario"><span class="sr">Comentario (opcional)</span>
        <textarea id="rComentario" name="comentario" maxlength="500" placeholder="Ej.: después de repostar el coche iba a tirones"></textarea>
        <span class="contador-txt" id="rContador" aria-hidden="true">0/500</span>
      </label>
      ${u && u.rol === 'usuario' ? `<div class="ticket-caja">
        <label class="boton" for="rTicket">📷 Añadir foto del ticket <small>(opcional)</small></label>
        <input type="file" id="rTicket" accept="image/*" capture="environment" class="sr">
        <p class="texto-ayuda" id="rTicketEstado">Tu valoración contará más y llevará la marca “ticket comprobado”. La foto se lee en tu móvil y no se sube.</p>
      </div>` : ''}
      <p class="error" id="rError" hidden></p>
      ${como}
      <button class="boton primario" type="submit" id="rEnviar">Enviar valoración</button>
      <p class="texto-ayuda">Valora solo si has repostado aquí. Las valoraciones falsas se pueden denunciar y se retiran.</p>
    </form>`;
  }

  // Datos del ticket leído en esta ficha (se envían con la valoración)
  let ticketLeido = null;
  function activarTicket(e) {
    const input = $('#rTicket');
    if (!input) return;
    const estadoT = $('#rTicketEstado');
    input.addEventListener('change', async () => {
      const f = input.files[0];
      ticketLeido = null;
      if (!f) return;
      estadoT.className = 'texto-ayuda';
      try {
        const r = await GasoTicket.leerFoto(f, e, (p, txt) => (estadoT.textContent = `${txt} ${p ? p + ' %' : ''}`));
        const d = r.datos;
        if (!d.completo) {
          estadoT.innerHTML = '<span class="texto-peligro">No se pudo leer bien el ticket (fecha, litros o importe). Prueba con una foto más cerca, recta y con buena luz.</span>';
          return;
        }
        if (!r.coincide) {
          estadoT.innerHTML = `<span class="texto-peligro">El ticket no parece de ${esc(e.rotulo)} (${esc(e.localidad)}).</span> Si es de otra gasolinera, valóralo en su ficha.`;
          return;
        }
        ticketLeido = { envio: { hash: r.hash, fecha: d.fecha, litros: d.litros, importe: d.importe, coincideGasolinera: true }, datos: d, fichero: f };
        estadoT.innerHTML = `<span class="ok">✓ Ticket del ${new Date(d.fecha + 'T12:00:00').toLocaleDateString('es-ES')} · ${euros(d.litros, 2)} L · ${euros(d.importe, 2)} € (${euros(d.importe / d.litros)} €/l)</span>`;
      } catch (x) {
        estadoT.innerHTML = `<span class="texto-peligro">${esc(x.message)}</span>`;
      }
    });
  }

  // Tras valorar con ticket: apuntarlo en el diario con un toque
  function ofrecerDiario(e, t, combustible) {
    const caja = $('#formCaja');
    if (!caja || !conSesion()) return;
    const div = document.createElement('div');
    div.className = 'aviso-cuenta';
    div.innerHTML = `<p>¿Lo apuntamos en Mis repostajes con la foto del ticket? ${euros(t.datos.litros, 2)} L · ${euros(t.datos.importe, 2)} €</p><div class="acciones"><button type="button" class="boton primario" data-si>Apuntar</button><button type="button" class="boton" data-no>No, gracias</button></div>`;
    caja.prepend(div);
    $('[data-no]', div).addEventListener('click', () => div.remove());
    $('[data-si]', div).addEventListener('click', async () => {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const entrada = {
        id, fecha: t.datos.fecha, estacion: e.id, nombre: `${e.rotulo} · ${e.localidad}`,
        combustible: combustible || estado.combustible, litros: t.datos.litros, importe: t.datos.importe, km: null, lleno: true,
        ...(estado.ajustes.cocheActivo ? { coche: estado.ajustes.cocheActivo } : {}),
      };
      if (t.fichero) {
        try {
          await GasoFotos.guardar(id, t.fichero);
          entrada.foto = id;
        } catch {
          /* se apunta igualmente, sin foto */
        }
      }
      estado.diario.push(entrada);
      guardarLocal('gm.diario', estado.diario);
      div.innerHTML = '<p class="ok-cuenta">✓ Apuntado en Mis repostajes con la foto del ticket.</p>';
    });
  }

  function activarFormulario(e) {
    activarTicket(e);
    $$('[data-abrir-cuenta]', $('#formCaja')).forEach((b) => b.addEventListener('click', () => Cuenta.abrir()));
    const f = $('#formReporte');
    if (!f) return;
    const marcar = (n) => {
      $$('.estrellas label', f).forEach((l, i) => l.classList.toggle('on', i < n));
      $('#textoNota').innerHTML = n ? `<b>${String(n)},0</b> · ${TEXTO_NOTA[n]}` : 'Toca para puntuar';
    };
    $$('.estrellas input', f).forEach((r) => r.addEventListener('change', () => marcar(+r.value)));
    $('#rComentario', f)?.addEventListener('input', (ev) => { $('#rContador').textContent = `${ev.target.value.length}/500`; });
    const chkPrecio = $('input[name="problemas"][value="precio_declarado"]', f);
    if (chkPrecio && $('#rPrecioCaja')) chkPrecio.addEventListener('change', () => ($('#rPrecioCaja').hidden = !chkPrecio.checked));
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(f);
      const err = $('#rError');
      err.hidden = true;
      if (!fd.get('puntuacion')) {
        err.textContent = 'Elige de 1 a 5 estrellas antes de enviar.';
        err.hidden = false;
        return;
      }
      const btn = $('#rEnviar');
      btn.disabled = true;
      btn.textContent = 'Enviando…';
      try {
        const d = await api(`/api/estaciones/${encodeURIComponent(e.id)}/reportes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            puntuacion: +fd.get('puntuacion'),
            combustible: fd.get('combustible'),
            problemas: fd.getAll('problemas'),
            comentario: fd.get('comentario'),
            ...(ticketLeido ? { ticket: ticketLeido.envio } : {}),
          }),
        });
        const ticketUsado = ticketLeido;
        ticketLeido = null;
        estado.calidad[e.id] = { total: d.resumen.total, puntuacion: d.resumen.puntuacion, ...(d.resumen.alerta ? { alerta: d.resumen.alerta } : {}) };
        // Si ha marcado que el precio no era el anunciado e indica el real, cuenta como corrección
        let extra = '';
        const precioReal = $('#rPrecioReal')?.value.trim();
        const combR = fd.get('combustible');
        if (precioReal && fd.getAll('problemas').includes('precio_declarado') && estado.extras[e.id]?.d?.[combR]) {
          try {
            const r = await enviarCorreccion(e, combR, precioReal);
            extra = r.aplicada ? ' Precio corregido con otros usuarios.' : ' Precio anotado.';
          } catch (x) {
            extra = ' (No se pudo anotar el precio: ' + x.message + ')';
          }
        }
        f.reset();
        marcar(0);
        if ($('#rPrecioCaja')) $('#rPrecioCaja').hidden = true;
        avisar('Valoración enviada. ¡Gracias!' + extra, extra ? 5000 : 3500);
        if (ticketUsado) ofrecerDiario(e, ticketUsado, fd.get('combustible'));
        repintarIcono(e.id);
        pintarLista();
        cargarReportes(e.id);
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Enviar valoración';
      }
    });
  }

  async function cargarReportes(id) {
    const sec = $('#calidadSec');
    const ops = $('#opinionesSec');
    try {
      const { resumen, reportes } = await api(`/api/estaciones/${encodeURIComponent(id)}/reportes`);
      if (estado.sel !== id) return;
      if (!resumen.total) {
        sec.innerHTML = `<h3>Calidad del combustible</h3><div class="calidad-cab"><div class="marcador">–</div><p>Nadie la ha valorado en los últimos 12 meses. <b>Sé el primero</b> tras repostar.</p></div>`;
        ops.innerHTML = '';
        return;
      }
      const cls = resumen.alerta ? 'mala' : resumen.puntuacion >= 7 ? 'buena' : resumen.puntuacion >= 5 ? 'regular' : 'mala';
      const barras = Object.entries(resumen.problemas)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `<div class="barra"><div><i style="width:${Math.round((n / resumen.total) * 100)}%"></i><span>${esc(problemas[k] || k)}</span></div><b>${n}</b></div>`)
        .join('');
      sec.innerHTML = `<h3>Calidad del combustible</h3>
        <div class="calidad-cab">
          <div class="marcador ${cls}" aria-label="Puntuación ${resumen.puntuacion} sobre 10">${num1(resumen.puntuacion)}</div>
          <p><b>${num1(resumen.media)} de 5 estrellas</b> de media en ${resumen.total} ${resumen.total === 1 ? 'valoración' : 'valoraciones'}${resumen.conTicket ? `, ${resumen.conTicket} con ticket` : ''}.<br>Nota sobre 10: pesan más las opiniones con ticket y de conductores fiables.</p>
        </div>
        ${barras ? `<div class="barras" aria-label="Problemas reportados">${barras}</div>` : ''}`;
      ops.innerHTML = `<h3>Últimas valoraciones</h3><ul class="opiniones">${reportes
        .map(
          (x) => `<li><div class="cab"><b aria-label="${x.puntuacion} de 5">${'★'.repeat(x.puntuacion)}${'☆'.repeat(5 - x.puntuacion)}</b><span>${x.autor ? `<b class="autor">${esc(x.autor)}</b>${x.autorVerificado ? ' <span class="ins-verif" title="Cuenta con correo confirmado">✓</span>' : ''} · ` : 'Anónimo · '}${esc(NOMBRES[x.combustible] || '')} · ${new Date(x.fecha).toLocaleDateString('es-ES')}${x.editado ? ' · editada' : ''}</span></div>${
            x.ticket || x.fiable ? `<div class="insignias">${x.ticket ? '<span class="ins-ticket" title="Ha subido el ticket del repostaje">🧾 Ticket comprobado</span>' : ''}${x.fiable ? '<span class="ins-fiable" title="Usuario con muchas aportaciones acertadas">Conductor fiable</span>' : ''}</div>` : ''
          }${
            x.problemas.length ? `<div class="tags">${x.problemas.map((p) => esc(problemas[p] || p)).join(' · ')}</div>` : ''
          }${x.comentario ? `<p>${esc(x.comentario)}</p>` : ''}${
            x.respuesta ? `<div class="respuesta-gas"><b>Respuesta de ${esc(x.respuesta.empresa)}</b><p>${esc(x.respuesta.texto)}</p></div>` : ''
          }${
            x.mio
              ? `<div class="mia-acciones"><span class="tuya">Tu valoración</span><button type="button" class="enlace" data-editar="${esc(x.id)}">Editar</button><button type="button" class="enlace texto-peligro" data-eliminar="${esc(x.id)}">Eliminar</button></div>`
              : `<button type="button" class="denunciar" data-r="${esc(x.id)}">Denunciar</button>`
          }</li>`
        )
        .join('')}</ul>`;
      // Editar y eliminar la valoración propia
      const porId = new Map(reportes.map((x) => [x.id, x]));
      $$('[data-editar]', ops).forEach((b) => b.addEventListener('click', () => editarValoracion(b.closest('li'), porId.get(b.dataset.editar), id)));
      $$('[data-eliminar]', ops).forEach((b) =>
        b.addEventListener('click', async () => {
          if (b.dataset.paso !== 'confirmar') {
            b.dataset.paso = 'confirmar';
            b.textContent = '¿Seguro? Pulsa para eliminar';
            return;
          }
          b.disabled = true;
          try {
            const r = await api(`/api/reportes/${encodeURIComponent(b.dataset.eliminar)}`, { method: 'DELETE' });
            actualizarCalidad(id, r.resumen);
            avisar('Valoración eliminada');
            cargarReportes(id);
          } catch (x) {
            b.textContent = x.message;
          }
        })
      );
      $$('.denunciar', ops).forEach((b) =>
        b.addEventListener('click', async () => {
          if (b.dataset.paso !== 'confirmar') {
            b.dataset.paso = 'confirmar';
            b.textContent = '¿Es falsa u ofensiva? Pulsa para confirmar';
            return;
          }
          b.disabled = true;
          try {
            const r = await api(`/api/reportes/${encodeURIComponent(b.dataset.r)}/denuncia`, { method: 'POST' });
            b.textContent = r.oculto ? 'Retirada a revisión' : 'Denunciada. Gracias';
            if (r.oculto) setTimeout(() => cargarReportes(id), 1200);
          } catch (x) {
            b.textContent = x.message;
          }
        })
      );
    } catch {
      sec.innerHTML = '<h3>Calidad del combustible</h3><p class="texto-ayuda">No se pudieron cargar las valoraciones.</p>';
    }
  }

  function actualizarCalidad(id, resumen) {
    if (resumen && resumen.total) estado.calidad[id] = { total: resumen.total, puntuacion: resumen.puntuacion, ...(resumen.alerta ? { alerta: resumen.alerta } : {}) };
    else delete estado.calidad[id];
    repintarIcono(id);
    pintarLista();
  }

  // Sustituye la valoración por un formulario con sus datos
  function editarValoracion(li, x, idEst) {
    if (!li || !x) return;
    const e = estado.porId.get(idEst);
    const estrellas = [1, 2, 3, 4, 5]
      .map((n) => `<input type="radio" name="edPunt" id="ed${n}" value="${n}" ${n === x.puntuacion ? 'checked' : ''}><label for="ed${n}" class="${n <= x.puntuacion ? 'on' : ''}" title="${n} de 5">${ESTRELLA}<span class="sr">${n} de 5</span></label>`)
      .join('');
    const chips = Object.entries(problemas)
      .map(([k, t]) => `<label><input type="checkbox" name="edProb" value="${k}" ${x.problemas.includes(k) ? 'checked' : ''}><span>${esc(t)}</span></label>`)
      .join('');
    const combs = Object.keys(NOMBRES)
      .filter((k) => e && base(e, k) != null)
      .map((k) => `<option value="${k}" ${k === x.combustible ? 'selected' : ''}>${NOMBRES[k]}</option>`)
      .join('');
    li.innerHTML = `<form class="reporte edicion" novalidate>
      <fieldset class="estrellas"><legend>Edita tu valoración</legend>${estrellas}</fieldset>
      <label class="campo" for="edComb">Combustible<select id="edComb">${combs}</select></label>
      ${chips ? `<fieldset class="chips"><legend>Problemas</legend>${chips}</fieldset>` : ''}
      <label class="campo" for="edCom">Comentario<textarea id="edCom" maxlength="500">${esc(x.comentario)}</textarea></label>
      <p class="error" hidden></p>
      <div class="acciones"><button class="boton primario" type="submit">Guardar cambios</button><button class="boton" type="button" data-cancelar>Cancelar</button></div>
    </form>`;
    const f = $('form', li);
    $$('.estrellas input', f).forEach((r) =>
      r.addEventListener('change', () => $$('.estrellas label', f).forEach((l, i) => l.classList.toggle('on', i < +r.value)))
    );
    $('[data-cancelar]', f).addEventListener('click', () => cargarReportes(idEst));
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('.error', f);
      try {
        const r = await api(`/api/reportes/${encodeURIComponent(x.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            puntuacion: +($('input[name="edPunt"]:checked', f)?.value || 0),
            combustible: $('#edComb', f)?.value || x.combustible,
            problemas: $$('input[name="edProb"]:checked', f).map((i) => i.value),
            comentario: $('#edCom', f).value,
          }),
        });
        actualizarCalidad(idEst, r.resumen);
        avisar('Valoración actualizada');
        cargarReportes(idEst);
      } catch (x2) {
        err.textContent = x2.message;
        err.hidden = false;
      }
    });
    $('input[name="edPunt"]:checked', f)?.focus();
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ficha.hidden && document.activeElement !== q) cerrarFicha();
  });
  window.addEventListener('hashchange', abrirDesdeHash);

  /* ---------- Mi coche: descuentos, datos del coche y diario ---------- */
  const decimal = (v) => {
    const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const hoyISO = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
  const fechaCorta = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: '2-digit' });
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const nombreEstacion = (e) => `${e.rotulo} · ${e.localidad}`;
  let importeManual = false;

  function opcionesEstacion(sel) {
    const ids = [...new Set([...(sel ? [sel] : []), ...estado.recientes, ...estado.favoritas])].filter((id) => estado.porId.has(id));
    return '<option value="">Sin indicar</option>' + ids.map((id) => `<option value="${esc(id)}" ${id === sel ? 'selected' : ''}>${esc(nombreEstacion(estado.porId.get(id)))}</option>`).join('');
  }

  function diarioDelCocheActivo() {
    const coches = GasoCoches.lista();
    const act = GasoCoches.activo();
    return coches.length > 1 && act ? estado.diario.filter((x) => MiCoche.esDelCoche(x, act.id, coches)) : estado.diario;
  }
  // Mi coche: arriba los coches (pulsa uno para elegirlo) y debajo sus apartados
  let apartadoMC = 'datos';
  let mcCierreMenu = null; // oyentes globales del menú hamburguesa (se renuevan en cada pintado)
  function pintarMiCoche() {
    const el = $('#vMiCoche');
    if (!conSesion()) {
      el.innerHTML = sinSesionHTML('Tu coche, en tu cuenta', 'Entra o crea una cuenta gratis para guardar tus coches con su foto, calcular su consumo medio y añadir tus descuentos. Así los tendrás en todos tus dispositivos.');
      activarSinSesion(el);
      return;
    }
    const coches = GasoCoches.lista();
    const act = GasoCoches.activo();
    // Gastos y consumo real del coche elegido (con varios coches, solo sus repostajes)
    const diarioCoche = diarioDelCocheActivo();
    const an = MiCoche.analizarDiario(diarioCoche);
    const mesActual = hoyISO().slice(0, 7);
    const d = new Date(mesActual + '-15T12:00:00');
    d.setMonth(d.getMonth() - 1);
    const mesPasado = d.toISOString().slice(0, 7);
    const marcas = [...new Set(estado.estaciones.map((e) => e.rotulo))].sort((a, b) => a.localeCompare(b, 'es')).slice(0, 400);
    const conEmpresa = window.Cuenta?.usuario()?.rol === 'usuario';
    if (apartadoMC === 'empresa' && !conEmpresa) apartadoMC = 'datos';

    const reglas = estado.descuentos.length
      ? `<ul class="reglas">${estado.descuentos
          .map((g) => `<li><span>${g.nombre ? `<b>${esc(g.nombre)}</b> · ` : ''}${esc(MiCoche.textoRegla(g))}</span><button type="button" class="enlace" data-borrar-regla="${esc(g.id)}">Quitar</button></li>`)
          .join('')}</ul>`
      : '<p class="texto-ayuda">Aún no has añadido descuentos. Con ellos podrás ver los precios tal y como los pagas tú, sin perder la vista oficial.</p>';

    const tiles = `<div class="tiles">
      <div><span>Consumo real</span><strong>${an.consumoMedio ? num1(an.consumoMedio) : '—'}</strong><small>l/100 km</small></div>
      <div><span>Gasto ${MESES[+mesActual.slice(5) - 1]}</span><strong>${euros(an.gastoPorMes[mesActual] || 0, 0)}</strong><small>€</small></div>
      <div><span>Gasto ${MESES[+mesPasado.slice(5) - 1]}</span><strong>${euros(an.gastoPorMes[mesPasado] || 0, 0)}</strong><small>€</small></div>
      <div><span>Precio medio pagado</span><strong>${an.precioMedio ? euros(an.precioMedio) : '—'}</strong><small>€/l</small></div>
    </div>`;

    const vistas = new Set();
    const anomalias = an.anomalias
      .slice()
      .reverse()
      .filter((t) => !vistas.has(t.estacion) && vistas.add(t.estacion))
      .map((t) => {
        const est = estado.porId.get(t.estacion);
        return `<div class="aviso-consumo"><p><b>Consumo ${Math.round(t.desviacion * 100)} % más alto</b> con el combustible de ${esc(est ? nombreEstacion(est) : t.nombre)} (repostaje del ${fechaCorta(t.desde)}): ${num1(t.consumo)} l/100 km frente a tu habitual de ${num1(t.referencia)}.</p>
          <p class="texto-ayuda">Puede deberse a otras causas (trayectos, carga, tiempo). Si además notaste algo raro, valóralo.</p>
          ${est ? `<button type="button" class="boton" data-id="${esc(t.estacion)}">Ver y valorar la gasolinera</button>` : ''}</div>`;
      })
      .join('');

    const apartados = [
      ['datos', 'Datos del coche', '<path d="M4 16.5v-4.5l2-5h12l2 5v4.5z"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/><path d="M4 12h16"/>'],
      ['consumo', 'Consumo', '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>'],
      ['gastos', 'Gastos', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
      ['descuentos', 'Descuentos', '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.5"/>'],
      conEmpresa && ['empresa', 'Empresa', '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M10 21v-4h4v4"/>'],
    ].filter(Boolean);
    const ap = (id, cuerpo) => `<section class="apartado" data-mc="${id}" role="tabpanel" aria-labelledby="mc-${id}" ${apartadoMC === id ? '' : 'hidden'}>${cuerpo}</section>`;
    const nombreAct = act ? esc(GasoCoches.nombre(act)) : '';

    el.innerHTML = `
      ${coches.length ? `<div class="mc-coches">${GasoCoches.galeriaHTML({ seleccion: act?.id, titulo: 'Tus coches: pulsa uno para elegirlo' })}</div>` : ''}
      <div class="perfil-cuerpo mc-cuerpo">
        <div class="mc-menu" id="mcMenu">
          <button type="button" class="mc-hamb" id="mcHamb" aria-expanded="false" aria-controls="mcNav" aria-haspopup="true">
            <span class="hamb-ico" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="mc-hamb-txt">${esc((apartados.find((a) => a[0] === apartadoMC) || apartados[0])[1])}</span>
            <svg class="hamb-flecha" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <nav class="perfil-nav" id="mcNav" role="tablist" aria-label="Apartados de Mi coche">
            ${apartados.map(([id, txt, ico]) => `<button type="button" role="tab" id="mc-${id}" data-mc-ir="${id}" aria-selected="${apartadoMC === id}"><svg viewBox="0 0 24 24" aria-hidden="true">${ico}</svg>${txt}</button>`).join('')}
          </nav>
        </div>
        <div class="perfil-contenido">
          ${ap('datos', `<h3 class="apartado-tit">${coches.length ? 'Datos del coche' : 'Añade tu coche'}</h3><div id="mcGestor"></div>`)}
          ${ap('consumo', `<h3 class="apartado-tit">Consumo${act ? ' · ' + nombreAct : ''}</h3>
            <div id="mcMediciones"></div>
            <div class="bloque-perfil">
              <h4>Calculadora de ahorro</h4>
              <div class="calc-campos">
                <label for="mcLitros">Litros que sueles echar<input id="mcLitros" inputmode="decimal" value="${String(estado.ajustes.litros).replace('.', ',')}"></label>
                <label for="mcConsumo">Consumo (l/100 km)<input id="mcConsumo" inputmode="decimal" value="${String(estado.ajustes.consumo).replace('.', ',')}"></label>
              </div>
              ${an.consumoMedio && Math.abs(an.consumoMedio - estado.ajustes.consumo) >= 0.1
                ? `<button type="button" class="boton" id="usarReal">Usar mi consumo real según mis repostajes (${num1(an.consumoMedio)} l/100 km)</button>`
                : ''}
              <p class="texto-ayuda">Se usan en la calculadora de ahorro de cada gasolinera.</p>
            </div>`)}
          ${ap('gastos', `<h3 class="apartado-tit">Gastos${act && coches.length > 1 ? ' · ' + nombreAct : ''}</h3>
            ${tiles}
            ${an.consumoMedio ? '' : '<p class="texto-ayuda">Para calcular tu consumo real, apunta los kilómetros y marca “depósito lleno” en al menos dos repostajes.</p>'}
            ${anomalias}
            <div class="acciones"><button type="button" class="boton primario" id="irApuntar">⛽ Apuntar repostaje</button><button type="button" class="boton" id="irRepostajes">Ver mis repostajes</button></div>`)}
          ${ap('descuentos', `<h3 class="apartado-tit">Mis descuentos</h3>
            ${reglas}
            <form id="fRegla" class="form-linea" novalidate>
              <label for="rgMarca">Marca<input id="rgMarca" list="listaMarcas" placeholder="Ej.: REPSOL" autocomplete="off"></label>
              <datalist id="listaMarcas"><option value="Todas las gasolineras">${marcas.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
              <label for="rgValor">Descuento<input id="rgValor" inputmode="decimal" placeholder="5"></label>
              <label for="rgTipo">Tipo<select id="rgTipo"><option value="cent">cént./litro</option><option value="pct">%</option></select></label>
              <label for="rgNombre">Nombre (opcional)<input id="rgNombre" placeholder="Ej.: tarjeta del súper"></label>
              <button class="boton primario" type="submit">Añadir</button>
            </form>
            <p class="error" id="rgError" hidden></p>
            <p class="texto-ayuda">Si tu descuento cambia según el día o tiene límite, pon una cifra media. En el <b>Mapa</b> verás el interruptor <b>Oficial / Con mis descuentos</b> para cambiar de vista cuando quieras.</p>`)}
          ${conEmpresa ? ap('empresa', '<section class="bloque" id="bloqueEmpresa" hidden></section>') : ''}
        </div>
      </div>`;

    // Elegir coche pulsando su foto, o añadir otro
    GasoCoches.cargarMiniaturas(el);
    $$('.mc-coches .coche-chip', el).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.coche === 'nuevo') {
        GasoCoches.empezarNuevo();
        apartadoMC = 'datos';
      } else GasoCoches.elegir(b.dataset.coche);
      pintarMiCoche();
    }));
    // Menú de apartados: en móvil es una hamburguesa que se despliega y se cierra al elegir
    const mcMenu = $('#mcMenu', el), mcHamb = $('#mcHamb', el);
    const abrirMenuMC = (abrir) => {
      mcMenu.classList.toggle('abierto', abrir);
      mcHamb.setAttribute('aria-expanded', String(abrir));
    };
    mcHamb.addEventListener('click', (ev) => {
      ev.stopPropagation();
      abrirMenuMC(!mcMenu.classList.contains('abierto'));
    });
    if (mcCierreMenu) {
      document.removeEventListener('click', mcCierreMenu.clic);
      document.removeEventListener('keydown', mcCierreMenu.tecla);
    }
    mcCierreMenu = {
      clic: (ev) => { if (mcMenu.isConnected && !mcMenu.contains(ev.target)) abrirMenuMC(false); },
      tecla: (ev) => { if (ev.key === 'Escape' && mcMenu.classList.contains('abierto')) { abrirMenuMC(false); mcHamb.focus(); } },
    };
    document.addEventListener('click', mcCierreMenu.clic);
    document.addEventListener('keydown', mcCierreMenu.tecla);
    $$('[data-mc-ir]', el).forEach((b) => b.addEventListener('click', () => {
      apartadoMC = b.dataset.mcIr;
      $$('[data-mc-ir]', el).forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      $$('[data-mc]', el).forEach((sec) => (sec.hidden = sec.dataset.mc !== apartadoMC));
      $('.mc-hamb-txt', el).textContent = b.textContent.trim();
      abrirMenuMC(false);
    }));
    GasoCoches.pintarGestor($('#mcGestor'), { conGaleria: false, alCambiar: pintarMiCoche });
    GasoCoches.pintarConsumo($('#mcMediciones'), { alCambiar: pintarMiCoche });
    activarMiCoche();
    pintarMiEmpresa();
  }

  /* ---------- Mis repostajes: por año, mes y día, con la foto del ticket ---------- */
  const DIAS_SEM = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const sumar = (xs) => {
    const conImporte = xs.filter((x) => x.importe > 0);
    const litrosConImporte = conImporte.reduce((a, x) => a + x.litros, 0);
    return {
      n: xs.length,
      litros: xs.reduce((a, x) => a + x.litros, 0),
      euros: conImporte.reduce((a, x) => a + x.importe, 0),
      media: litrosConImporte ? conImporte.reduce((a, x) => a + x.importe, 0) / litrosConImporte : null,
    };
  };
  const cifras = (t) => `${t.n} ${t.n === 1 ? 'repostaje' : 'repostajes'} · ${euros(t.litros, 1)} L · <b>${euros(t.euros, 2)} €</b>`;
  let fotoNueva = null; // foto elegida en el formulario, se guarda al guardar el repostaje

  // Con varios coches: pulsando la foto de uno se ven solo sus repostajes; sin elegir ninguno, los de todos
  let filtroCocheRepos = null;
  function pintarRepostajes(abrirFormulario = false) {
    const el = $('#vRepostajes');
    if (!el) return;
    if (!conSesion()) {
      el.innerHTML = sinSesionHTML('Tus repostajes, en tu cuenta', 'Entra o crea una cuenta gratis para apuntar tus repostajes con la foto del ticket y ver cuánto gastas cada mes y en cada coche.');
      activarSinSesion(el);
      return;
    }
    const coches = GasoCoches.lista();
    const varios = coches.length > 1;
    if (!varios || !coches.some((c) => c.id === filtroCocheRepos)) filtroCocheRepos = null;
    const cocheFiltro = coches.find((c) => c.id === filtroCocheRepos) || null;
    const cocheDe = (x) => coches.find((c) => MiCoche.esDelCoche(x, c.id, coches));
    const abiertoAntes = $('#nuevoRepostaje')?.open;
    const lista = estado.diario.filter((x) => !filtroCocheRepos || MiCoche.esDelCoche(x, filtroCocheRepos, coches)).sort((a, b) => (b.fecha + (b.hora || '')).localeCompare(a.fecha + (a.hora || '')) || (b.km || 0) - (a.km || 0));
    const hoy = hoyISO();
    const anios = new Map();
    for (const x of lista) {
      const a = x.fecha.slice(0, 4), m = x.fecha.slice(0, 7);
      if (!anios.has(a)) anios.set(a, new Map());
      const meses = anios.get(a);
      if (!meses.has(m)) meses.set(m, []);
      meses.get(m).push(x);
    }
    const total = sumar(lista);
    const esteAnio = sumar(lista.filter((x) => x.fecha.startsWith(hoy.slice(0, 4))));

    const fila = (x) => {
      const f = new Date(x.fecha + 'T12:00:00');
      const est = x.estacion && estado.porId.get(x.estacion);
      return `<li class="repo" data-entrada="${esc(x.id)}">
        <button type="button" class="miniatura" data-foto="${esc(x.id)}" ${x.foto ? '' : 'hidden'} aria-label="Ver la foto del ticket del ${f.toLocaleDateString('es-ES')}"><img alt="" data-cargar="${esc(x.foto || '')}"></button>
        <div class="repo-cuerpo">
          <div class="repo-cab"><b>${DIAS_SEM[f.getDay()]} ${f.getDate()}</b><span>${esc(x.nombre || 'Gasolinera sin indicar')}</span></div>
          <div class="repo-cifras"><span><b>${euros(x.litros, 2)}</b> L</span><span><b>${x.importe ? euros(x.importe, 2) : '—'}</b> €</span>${x.importe ? `<span class="pl">${euros(x.importe / x.litros)} €/l</span>` : ''}</div>
          <div class="repo-meta">${varios && cocheDe(x) ? `<span class="repo-coche">${esc(GasoCoches.nombre(cocheDe(x)))}</span> · ` : ''}${esc(NOMBRES[x.combustible] || '')}${x.km ? ` · ${x.km.toLocaleString('es-ES')} km` : ''}${x.lleno ? ' · <span class="lleno">Lleno</span>' : ''}${x.empresa ? ' · <span class="lleno">Empresa</span>' : ''}</div>
          <div class="repo-acc">
            ${est ? `<button type="button" class="enlace" data-id="${esc(est.id)}">Ver gasolinera</button>` : ''}
            <label class="enlace" for="foto-${esc(x.id)}">${x.foto ? 'Cambiar foto' : '📷 Añadir foto del ticket'}</label>
            <input type="file" id="foto-${esc(x.id)}" class="sr" accept="image/*" data-subir="${esc(x.id)}">
            <button type="button" class="enlace texto-peligro" data-borrar-entrada="${esc(x.id)}">Borrar</button>
          </div>
        </div></li>`;
    };

    let primerMes = true;
    const grupos = [...anios].map(([a, meses], i) => {
      const todosAnio = [...meses.values()].flat();
      return `<details class="anio" ${i === 0 ? 'open' : ''}>
        <summary><span class="anio-num">${a}</span><span class="grupo-cifras">${cifras(sumar(todosAnio))}</span></summary>
        ${[...meses].map(([m, xs]) => {
          const t = sumar(xs);
          const abierto = primerMes;
          primerMes = false;
          return `<details class="mes" ${abierto ? 'open' : ''}>
            <summary><span class="mes-nombre">${capital(MESES[+m.slice(5) - 1])}</span><span class="grupo-cifras">${cifras(t)}${t.media ? ` · ${euros(t.media)} €/l` : ''}</span></summary>
            <ol class="repostajes">${xs.map(fila).join('')}</ol>
          </details>`;
        }).join('')}
      </details>`;
    }).join('');

    const elegido = filtroCocheRepos || estado.ajustes.cocheActivo || coches[0]?.id || '';
    // Ordenador: formulario fijo a la izquierda; a la derecha los coches y debajo la lista.
    // Móvil: el formulario arriba, plegable.
    const formAbierto = !esMovil() || abrirFormulario || abiertoAntes || !estado.diario.length;
    el.innerHTML = `
     <div class="repos-layout">
      <aside class="repos-izq">
        <details class="bloque nuevo-repo" id="nuevoRepostaje" ${formAbierto ? 'open' : ''}>
          <summary class="boton primario">⛽ Apuntar repostaje</summary>
          <h3 class="tit-form-repo">Apuntar repostaje</h3>
          <form id="fDiario" class="form-diario" novalidate>
            <div class="ancho foto-campo">
              <label class="boton" for="dFoto">📷 Foto del ticket <small>(opcional)</small></label>
              <input type="file" id="dFoto" accept="image/*" capture="environment" class="sr">
              <span id="dFotoEstado" class="texto-ayuda">La guardamos con el repostaje y rellenamos fecha, litros e importe leyendo el ticket.</span>
            </div>
            ${varios
              ? `<label for="dCoche" class="ancho">Coche<select id="dCoche">${coches.map((c) => `<option value="${esc(c.id)}" ${c.id === elegido ? 'selected' : ''}>${esc(GasoCoches.nombre(c))}${c.anio ? ' · ' + esc(c.anio) : ''}</option>`).join('')}</select></label>`
              : coches.length ? `<input type="hidden" id="dCoche" value="${esc(coches[0].id)}">` : ''}
            <label for="dFecha">Fecha<input id="dFecha" type="date" value="${hoy}" max="${hoy}"></label>
            <label for="dEstacion" class="ancho">Gasolinera<select id="dEstacion">${opcionesEstacion('')}</select></label>
            <label for="dComb">Combustible<select id="dComb">${Object.keys(NOMBRES).map((k) => `<option value="${k}" ${k === estado.combustible ? 'selected' : ''}>${NOMBRES[k]}</option>`).join('')}</select></label>
            <label for="dLitros">Litros<input id="dLitros" inputmode="decimal" placeholder="40,5"></label>
            <label for="dImporte">Importe (€)<input id="dImporte" inputmode="decimal" placeholder="60,00"></label>
            <label for="dKm">Cuentakilómetros<input id="dKm" inputmode="numeric" placeholder="125400"></label>
            <label class="check ancho"><input type="checkbox" id="dLleno" checked> He llenado el depósito</label>
            <p class="error ancho" id="dError" hidden></p>
            <div class="ancho" id="dEmpresaCaja"></div>
            <button class="boton primario ancho" type="submit">Guardar repostaje</button>
          </form>
        </details>
      </aside>
      <div class="repos-der">
      ${varios ? `<section class="bloque repo-coches">
        ${GasoCoches.galeriaHTML({ seleccion: filtroCocheRepos, anadir: false, modo: 'filtro', titulo: 'Ver los repostajes de un coche' })}
        <p class="texto-ayuda" aria-live="polite">${cocheFiltro ? `Viendo solo los repostajes de tu <b>${esc(GasoCoches.nombre(cocheFiltro))}</b>. Pulsa otra vez su foto para ver los de todos.` : 'Viendo los repostajes de todos tus coches. Pulsa la foto de uno para ver solo los suyos.'}</p>
      </section>` : ''}
      <section class="bloque">
        <div class="tiles">
          <div><span>Este año</span><strong>${euros(esteAnio.euros, 0)}</strong><small>€ · ${euros(esteAnio.litros, 0)} L</small></div>
          <div><span>En total</span><strong>${euros(total.euros, 0)}</strong><small>€ · ${total.n} repostajes</small></div>
        </div>
      </section>
      <section class="bloque" id="bloqueDiario">
        <h3>Mis repostajes${cocheFiltro ? ' · ' + esc(GasoCoches.nombre(cocheFiltro)) : ''}</h3>
        ${lista.length ? grupos : cocheFiltro ? '<p class="texto-ayuda">Este coche aún no tiene repostajes.</p>' : '<p class="texto-ayuda">Aún no has apuntado ningún repostaje. Apúntalos aquí o desde la ficha de cada gasolinera, y verás cuánto echas y gastas cada mes.</p>'}
        ${lista.length ? '<button type="button" class="boton" id="exportar">Exportar a Excel (CSV)</button>' : ''}
        <p class="texto-ayuda">Se guardan en este dispositivo${window.Cuenta?.usuario() ? ' y en tu cuenta, también las fotos de los tickets, que solo ves tú' : '. Con una cuenta los tendrás también en tus otros dispositivos'}.</p>
      </section>
      </div>
     </div>`;
    // En el ordenador el formulario no se pliega
    $('#nuevoRepostaje').addEventListener('toggle', (ev) => { if (!esMovil() && !ev.target.open) ev.target.open = true; });

    activarRepostajes();
    pintarMiEmpresa();
    if (varios) {
      GasoCoches.cargarMiniaturas(el);
      $$('.repo-coches .coche-chip', el).forEach((b) => b.addEventListener('click', () => {
        filtroCocheRepos = filtroCocheRepos === b.dataset.coche ? null : b.dataset.coche;
        // Se redibuja la página sin perder lo que estabas escribiendo en el formulario
        const campos = ['dFecha', 'dEstacion', 'dComb', 'dLitros', 'dImporte', 'dKm'].map((id) => [id, $('#' + id)?.value]);
        const lleno = $('#dLleno')?.checked;
        const manual = importeManual;
        pintarRepostajes();
        campos.forEach(([id, v]) => { if ($('#' + id) && v != null) $('#' + id).value = v; });
        if ($('#dLleno')) $('#dLleno').checked = lleno;
        importeManual = manual;
        if (filtroCocheRepos && $('#dCoche')?.tagName === 'SELECT') $('#dCoche').value = filtroCocheRepos;
      }));
    }
    // Miniaturas de los tickets
    $$('img[data-cargar]', el).forEach(async (img) => {
      if (!img.dataset.cargar) return;
      const u = await GasoFotos.url(img.dataset.cargar);
      if (u) {
        img.src = u;
        img.closest('.miniatura').hidden = false;
      } else img.closest('.miniatura').hidden = true;
    });
  }

  function activarMiCoche() {
    const el = $('#vMiCoche');

    // Descuentos
    $('#fRegla').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const err = $('#rgError');
      err.hidden = true;
      const marcaTxt = $('#rgMarca').value.trim();
      const valor = decimal($('#rgValor').value);
      const tipo = $('#rgTipo').value;
      if (!marcaTxt) { err.textContent = 'Escribe la marca a la que se aplica, o elige “Todas las gasolineras”.'; err.hidden = false; return; }
      if (!valor || valor <= 0 || (tipo === 'pct' && valor > 30) || (tipo === 'cent' && valor > 50)) {
        err.textContent = tipo === 'pct' ? 'Pon un porcentaje entre 0,1 y 30.' : 'Pon los céntimos por litro, entre 0,1 y 50.';
        err.hidden = false;
        return;
      }
      estado.descuentos.push({
        id: Date.now().toString(36),
        marca: /^todas/i.test(marcaTxt) ? '*' : marcaTxt.toUpperCase(),
        tipo,
        valor,
        nombre: $('#rgNombre').value.trim().slice(0, 40),
      });
      guardarLocal('gm.descuentos', estado.descuentos);
      if (estado.descuentos.length === 1) {
        estado.verDescuento = true;
        guardarLocal('gm.verDescuento', true);
      }
      refrescar();
      pintarMiCoche();
      avisar('Descuento añadido');
    });
    $$('[data-borrar-regla]', el).forEach((b) =>
      b.addEventListener('click', () => {
        estado.descuentos = estado.descuentos.filter((g) => g.id !== b.dataset.borrarRegla);
        guardarLocal('gm.descuentos', estado.descuentos);
        refrescar();
        pintarMiCoche();
      })
    );

    // Datos del coche
    const guardarAjustes = () => {
      const litros = decimal($('#mcLitros').value);
      const consumo = decimal($('#mcConsumo').value);
      if (litros > 0) estado.ajustes.litros = litros;
      if (consumo > 0) estado.ajustes.consumo = consumo;
      guardarLocal('gm.ajustes', estado.ajustes);
    };
    $('#mcLitros').addEventListener('change', guardarAjustes);
    $('#mcConsumo').addEventListener('change', guardarAjustes);
    $('#usarReal')?.addEventListener('click', () => {
      const an = MiCoche.analizarDiario(diarioDelCocheActivo());
      estado.ajustes.consumo = Math.round(an.consumoMedio * 10) / 10;
      guardarLocal('gm.ajustes', estado.ajustes);
      pintarMiCoche();
      avisar('La calculadora usará tu consumo real');
    });

    // Accesos a Mis repostajes
    $('#irApuntar')?.addEventListener('click', () => {
      cambiarPestana('repostajes');
      const d = $('#nuevoRepostaje');
      if (d) d.open = true;
      $('#dLitros')?.focus();
    });
    $('#irRepostajes')?.addEventListener('click', () => cambiarPestana('repostajes'));
  }

  function activarRepostajes() {
    const el = $('#vRepostajes');

    // Diario: el importe se calcula solo hasta que lo escribas tú
    importeManual = false;
    const sugerirImporte = () => {
      if (importeManual) return;
      const e = estado.porId.get($('#dEstacion').value);
      const litros = decimal($('#dLitros').value);
      const c = $('#dComb').value;
      if (!e || !litros || base(e, c) == null) return;
      const d = ahorroDe(e, c);
      const pl = base(e, c) - (d ? d.ahorro : 0); // lo que pagas de verdad
      $('#dImporte').value = (litros * pl).toFixed(2).replace('.', ',');
    };
    $('#dImporte').addEventListener('input', () => (importeManual = $('#dImporte').value.trim() !== ''));
    ['#dLitros', '#dEstacion', '#dComb'].forEach((s) => $(s).addEventListener('input', sugerirImporte));

    $('#fDiario').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('#dError');
      err.hidden = true;
      const fecha = $('#dFecha').value || hoyISO();
      const litros = decimal($('#dLitros').value);
      const importe = decimal($('#dImporte').value);
      const km = decimal($('#dKm').value);
      const fallo = (m) => { err.textContent = m; err.hidden = false; };
      if (!litros || litros <= 0 || litros > 300) return fallo('Indica los litros que echaste (por ejemplo, 40,5).');
      if (importe != null && (importe < 0 || importe > 1000)) return fallo('El importe no parece correcto.');
      if (km != null && (km < 0 || km > 3000000)) return fallo('Los kilómetros no parecen correctos.');
      if (km) {
        // Los km no pueden bajar respecto a un repostaje anterior en fecha
        const previo = estado.diario.filter((x) => x.km && x.fecha <= fecha).sort((a, b) => b.km - a.km)[0];
        if (previo && km < previo.km && previo.fecha < fecha) return fallo(`El cuentakilómetros es menor que el del ${fechaCorta(previo.fecha)} (${previo.km.toLocaleString('es-ES')} km).`);
      }
      const est = estado.porId.get($('#dEstacion').value);
      const idNuevo = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const entrada = {
        id: idNuevo,
        fecha,
        estacion: est ? est.id : null,
        nombre: est ? nombreEstacion(est) : '',
        combustible: $('#dComb').value,
        litros,
        importe: importe ?? null,
        km: km ? Math.round(km) : null,
        lleno: $('#dLleno').checked,
        ...($('#dCoche')?.value ? { coche: $('#dCoche').value } : {}),
        ...($('#dEmpresa')?.checked ? { empresa: true } : {}),
      };
      // La foto del ticket, si la hay, se guarda con el repostaje
      let msgFoto = '';
      if (fotoNueva) {
        try {
          const r = await GasoFotos.guardar(idNuevo, fotoNueva);
          entrada.foto = idNuevo;
          if (window.Cuenta?.usuario() && !r.enCuenta) msgFoto = ' (la foto se ha guardado solo en este dispositivo)';
        } catch {
          msgFoto = ' (no se pudo guardar la foto)';
        }
        fotoNueva = null;
      }
      estado.diario.push(entrada);
      guardarLocal('gm.diario', estado.diario);
      // Si es de empresa, se comparte con ella
      const veh = $('#dVehiculo')?.value;
      let msg = 'Repostaje guardado';
      if ($('#dEmpresa')?.checked && veh) {
        const [flota, vehiculo] = veh.split('|');
        try {
          await api('/api/flotas/repostajes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              flota, vehiculo, estacion: est ? est.id : null, nombreEstacion: est ? nombreEstacion(est) : '', fecha,
              hora: new Date().toTimeString().slice(0, 5), combustible: $('#dComb').value, litros, importe, km: km ? Math.round(km) : null, lleno: $('#dLleno').checked,
            }),
          });
          msg = 'Repostaje guardado y enviado a tu empresa';
        } catch (x) {
          msg = 'Guardado en tu diario, pero no se pudo enviar a la empresa: ' + x.message;
        }
      }
      pintarRepostajes();
      avisar(msg + msgFoto, 4500);
      $(`[data-entrada="${idNuevo}"]`)?.scrollIntoView({ block: 'center' });
    });

    $$('[data-borrar-entrada]', el).forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.paso !== 'confirmar') {
          b.dataset.paso = 'confirmar';
          b.textContent = 'Confirmar borrado';
          return;
        }
        const x = estado.diario.find((y) => y.id === b.dataset.borrarEntrada);
        if (x?.foto) GasoFotos.borrar(x.foto);
        estado.diario = estado.diario.filter((y) => y.id !== b.dataset.borrarEntrada);
        guardarLocal('gm.diario', estado.diario);
        pintarRepostajes();
      })
    );

    $('#exportar')?.addEventListener('click', () => {
      try {
        const blob = new Blob([MiCoche.csvDiario(estado.diario, NOMBRES)], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `repostajes-${hoyISO()}.csv`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch {
        avisar('No se pudo exportar en este dispositivo.');
      }
    });

    // Foto del ticket en el formulario: se lee para rellenar los datos
    $('#dFoto').addEventListener('change', async (ev) => {
      const f = ev.target.files[0];
      const estadoF = $('#dFotoEstado');
      fotoNueva = f || null;
      if (!f) return;
      estadoF.className = 'texto-ayuda';
      const est = estado.porId.get($('#dEstacion').value) || { rotulo: '', cp: '', localidad: '' };
      try {
        const r = await GasoTicket.leerFoto(f, est, (p, t) => (estadoF.textContent = `${t} ${p ? p + ' %' : ''}`));
        const d = r.datos;
        const rellenos = [];
        if (d.fecha && d.fecha <= hoyISO()) { $('#dFecha').value = d.fecha; rellenos.push('fecha'); }
        if (d.litros) { $('#dLitros').value = String(d.litros).replace('.', ','); rellenos.push('litros'); }
        if (d.importe) { $('#dImporte').value = d.importe.toFixed(2).replace('.', ','); importeManual = true; rellenos.push('importe'); }
        estadoF.innerHTML = rellenos.length
          ? `<span class="ok">✓ Foto lista. Hemos rellenado ${rellenos.join(', ')}: revísalo antes de guardar.</span>`
          : 'Foto lista. No se pudieron leer los datos: rellénalos a mano.';
      } catch {
        estadoF.textContent = 'Foto lista. No se pudo leer el ticket: rellena los datos a mano.';
      }
    });

    // Ver la foto en grande
    $$('[data-foto]', el).forEach((b) => b.addEventListener('click', () => {
      const x = estado.diario.find((y) => y.id === b.dataset.foto);
      if (x?.foto) GasoFotos.ver(x.foto, `Ticket del ${new Date(x.fecha + 'T12:00:00').toLocaleDateString('es-ES')}`);
    }));
    // Añadir o cambiar la foto de un repostaje ya apuntado
    $$('[data-subir]', el).forEach((inp) => inp.addEventListener('change', async () => {
      const f = inp.files[0];
      const x = estado.diario.find((y) => y.id === inp.dataset.subir);
      if (!f || !x) return;
      try {
        const r = await GasoFotos.guardar(x.id, f);
        x.foto = x.id;
        guardarLocal('gm.diario', estado.diario);
        pintarRepostajes();
        avisar(window.Cuenta?.usuario() && !r.enCuenta ? 'Foto guardada en este dispositivo (no se pudo subir a tu cuenta)' : 'Foto del ticket guardada');
      } catch {
        avisar('No se pudo guardar la foto.');
      }
    }));
  }

  /* ---------- GasoCheck Empresas: el conductor ---------- */
  let misFlotas = [];
  async function pintarMiEmpresa() {
    const u = window.Cuenta?.usuario();
    const caja = $('#dEmpresaCaja');
    const bloque = $('#bloqueEmpresa');
    if (!u || u.rol !== 'usuario') {
      if (bloque) bloque.hidden = true;
      return;
    }
    try {
      misFlotas = (await api('/api/flotas')).flotas;
    } catch {
      misFlotas = [];
    }
    if (caja && misFlotas.length) {
      const opciones = misFlotas.flatMap((f) => f.vehiculos.map((v) => `<option value="${esc(f.id)}|${esc(v.id)}">${esc(v.matricula)}${v.nombre ? ' · ' + esc(v.nombre) : ''}${misFlotas.length > 1 ? ' (' + esc(f.nombre) + ')' : ''}</option>`)).join('');
      caja.innerHTML = `<label class="check"><input type="checkbox" id="dEmpresa"> Repostaje de empresa (se envía a ${esc(misFlotas.map((f) => f.nombre).join(', '))})</label>
        <label for="dVehiculo" id="dVehiculoCaja" hidden>Vehículo<select id="dVehiculo">${opciones}</select></label>`;
      $('#dEmpresa').addEventListener('change', (ev) => ($('#dVehiculoCaja').hidden = !ev.target.checked));
    }
    if (!bloque) return;
    bloque.hidden = false;
    bloque.innerHTML = `<h3>Mi empresa</h3>${
      misFlotas.length
        ? `<ul class="reglas">${misFlotas.map((f) => `<li><span><b>${esc(f.nombre)}</b> · ${f.vehiculos.length} vehículos</span><button type="button" class="enlace texto-peligro" data-salir="${esc(f.id)}">Salir</button></li>`).join('')}</ul>
           <p class="texto-ayuda">Al apuntar un repostaje, marca “Repostaje de empresa” para enviarlo. Los demás no se comparten.</p>`
        : `<p class="texto-ayuda">Si tu empresa usa GasoCheck Empresas, únete con el código que te den. Solo compartirás los repostajes que marques como de empresa.</p>
           <form class="form-linea" id="fUnirse" novalidate><label for="cEmpresa">Código de la empresa<input id="cEmpresa" autocomplete="off" maxlength="12" placeholder="Ej.: K7P2XQ9M"></label><button class="boton primario" type="submit">Unirme</button></form><p class="error" id="eUnirse" hidden></p>`
    }`;
    $('#fUnirse')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const r = await api('/api/flotas/unirse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: $('#cEmpresa').value }) });
        avisar(`Te has unido a ${r.flota.nombre}`);
        pintarMiCoche();
      } catch (x) {
        $('#eUnirse').textContent = x.message;
        $('#eUnirse').hidden = false;
      }
    });
    bloque.querySelectorAll('[data-salir]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (b.dataset.paso !== 'ok') {
          b.dataset.paso = 'ok';
          b.textContent = '¿Seguro? Pulsa para salir';
          return;
        }
        await api('/api/flotas/' + encodeURIComponent(b.dataset.salir), { method: 'DELETE' }).catch(() => {});
        pintarMiCoche();
      })
    );
  }

  // Desde la ficha: abre el formulario con la gasolinera y el combustible ya elegidos
  function prepararRepostaje(e) {
    if (estado.pestana !== 'repostajes') cambiarPestana('repostajes');
    if (!$('#fDiario')) pintarRepostajes(true);
    $('#nuevoRepostaje').open = true;
    $('#dEstacion').innerHTML = opcionesEstacion(e.id);
    $('#dComb').value = estado.combustible;
    $('#dLitros').value = '';
    $('#dImporte').value = '';
    importeManual = false;
    $('#nuevoRepostaje').scrollIntoView({ block: 'start' });
    $('#dLitros').focus({ preventScroll: true });
  }

  /* ---------- Modo sin conexión (PWA) ---------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('offline', () => avisar('Sin conexión: verás los últimos precios guardados.', 5000));

  /* ---------- Cuenta y sincronización ---------- */
  function datosLocales() {
    return {
      favoritas: [...estado.favoritas],
      descuentos: estado.descuentos,
      diario: estado.diario,
      ajustes: estado.ajustes,
    };
  }
  function aplicarRemoto(d) {
    // Si no ha cambiado nada, no se repinta (así no se pierde lo que estés escribiendo)
    const nuevo = { favoritas: d.favoritas || [], descuentos: d.descuentos || [], diario: d.diario || [], ajustes: MiCoche.migrarAjustes({ litros: 50, consumo: 6.5, ...(d.ajustes || {}) }, nuevoIdCoche) };
    if (JSON.stringify(nuevo) === JSON.stringify(datosLocales())) return;
    estado.favoritas = new Set(d.favoritas || []);
    estado.descuentos = d.descuentos || [];
    estado.diario = d.diario || [];
    estado.ajustes = MiCoche.migrarAjustes({ litros: 50, consumo: 6.5, ...(d.ajustes || {}) }, nuevoIdCoche);
    guardarLocal('gm.favoritas', [...estado.favoritas], { sinSync: true });
    guardarLocal('gm.descuentos', estado.descuentos, { sinSync: true });
    guardarLocal('gm.diario', estado.diario, { sinSync: true });
    guardarLocal('gm.ajustes', estado.ajustes, { sinSync: true });
    if (estado.estaciones.length) refrescar();
    pintarFavoritas();
    if (estado.pestana === 'micoche') pintarMiCoche();
    if (estado.pestana === 'repostajes') pintarRepostajes();
    window.Cuenta?.refrescarFotoPerfil?.(); // la foto de perfil pudo cambiar en otro dispositivo
  }
  // Al cerrar sesión o entrar con otra cuenta, los datos de la anterior no pasan a la nueva
  function vaciarLocal() {
    aplicarRemoto({ favoritas: [], descuentos: [], diario: [], ajustes: {} });
    filtroCocheRepos = null;
    window.GasoFotos?.vaciar();
    if (estado.pestana === 'micoche') pintarMiCoche();
  }
  Cuenta.init({
    avisar,
    vaciarLocal,
    // El avatar abre un menú: Mi cuenta, Estadísticas de precios, Avisos…
    alPulsarBoton: () => (menuCuenta.hidden ? abrirMenuCuenta() : cerrarMenuCuenta()),
    abrirGasolinera: (id) => abrirFicha(id),
    alCambiarValoracion: (id, resumen) => {
      actualizarCalidad(id, resumen);
      if (estado.sel === id) cargarReportes(id);
    },
    obtenerLocal: datosLocales,
    aplicarRemoto,
    alCambiarSesion: () => {
      pintarFavoritas();
      if (estado.pestana === 'micoche') pintarMiCoche();
      if (estado.pestana === 'repostajes') pintarRepostajes();
      // El formulario de valoración depende de quién eres
      if (estado.sel) abrirFicha(estado.sel, { sinMover: true });
    },
  });

  // Para los módulos de ruta, tickets y avisos
  window.GasoApp = {
    // Al cerrar la cuenta se vuelve a la sección que estaba abierta
    alCerrarCuenta() {
      if (estado.pestana === 'micoche') pintarMiCoche(); // se vació al abrir la cuenta
      if (estado.pestana === 'repostajes') pintarRepostajes();
      const completa = estado.pestana === 'repostajes' || estado.pestana === 'micoche';
      if (!completa && document.body.classList.contains('pagina-completa')) {
        document.body.classList.remove('pagina-completa');
        setTimeout(() => mapa.invalidateSize(), 0);
      }
    },
    mapa, estado, precio, base, abrirFicha, avisar, hoja, NOMBRES, norm, euros, esc, distanciaKm,
    cambiarPestana, guardarLocal, pintarMiCoche: () => pintarMiCoche(), localizar: () => localizar(),
    nombreEstacion: (e) => `${e.rotulo} · ${e.localidad}`,
    // Coche y mediciones de consumo (se guardan en los ajustes, que se sincronizan con la cuenta)
    ajustes: () => estado.ajustes,
    guardarAjustes(cambios) {
      estado.ajustes = { ...estado.ajustes, ...cambios };
      guardarLocal('gm.ajustes', estado.ajustes);
    },
    elegirCombustible(c) {
      $(`.combustibles [data-c="${c}"]`)?.click();
    },
  };

  window.Cuenta?.repintarBoton?.(); // con la foto de perfil, ahora que GasoApp existe

  // Accesos directos del icono de la app: ?accion=cerca | ruta | micoche | avisos
  function accionInicial() {
    const a = new URLSearchParams(location.search).get('accion');
    if (!a) return;
    history.replaceState(null, '', location.pathname + location.hash);
    if (a === 'cerca') localizar();
    else if (a === 'ruta') cambiarPestana('gps');
    else if (a === 'micoche') cambiarPestana('micoche');
    else if (a === 'repostajes') cambiarPestana('repostajes');
    else if (a === 'avisos') setTimeout(() => window.GasoAvisos?.abrir(), 800);
  }

  if (!localStorage.getItem('gm.token') && (estado.favoritas.size || estado.diario.length || estado.descuentos.length || GasoCoches.lista().length)) {
    vaciarLocal();
  }
  // Aviso de cookies y almacenamiento: se enseña la primera vez (y si cambia el texto)
  (() => {
    const VERSION_COOKIES = '2026-10-08';
    const caja = $('#avisoCookies');
    if (!caja || leer('gm.cookies', null) === VERSION_COOKIES) return;
    caja.hidden = false;
    $('#bCookies').addEventListener('click', () => {
      try { localStorage.setItem('gm.cookies', JSON.stringify(VERSION_COOKIES)); } catch { /* sin almacenamiento */ }
      caja.hidden = true;
    });
  })();
  pintarFavoritas();
  pintarInterruptorPrecio();
  cargar().then(accionInicial);
})();
