/* GasoCheck — pestaña GPS.
   Navegador por carretera dentro de la app con cuatro formas de ir:
   - Ruta normal: la más rápida (como Google Maps).
   - Ruta eficiente: la que menos combustible gasta (según la velocidad de cada tramo y tu consumo).
   - Gasolina barata: la ruta normal parando en la gasolinera más barata del camino sin desviarse demasiado.
   - Eficiente + barata: la ruta eficiente con esa misma parada.
   Rutas: OSRM (servidor configurable en config.js con GASOCHECK_RUTAS). Direcciones: Photon (OpenStreetMap).
   Navegación: posición GPS en tiempo real, indicaciones giro a giro con voz, recálculo si te sales de la ruta. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const SERVIDOR = (window.GASOCHECK_RUTAS || 'https://router.project-osrm.org').replace(/\/$/, '');
  const GEOCODER = (window.GASOCHECK_GEOCODER || 'https://photon.komoot.io').replace(/\/$/, '');
  const BBOX_ESPANA = '-18.6,27.4,4.6,44.2';
  const RAD = Math.PI / 180;

  const MODOS = {
    normal: { titulo: 'Ruta normal', sub: 'La más rápida', ico: '<path d="M5 19L19 5M19 5h-7M19 5v7"/>' },
    corta: { titulo: 'Más corta', sub: 'Menos kilómetros', ico: '<path d="M3 15l12-12 6 6L9 21z"/><path d="M7 11l2 2M10 8l2 2M13 5l2 2"/>' },
    eficiente: { titulo: 'Ruta eficiente', sub: 'Menos combustible', ico: '<path d="M6 18c0-7 5-12 13-12 0 8-5 13-12 13"/><path d="M6 18l6-6"/>' },
    barata: { titulo: 'Gasolina barata', sub: 'Para en la más barata', ico: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.5"/>' },
    combinada: { titulo: 'Eficiente + barata', sub: 'Menos gasto total', ico: '<path d="M6 18c0-7 5-12 13-12 0 8-5 13-12 13"/><path d="M14 15l2.5 2.5L21 13"/>' },
  };

  const A = () => window.GasoApp;
  // Modo desarrollo: muestra herramientas de prueba (como «Simular»). Se activa abriendo la web con ?dev=1
  // (se recuerda en este navegador) y se quita con ?dev=0. En tu ordenador (localhost) está siempre activo.
  const DEV = (() => {
    try {
      const q = new URLSearchParams(location.search).get('dev');
      if (q === '1') localStorage.setItem('gm.dev', '1');
      if (q === '0') localStorage.removeItem('gm.dev');
      return localStorage.getItem('gm.dev') === '1' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    } catch {
      return false;
    }
  })();
  const st = {
    origen: null, // { nombre, lat, lng, yo? }
    destino: null,
    modo: leer('gm.gps.modo', 'normal'),
    opciones: (() => {
      const o = { desvio: 3, litros: null, evitar: '', deposito: '', llegada: '', letraGrande: false, nocheAuto: true, ...leer('gm.gps.opciones', {}) };
      if (o.peajes && !o.evitar) o.evitar = 'toll'; // versión anterior
      delete o.peajes;
      return o;
    })(),
    via: null, // parada intermedia elegida por el usuario
    calc: null, // { normal, eficiente, barata, combinada, mediaPrecio }
    token: 0,
    capa: null,
    nav: null,
  };
  const cacheRutas = new Map();

  function leer(k, def) {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v == null ? def : v;
    } catch {
      return def;
    }
  }
  function guardar(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* sin almacenamiento */
    }
  }

  /* ---------------- Utilidades ---------------- */
  const kmEntre = (a, b) => {
    const x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * RAD);
    const y = b[0] - a[0];
    return Math.sqrt(x * x + y * y) * 111.32;
  };
  const fmtDist = (km) => (km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m` : `${(km < 10 ? km.toFixed(1) : Math.round(km)).toString().replace('.', ',')} km`);
  const fmtMin = (min) => {
    const m = Math.max(1, Math.round(min));
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
  };
  const fmtHora = (d) => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const fmtL = (l) => `${l.toFixed(1).replace('.', ',')} L`;
  const eur = (n, d = 2) => n.toFixed(d).replace('.', ',');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Consumo relativo según la velocidad media del tramo (1 ≈ conducción mixta a 80 km/h).
  // Mínimo hacia 55–65 km/h; sube en ciudad (arranques) y en autopista (resistencia del aire).
  function relativo(v) {
    v = Math.min(140, Math.max(6, v));
    return 0.55 + 15 / v + 0.00004 * v * v;
  }

  function consumoBase() {
    const a = A().estado.ajustes;
    const coche = (a.coches || []).find((c) => c.id === a.cocheActivo);
    const medio = coche && window.MiCoche?.consumoMedio ? window.MiCoche.consumoMedio(coche.mediciones) : null;
    const v = Number(medio) > 2 ? Number(medio) : Number(a.consumo) || 6.5;
    return Math.round(v * 10) / 10;
  }

  /* ---------------- Rutas (OSRM) ---------------- */
  function prepararRuta(r, extra = {}) {
    const linea = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const pasos = [];
    r.legs.forEach((leg, li) => leg.steps.forEach((s) => pasos.push({ ...s, tramo: li, ultimoTramo: li === r.legs.length - 1 })));
    // Combustible estimado tramo a tramo
    const base = consumoBase();
    let litros = 0;
    for (const leg of r.legs) {
      const d = leg.annotation?.distance || [];
      const t = leg.annotation?.duration || [];
      for (let i = 0; i < d.length; i++) {
        if (!(d[i] > 0)) continue;
        const v = t[i] > 0 ? (d[i] / t[i]) * 3.6 : 50;
        litros += (d[i] / 1000) * (base / 100) * relativo(v);
      }
    }
    if (!litros) litros = (r.distance / 1000) * (base / 100) * relativo((r.distance / Math.max(1, r.duration)) * 3.6);
    // Límite de velocidad de cada tramo (si el servidor lo da): km/h o null
    const limites = [];
    for (const leg of r.legs) for (const m of leg.annotation?.maxspeed || []) limites.push(m && m.speed && !m.unknown && !m.none ? (m.unit === 'mph' ? Math.round(m.speed * 1.609) : m.speed) : null);
    // Cada giro, rotonda o stop: frenar y volver a acelerar
    litros += pasos.filter((p) => ['turn', 'end of road', 'roundabout', 'rotary', 'roundabout turn'].includes(p.maneuver.type)).length * 0.006 * (base / 6.5);
    return { linea, km: r.distance / 1000, min: r.duration / 60, pasos, litros, limites: limites.some(Boolean) ? limites : null, ...extra };
  }

  async function osrm(puntos, { alternativas = false, excluir = '', rumbo = null } = {}) {
    const coords = puntos.map((p) => `${(+p.lng).toFixed(6)},${(+p.lat).toFixed(6)}`).join(';');
    // Con rumbo, la ruta sale en el sentido en que ya vas (no te manda dar la vuelta si no hace falta)
    const bearings = rumbo != null && Number.isFinite(rumbo) ? '&bearings=' + [`${Math.round((rumbo + 360) % 360)},60`, ...puntos.slice(1).map(() => '')].join(';') : '';
    const base = `${SERVIDOR}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true${alternativas && puntos.length === 2 ? '&alternatives=3' : ''}${excluir ? '&exclude=' + excluir : ''}${bearings}`;
    // Límites de velocidad: solo si el servidor los admite (el público de OSRM no siempre)
    const conLimites = leer('gm.gps.limites', true) !== false;
    const url = base + (conLimites ? '&annotations=distance,duration,maxspeed' : '&annotations=distance,duration');
    if (cacheRutas.has(url)) return cacheRutas.get(url);
    const p = (async () => {
      const pedir = async (u) => {
        const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
        return r.json().catch(() => ({}));
      };
      let d = await pedir(url);
      // Si el servidor no entiende «maxspeed», se repite sin límites y se recuerda para la próxima vez
      if (conLimites && d.code !== 'Ok' && (d.code === 'InvalidQuery' || /malformed|annotation|maxspeed/i.test(d.message || ''))) {
        guardar('gm.gps.limites', false);
        d = await pedir(base + '&annotations=distance,duration');
      }
      if (d.code !== 'Ok' || !d.routes?.length) throw new Error(d.code === 'InvalidValue' && excluir ? 'el servidor de rutas no permite esa opción de «Evitar». Prueba con otra.' : d.message || 'No hay ruta por carretera entre esos puntos.');
      return d.routes.map((x) => prepararRuta(x, { excluir }));
    })();
    cacheRutas.set(url, p);
    p.catch(() => cacheRutas.delete(url));
    return p;
  }

  const puntosRuta = (...medio) => [st.origen, ...medio, st.destino].filter(Boolean);
  // Km de la ruta en los que queda un punto
  function kmEnRuta(linea, p) {
    let acum = 0, mejor = { d: Infinity, km: 0 };
    for (let i = 1; i < linea.length; i++) {
      const seg = kmEntre(linea[i - 1], linea[i]);
      const d = kmEntre(linea[i], [p.lat, p.lng]);
      if (d < mejor.d) mejor = { d, km: acum + seg };
      acum += seg;
    }
    return mejor.km;
  }
  const parecidas = (a, b) => Math.abs(a.km - b.km) < 0.3 && Math.abs(a.min - b.min) < 1;

  // Gasolineras del camino ordenadas por lo que cuesta repostar en ellas (precio + desvío)
  function paradasEn(ruta) {
    const app = A();
    const c = app.estado.combustible;
    const litros = litrosRepostar();
    const r = window.GasoRuta.paradas(ruta.linea, app.estado.estaciones.filter((e) => e.venta === 'publico'), {
      maxDesvioKm: st.opciones.desvio,
      litros,
      consumo: consumoBase(),
      // Con tus descuentos (tarjetas, apps) si tienes alguno: la más barata para ti
      precioDe: (e) => (app.tieneDescuentos?.() ? app.precioConDto(e, c) : app.precio(e, c)),
      n: 400,
    });
    // No sirven las que están en la misma salida o justo en el destino
    const lista = r.paradas.filter((p) => p.kmDesdeOrigen >= 0.5 && p.kmDesdeOrigen <= r.total - 0.3);
    const media = lista.length ? lista.reduce((s, p) => s + p.precio, 0) / lista.length : null;
    return { lista, media };
  }

  const litrosRepostar = () => {
    const v = parseFloat(String(st.opciones.litros ?? '').replace(',', '.'));
    return v > 0 ? v : Number(A().estado.ajustes.litros) || 50;
  };

  // Ruta pasando por la gasolinera más barata (comprueba con la ruta real que el desvío no se dispare)
  async function conParada(base, info) {
    if (!info.lista.length) return null;
    const litros = litrosRepostar();
    const maxExtraKm = Math.max(2, st.opciones.desvio * 2.5);
    let mejor = null;
    for (const p of info.lista.slice(0, 3)) {
      let ruta;
      try {
        const est = { lat: p.e.lat, lng: p.e.lng };
        const medio = !st.via ? [est] : p.kmDesdeOrigen < kmEnRuta(base.linea, st.via) ? [est, st.via] : [st.via, est];
        [ruta] = await osrm(puntosRuta(...medio), { excluir: base.excluir });
      } catch {
        continue;
      }
      const extraKm = ruta.km - base.km;
      if (extraKm > maxExtraKm) continue;
      const extraL = Math.max(0, ruta.litros - base.litros);
      const coste = litros * p.precio + extraL * p.precio;
      const ahorro = info.media != null ? litros * info.media - coste : null;
      if (!mejor || coste < mejor.parada.coste) mejor = { ...ruta, parada: { e: p.e, precio: p.precio, coste, extraKm: Math.max(0, extraKm), extraMin: Math.max(0, ruta.min - base.min), ahorro } };
      if (mejor && p === info.lista[0]) break; // la primera ya cumple: es la más barata
    }
    return mejor;
  }

  // Posición actual del GPS (rápida: acepta una de hace poco)
  function posicionActual({ edad = 30000, espera = 6000 } = {}) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition((p) => resolve(p), () => resolve(null), { enableHighAccuracy: true, maximumAge: edad, timeout: espera });
    });
  }

  async function calcular() {
    const token = ++st.token;
    const res = $('#gRes');
    if (!st.origen || !st.destino) return;
    // «Mi ubicación» siempre desde donde estás ahora, no desde donde estabas al abrir la app
    if (st.origen.yo) {
      res.innerHTML = '<p class="gps-cargando"><span class="gps-spin"></span>Buscando tu posición…</p>';
      const p = await posicionActual();
      if (token !== st.token) return;
      if (p) {
        st.origen = { ...st.origen, lat: p.coords.latitude, lng: p.coords.longitude };
        A().estado.yo = { lat: p.coords.latitude, lng: p.coords.longitude };
      }
    }
    guardar('gm.gps.ultimo', { origen: st.origen.yo ? null : st.origen, destino: st.destino, via: st.via });
    guardarReciente(st.destino);
    res.innerHTML = '<p class="gps-cargando"><span class="gps-spin"></span>Calculando rutas…</p>';
    st.calc = null;
    if ($('#gExtrasRes')) $('#gExtrasRes').innerHTML = '';
    pintarAcciones();
    limpiarMapa();
    try {
      const evitar = st.opciones.evitar || '';
      const pts = puntosRuta(st.via);
      const rapidas = await osrm(pts, { alternativas: true, excluir: evitar });
      if (token !== st.token) return;
      const candidatas = [...rapidas];
      // Una alternativa más sin autopistas (a menudo gasta menos aunque tarde algo más)
      if (!evitar) {
        try {
          for (const r of await osrm(pts, { excluir: 'motorway' })) if (!candidatas.some((c) => parecidas(c, r))) candidatas.push(r);
        } catch {
          /* el servidor no permite excluir autopistas: se sigue con las demás */
        }
      }
      if (token !== st.token) return;
      const normal = rapidas[0];
      const precioRef = paradasEn(normal).media || null;
      // Eficiente: la de menos combustible sin tardar más de un 35 % que la rápida
      const eficiente = candidatas.filter((r) => r.min <= normal.min * 1.35).reduce((a, b) => (b.litros < a.litros ? b : a), normal);
      // Más corta: la de menos kilómetros sin tardar más de un 50 % que la rápida
      const corta = candidatas.filter((r) => r.min <= normal.min * 1.5).reduce((a, b) => (b.km < a.km - 0.05 ? b : a), normal);
      st.calc = { normal, corta, eficiente, barata: undefined, combinada: undefined, precioRef, alternativas: candidatas, cercanas: paradasEn(normal).lista };
      cargarIncidentes(normal.linea);
      pintarFavs();
      pintarResultados();
      // Las dos con parada (necesitan más rutas)
      const infoN = paradasEn(normal);
      st.calc.barata = (await conParada(normal, infoN)) || null;
      if (token !== st.token) return;
      pintarResultados();
      st.calc.combinada = eficiente === normal ? st.calc.barata && { ...st.calc.barata } : (await conParada(eficiente, paradasEn(eficiente))) || null;
      if (token !== st.token) return;
      pintarResultados();
    } catch (e) {
      if (token !== st.token) return;
      res.innerHTML = `<p class="texto-peligro gps-error">No se pudo calcular la ruta: ${esc(e.name === 'TimeoutError' ? 'el servidor de rutas no responde. Inténtalo de nuevo en un momento.' : e.message)}</p>`;
    }
  }

  /* ---------------- Mapa ---------------- */
  function limpiarMapa() {
    if (st.capa) A().mapa.removeLayer(st.capa);
    st.capa = null;
  }

  function pin(clase, html = '') {
    return L.divIcon({ className: '', html: `<div class="gps-pin ${clase}">${html}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
  }

  // Capas propias: las gasolineras quedan por DEBAJO de la línea de la ruta (nunca la tapan),
  // y los marcadores importantes (salida, destino, parada, incidentes) por encima
  function panes() {
    const m = A().mapa;
    if (m.getPane('gpsAlt')) return;
    m.createPane('gpsAlt').style.zIndex = 405;
    m.createPane('gpsEst').style.zIndex = 420;
    m.createPane('gpsRuta').style.zIndex = 430;
    m.createPane('gpsTop').style.zIndex = 650;
  }

  // Lado (en pantalla) en el que queda una gasolinera respecto al punto más cercano de la ruta:
  // su precio se pone hacia fuera para no caer encima de la línea
  function ladoDe(linea, p) {
    let mejor = null, dMin = Infinity;
    const paso = Math.max(1, Math.floor(linea.length / 3000));
    for (let i = 0; i < linea.length; i += paso) {
      const d = kmEntre(linea[i], p);
      if (d < dMin) {
        dMin = d;
        mejor = linea[i];
      }
    }
    return mejor && p[1] < mejor[1] ? 'izq' : 'der';
  }

  function zoomEtiquetas() {
    const m = A().mapa;
    m.getContainer().classList.toggle('gps-cerca', m.getZoom() >= 13);
  }

  function pintarMapa({ encuadrar = true } = {}) {
    const app = A();
    panes();
    limpiarMapa();
    if (!st.calc) return;
    const sel = st.calc[st.modo] || st.calc.normal;
    const g = L.layerGroup();
    const acento = getComputedStyle(document.documentElement).getPropertyValue('--acento').trim() || '#2f7bf6';
    // Otras rutas, en gris (se pueden elegir tocándolas)
    const dibujadas = new Set([sel.linea]);
    for (const m of Object.keys(MODOS)) {
      const r = st.calc[m];
      if (!r || dibujadas.has(r.linea)) continue;
      dibujadas.add(r.linea);
      L.polyline(r.linea, { color: '#7b8aa6', weight: 6, opacity: 0.55, pane: 'gpsAlt' })
        .on('click', () => elegirModo(m))
        .bindTooltip(MODOS[m].titulo, { sticky: true })
        .addTo(g);
    }
    L.polyline(sel.linea, { color: '#0b2a63', weight: 10, opacity: 0.9, pane: 'gpsRuta', interactive: false }).addTo(g);
    L.polyline(sel.linea, { color: acento, weight: 6, opacity: 1, pane: 'gpsRuta', interactive: false }).addTo(g);
    L.marker([st.origen.lat, st.origen.lng], { icon: pin('origen'), interactive: false, pane: 'gpsTop' }).addTo(g);
    if (st.via) L.marker([st.via.lat, st.via.lng], { icon: pin('via'), pane: 'gpsTop' }).bindTooltip(esc(st.via.nombre)).addTo(g);
    L.marker([st.destino.lat, st.destino.lng], { icon: pin('destino', '<svg viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2 4 2 4H6"/></svg>'), pane: 'gpsTop' }).bindTooltip(esc(st.destino.nombre)).addTo(g);
    // Gasolineras alrededor de la ruta normal: un punto de color y el precio al lado (hacia fuera de la ruta).
    // De lejos solo se ven los precios de las más baratas; al acercarte, todos.
    const cercanas = st.calc.cercanas || [];
    if (cercanas.length) {
      const orden = cercanas.map((p) => p.precio).sort((a, b) => a - b);
      const corte = (q) => orden[Math.min(orden.length - 1, Math.floor(q * orden.length))];
      const c1 = corte(0.33), c2 = corte(0.66);
      const destacadas = new Set([...cercanas].sort((a, b) => a.precio - b.precio).slice(0, 12).map((p) => p.e.id));
      for (const p of cercanas) {
        if (sel.parada && p.e.id === sel.parada.e.id) continue;
        const t = p.precio <= c1 ? 't-barato' : p.precio >= c2 && orden.length > 2 ? 't-caro' : 't-medio';
        const lado = ladoDe(sel.linea, [p.e.lat, p.e.lng]);
        L.marker([p.e.lat, p.e.lng], {
          pane: 'gpsEst',
          icon: L.divIcon({ className: '', html: `<div class="gps-est ${t} ${lado}${destacadas.has(p.e.id) ? ' destacada' : ''}"><i></i><b>${app.euros(p.precio)}</b></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
          title: `${p.e.rotulo} · ${p.e.localidad} · ${app.euros(p.precio)} €/l`,
        })
          .on('click', () => app.abrirFicha(p.e.id, { sinMover: true }))
          .addTo(g);
      }
    }
    if (sel.parada) {
      const p = sel.parada;
      L.marker([p.e.lat, p.e.lng], { pane: 'gpsTop', icon: L.divIcon({ className: '', html: `<div class="gps-pin parada"><b>⛽ ${app.euros(p.precio)}</b></div>`, iconSize: [80, 30], iconAnchor: [40, 34] }) })
        .on('click', () => app.abrirFicha(p.e.id, { sinMover: true }))
        .addTo(g);
    }
    st.capa = g.addTo(app.mapa);
    app.mapa.off('zoomend', zoomEtiquetas).on('zoomend', zoomEtiquetas);
    zoomEtiquetas();
    if (encuadrar && !st.nav) {
      const movil = matchMedia('(max-width: 760px)').matches;
      app.mapa.fitBounds(L.latLngBounds(sel.linea), { paddingTopLeft: [40, movil ? 90 : 40], paddingBottomRight: [40, movil ? Math.round(innerHeight * 0.5) : 40] });
    }
  }

  /* ---------------- Interfaz de la pestaña ---------------- */
  function plantilla() {
    return `
      <header class="gps-cab">
        <h2 class="titulo-vista">GPS</h2>
        <p class="sub-vista">Elige cómo quieres llegar: la más rápida, la que menos gasta o pasando por la gasolinera más barata.</p>
      </header>
      <div class="gps-puntos">
        <div class="gps-linea" aria-hidden="true"><i class="o"></i><span></span><i class="d"></i></div>
        <div class="gps-campos">
          <div class="gps-campo">
            <label for="gOrigen" class="sr">Origen</label>
            <input id="gOrigen" type="search" autocomplete="off" placeholder="Origen" enterkeyhint="search" aria-controls="gSugO" aria-expanded="false">
            <button type="button" class="gps-yo" id="gYo" title="Usar mi ubicación" aria-label="Usar mi ubicación como origen"><svg aria-hidden="true"><use href="#i-diana"/></svg></button>
            <ul class="sugerencias gps-sug" id="gSugO" role="listbox" hidden></ul>
          </div>
          <div class="gps-campo gps-via" id="gViaCampo" hidden>
            <label for="gVia" class="sr">Parada intermedia</label>
            <input id="gVia" type="search" autocomplete="off" placeholder="Parada intermedia" enterkeyhint="search" aria-controls="gSugV" aria-expanded="false">
            <button type="button" class="gps-yo gps-quitar" id="gViaQuitar" title="Quitar la parada" aria-label="Quitar la parada intermedia">✕</button>
            <ul class="sugerencias gps-sug" id="gSugV" role="listbox" hidden></ul>
          </div>
          <div class="gps-campo">
            <label for="gDestino" class="sr">Destino</label>
            <input id="gDestino" type="search" autocomplete="off" placeholder="¿A dónde vas?" enterkeyhint="search" aria-controls="gSugD" aria-expanded="false">
            <ul class="sugerencias gps-sug" id="gSugD" role="listbox" hidden></ul>
          </div>
        </div>
        <button type="button" class="gps-invertir" id="gInvertir" title="Intercambiar origen y destino" aria-label="Intercambiar origen y destino"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v16M8 4L4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"/></svg></button>
        <button type="button" class="gps-anadir" id="gViaAnadir">+ Añadir parada</button>
      </div>

      <div class="gps-favs" id="gFavs"></div>
      <div class="gps-lugar-ed" id="gLugarEd" hidden>
        <h4 id="gLugarTit">Nuevo lugar</h4>
        <label id="gLugarNombreCaja">Nombre <input id="gLugarNombre" maxlength="30" autocomplete="off" placeholder="Ej.: Gimnasio, casa de mis padres"></label>
        <div class="gps-campo">
          <label for="gLugarDir" class="sr">Dirección</label>
          <input id="gLugarDir" type="search" autocomplete="off" placeholder="Busca la dirección" enterkeyhint="search" aria-controls="gSugL" aria-expanded="false">
          <ul class="sugerencias gps-sug" id="gSugL" role="listbox" hidden></ul>
        </div>
        <p class="texto-ayuda" id="gLugarElegido"></p>
        <div class="gps-lugar-acc">
          <button type="button" class="boton primario" id="gLugarGuardar" disabled>Guardar</button>
          <button type="button" class="boton" id="gLugarCancelar">Cancelar</button>
          <button type="button" class="boton gps-lugar-borrar" id="gLugarBorrar">Borrar</button>
        </div>
      </div>

      <div class="gps-acciones" id="gAcciones">
        <button type="button" class="boton primario gps-iniciar" id="gIniciar" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l7 19-7-4-7 4z"/></svg>Iniciar</button>
        <a class="boton gps-google" id="gGoogle" aria-disabled="true" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>Google Maps</a>
        <button type="button" class="boton gps-simular" id="gSimular"${DEV ? '' : ' hidden'} disabled title="Simular el recorrido sin moverte" aria-label="Simular el recorrido"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg></button>
        <button type="button" class="boton gps-compartir" id="gCompartir" disabled title="Compartir la ruta" aria-label="Compartir la ruta"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg></button>
      </div>

      <div class="gps-modos" role="radiogroup" aria-label="Tipo de ruta">
        ${Object.entries(MODOS)
          .map(([k, m]) => `<button type="button" role="radio" data-modo="${k}" aria-checked="${k === st.modo}"><svg viewBox="0 0 24 24" aria-hidden="true">${m.ico}</svg><b>${m.titulo}</b><small>${m.sub}</small></button>`)
          .join('')}
      </div>


      <div id="gRes" aria-live="polite"></div>
      <div id="gRecientes"></div>

      <div class="gps-extras" id="gExtras">
        <details class="gps-opciones">
          <summary>Opciones de la ruta</summary>
          <div class="gps-opc-grid">
            <label>Desvío máximo para repostar
              <select id="gDesvio">${[1, 3, 5, 10].map((v) => `<option value="${v}"${v === st.opciones.desvio ? ' selected' : ''}>${v} km</option>`).join('')}</select>
            </label>
            <label>Litros a repostar
              <input id="gLitros" inputmode="decimal" placeholder="${A().estado.ajustes.litros}" value="${esc(st.opciones.litros ?? '')}">
            </label>
            <label>Depósito ahora
              <select id="gDeposito">${[['', 'No lo sé'], ['1', 'Lleno'], ['0.75', '3/4'], ['0.5', 'Medio'], ['0.25', '1/4'], ['0.1', 'En reserva']].map(([v, t]) => `<option value="${v}"${v === String(st.opciones.deposito ?? '') ? ' selected' : ''}>${t}</option>`).join('')}</select>
            </label>
            <label>Quiero llegar a las
              <input id="gLlegada" type="time" value="${esc(st.opciones.llegada || '')}">
            </label>
            <label class="gps-evitar">Evitar
              <select id="gEvitar">${[['', 'Nada'], ['toll', 'Peajes'], ['motorway', 'Autopistas y autovías'], ['ferry', 'Ferris']].map(([v, t]) => `<option value="${v}"${v === st.opciones.evitar ? ' selected' : ''}>${t}</option>`).join('')}</select>
            </label>
            <label class="interruptor"><input type="checkbox" id="gLetra"${st.opciones.letraGrande ? ' checked' : ''}><i></i>Letra grande al navegar</label>
            <label class="interruptor"><input type="checkbox" id="gNoche"${st.opciones.nocheAuto !== false ? ' checked' : ''}><i></i>Mapa oscuro de noche (automático)</label>
          </div>
          <p class="texto-ayuda">El gasto se calcula con tu combustible (el que eliges arriba) y el consumo de tu coche: <b id="gConsumo"></b> l/100 km. Cámbialo en <a href="#" id="gMiCoche">Mi coche</a>.</p>
        </details>
        <div id="gExtrasRes"></div>
      </div>`;
  }

  function montar() {
    const v = $('#vGps');
    if (!v || v.dataset.montado) return;
    v.dataset.montado = '1';
    v.innerHTML = plantilla();
    conectarCampo($('#gOrigen'), $('#gSugO'), (l) => {
      st.origen = l;
      if (st.destino) calcular();
      else $('#gDestino').focus();
    });
    conectarCampo($('#gDestino'), $('#gSugD'), (l) => {
      st.destino = l;
      if (!st.origen) usarMiUbicacion();
      else calcular();
    });
    conectarCampo($('#gVia'), $('#gSugV'), (l) => {
      st.via = l;
      if (st.origen && st.destino) calcular();
    });
    $('#gViaAnadir').addEventListener('click', () => {
      $('#gViaCampo').hidden = false;
      $('#gViaAnadir').hidden = true;
      $('#gVia').focus();
    });
    $('#gViaQuitar').addEventListener('click', () => {
      st.via = null;
      $('#gVia').value = '';
      $('#gViaCampo').hidden = true;
      $('#gViaAnadir').hidden = false;
      if (st.origen && st.destino) calcular();
    });
    $('#gCompartir').addEventListener('click', compartirRuta);
    // Editor de lugares guardados
    conectarCampo($('#gLugarDir'), $('#gSugL'), (l) => {
      if (!st.edLugar) return;
      st.edLugar.elegido = { nombre: l.detalle ? `${l.nombre}, ${l.detalle}` : l.nombre, lat: l.lat, lng: l.lng };
      $('#gLugarDir').value = st.edLugar.elegido.nombre;
      pintarElegido();
    });
    $('#gLugarDir').addEventListener('input', () => {
      if (st.edLugar) {
        st.edLugar.elegido = null;
        pintarElegido();
      }
    });
    $('#gLugarGuardar').addEventListener('click', guardarLugar);
    $('#gLugarCancelar').addEventListener('click', cerrarEditorLugar);
    $('#gLugarBorrar').addEventListener('click', borrarLugar);
    $('#gYo').addEventListener('click', () => usarMiUbicacion(true));
    $('#gIniciar').addEventListener('click', () => iniciarNavegacion(false));
    $('#gSimular').addEventListener('click', () => iniciarNavegacion(true));
    $('#gGoogle').addEventListener('click', (ev) => {
      if ($('#gGoogle').getAttribute('aria-disabled') === 'true') ev.preventDefault();
    });
    $('#gInvertir').addEventListener('click', () => {
      if (!st.origen && !st.destino) return;
      [st.origen, st.destino] = [st.destino, st.origen];
      pintarCampos();
      if (st.origen && st.destino) calcular();
    });
    $$('.gps-modos [data-modo]', v).forEach((b) => b.addEventListener('click', () => elegirModo(b.dataset.modo)));
    const opc = (recalcular = true) => {
      st.opciones = {
        desvio: +$('#gDesvio').value,
        litros: $('#gLitros').value.trim() || null,
        evitar: $('#gEvitar').value,
        deposito: $('#gDeposito').value,
        llegada: $('#gLlegada').value,
        letraGrande: $('#gLetra').checked,
        nocheAuto: $('#gNoche').checked,
      };
      guardar('gm.gps.opciones', st.opciones);
      if (!recalcular) return st.calc && pintarResultados({ encuadrar: false });
      if (st.origen && st.destino) calcular();
    };
    $('#gDesvio').addEventListener('change', () => opc());
    $('#gEvitar').addEventListener('change', () => opc());
    $('#gLitros').addEventListener('change', () => opc());
    // Estas no cambian la ruta, solo lo que se muestra
    for (const id of ['#gDeposito', '#gLlegada', '#gLetra', '#gNoche']) $(id).addEventListener('change', () => opc(false));
    $('#gMiCoche').addEventListener('click', (ev) => {
      ev.preventDefault();
      A().cambiarPestana('micoche');
    });
    // Último viaje
    const u = leer('gm.gps.ultimo', null);
    if (u?.destino) st.destino = u.destino;
    if (u?.origen) st.origen = u.origen;
    if (u?.via) st.via = u.via;
    pintarCampos();
    pintarRecientes();
    pintarFavs();
  }

  function pintarCampos() {
    $('#gOrigen').value = st.origen ? st.origen.nombre : '';
    $('#gDestino').value = st.destino ? st.destino.nombre : '';
    $('#gVia').value = st.via ? st.via.nombre : '';
    $('#gViaCampo').hidden = !st.via;
    $('#gViaAnadir').hidden = Boolean(st.via);
    pintarAcciones();
  }

  function elegirModo(m) {
    st.modo = m;
    guardar('gm.gps.modo', m);
    $$('#vGps .gps-modos [data-modo]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.modo === m)));
    if (st.calc) pintarResultados({ encuadrar: false });
    else pintarAcciones();
  }

  function usarMiUbicacion(forzar = false) {
    const app = A();
    const poner = (lat, lng) => {
      st.origen = { nombre: 'Mi ubicación', lat, lng, yo: true };
      pintarCampos();
      if (st.destino) calcular();
    };
    if (app.estado.yo && !forzar) return poner(app.estado.yo.lat, app.estado.yo.lng);
    if (!navigator.geolocation) return app.avisar('Tu navegador no permite obtener la ubicación.');
    app.avisar('Buscando tu ubicación…', 6000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        app.estado.yo = { lat: p.coords.latitude, lng: p.coords.longitude };
        $('#aviso').hidden = true;
        poner(p.coords.latitude, p.coords.longitude);
      },
      () => app.avisar('No se pudo obtener tu ubicación. Activa el permiso de ubicación o escribe el origen.'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  /* ---------- Buscador de direcciones ---------- */
  async function buscarLugares(texto, signal) {
    const app = A();
    const t = app.norm(texto).trim();
    const out = [];
    if (/^mi ubic/.test(t) || t === 'aqui') out.push({ nombre: 'Mi ubicación', detalle: 'Usar tu posición actual', yo: true });
    // Municipios conocidos (instantáneo, sin conexión)
    const loc = app.estado.lugares
      .filter((l) => l.tipo === 'municipio' && l._n.startsWith(t))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((l) => ({ nombre: l.nombre, detalle: l.extra || 'Municipio', lat: (l.nn + l.s) / 2, lng: (l.w + l.ee) / 2 }));
    out.push(...loc);
    if (t.length >= 3) {
      try {
        const yo = app.estado.yo || (() => {
          const c = app.mapa.getCenter();
          return { lat: c.lat, lng: c.lng };
        })();
        const r = await fetch(`${GEOCODER}/api/?q=${encodeURIComponent(texto)}&limit=7&bbox=${BBOX_ESPANA}&lat=${yo.lat.toFixed(4)}&lon=${yo.lng.toFixed(4)}`, { signal });
        const d = await r.json();
        for (const f of d.features || []) {
          const p = f.properties || {};
          const calle = [p.street, p.housenumber].filter(Boolean).join(' ');
          const nombre = p.name || calle || p.city;
          if (!nombre) continue;
          const detalle = [p.name && calle ? calle : '', p.postcode, p.city || p.town || p.village, p.state].filter((x, i, a) => x && x !== nombre && a.indexOf(x) === i).join(', ');
          const [lng, lat] = f.geometry.coordinates;
          if (out.some((o) => o.lat && Math.abs(o.lat - lat) < 0.002 && Math.abs(o.lng - lng) < 0.002)) continue;
          out.push({ nombre, detalle, lat, lng });
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }
    return out.slice(0, 8);
  }

  function conectarCampo(input, lista, alElegir) {
    let ctrl = null;
    let temporizador = null;
    let resultados = [];
    let activo = -1;
    let elegidoTxt = null; // el texto que quedó al elegir; al volver a enfocar no reabre la lista
    const cerrar = () => {
      lista.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      activo = -1;
    };
    const elegir = (l) => {
      cerrar();
      input.blur();
      if (l.yo) {
        if (input.id === 'gOrigen') return usarMiUbicacion(true);
        const yo = A().estado.yo;
        if (!yo) return A().avisar('Primero activa tu ubicación.');
        l = { nombre: 'Mi ubicación', lat: yo.lat, lng: yo.lng };
      }
      input.value = l.nombre;
      elegidoTxt = null;
      alElegir({ nombre: l.nombre, lat: l.lat, lng: l.lng, detalle: l.detalle || '' });
      elegidoTxt = input.value;
    };
    const pintar = () => {
      lista.innerHTML = resultados
        .map((l, i) => `<li role="option" id="${lista.id}-${i}" aria-selected="${i === activo}" data-i="${i}"><span><b>${esc(l.nombre)}</b>${l.detalle ? `<small>${esc(l.detalle)}</small>` : ''}</span></li>`)
        .join('');
      lista.hidden = !resultados.length;
      input.setAttribute('aria-expanded', String(!lista.hidden));
    };
    input.addEventListener('input', () => {
      clearTimeout(temporizador);
      ctrl?.abort();
      if (!input.value.trim()) {
        resultados = [];
        if (input.id === 'gOrigen') resultados = [{ nombre: 'Mi ubicación', detalle: 'Usar tu posición actual', yo: true }];
        return pintar();
      }
      temporizador = setTimeout(async () => {
        ctrl = new AbortController();
        try {
          resultados = await buscarLugares(input.value, ctrl.signal);
          activo = resultados.length ? 0 : -1;
          pintar();
        } catch {
          /* búsqueda anulada por otra más nueva */
        }
      }, 280);
    });
    input.addEventListener('focus', () => {
      if (input.id === 'gOrigen' && !input.value) {
        resultados = [{ nombre: 'Mi ubicación', detalle: 'Usar tu posición actual', yo: true }];
        activo = 0;
        pintar();
      } else if (resultados.length && input.value && input.value !== elegidoTxt) pintar();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!resultados.length) return;
        ev.preventDefault();
        activo = (activo + (ev.key === 'ArrowDown' ? 1 : -1) + resultados.length) % resultados.length;
        pintar();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (resultados[activo >= 0 ? activo : 0]) elegir(resultados[activo >= 0 ? activo : 0]);
      } else if (ev.key === 'Escape') cerrar();
    });
    lista.addEventListener('mousedown', (ev) => ev.preventDefault());
    lista.addEventListener('click', (ev) => {
      const li = ev.target.closest('[data-i]');
      if (li) elegir(resultados[+li.dataset.i]);
    });
    input.addEventListener('blur', () => setTimeout(cerrar, 150));
  }

  function guardarReciente(l) {
    if (!l?.lat) return;
    const r = leer('gm.gps.recientes', []).filter((x) => !(Math.abs(x.lat - l.lat) < 1e-4 && Math.abs(x.lng - l.lng) < 1e-4));
    r.unshift({ nombre: l.nombre, detalle: l.detalle || '', lat: l.lat, lng: l.lng });
    guardar('gm.gps.recientes', r.slice(0, 6));
  }

  function pintarRecientes() {
    const el = $('#gRecientes');
    if (!el) return;
    const r = st.calc ? [] : leer('gm.gps.recientes', []);
    el.innerHTML = r.length
      ? `<h3 class="gps-sub">Recientes</h3><ul class="gps-recientes">${r
          .map((l, i) => `<li><button type="button" data-r="${i}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 2"/></svg><span><b>${esc(l.nombre)}</b>${l.detalle ? `<small>${esc(l.detalle)}</small>` : ''}</span></button></li>`)
          .join('')}</ul>`
      : '';
    $$('[data-r]', el).forEach((b) =>
      b.addEventListener('click', () => {
        st.destino = r[+b.dataset.r];
        pintarCampos();
        if (st.origen) calcular();
        else usarMiUbicacion();
      })
    );
  }

  /* ---------- Resultados ---------- */
  function costeDe(r) {
    const precio = r.parada?.precio ?? st.calc.precioRef;
    return precio ? r.litros * precio : null;
  }

  function tarjeta(m) {
    const r = st.calc[m];
    const app = A();
    if (r === undefined) return `<button type="button" class="gps-tarjeta cargando" data-modo="${m}" aria-pressed="${m === st.modo}"><b>${MODOS[m].titulo}</b><span class="gps-spin"></span><small>Buscando la gasolinera más barata…</small></button>`;
    if (r === null)
      return `<button type="button" class="gps-tarjeta vacia" data-modo="${m}" aria-pressed="${m === st.modo}"><b>${MODOS[m].titulo}</b><small>No hay gasolineras con ${esc(app.NOMBRES[app.estado.combustible])} a menos de ${st.opciones.desvio} km de la ruta. Prueba con un desvío mayor en «Opciones».</small></button>`;
    const n = st.calc.normal;
    const dMin = r.min - n.min;
    const coste = costeDe(r);
    const difL = r.litros - n.litros;
    let extra = '';
    if (m === 'eficiente' || m === 'combinada') {
      if (Math.abs(difL) >= 0.05) extra += `<span class="${difL < 0 ? 'ok' : ''}">${difL < 0 ? '−' : '+'}${fmtL(Math.abs(difL))} vs. la normal</span>`;
      else if (m === 'eficiente') extra += '<span>La rápida ya es la que menos gasta</span>';
    }
    if (r.parada) {
      extra += `<span class="gps-parada-txt">⛽ ${esc(r.parada.e.rotulo)} · ${app.euros(r.parada.precio)} €/l${r.parada.extraKm >= 0.1 ? ` · +${fmtDist(r.parada.extraKm)}` : ''}</span>`;
      if (r.parada.ahorro != null && r.parada.ahorro > 0.05) extra += `<span class="ok">Ahorras ≈ ${eur(r.parada.ahorro)} € al llenar ${String(litrosRepostar()).replace('.', ',')} L</span>`;
    }
    return `<button type="button" class="gps-tarjeta" data-modo="${m}" aria-pressed="${m === st.modo}">
      <b>${MODOS[m].titulo}</b>
      <span class="gps-tiempo">${fmtMin(r.min)}${m !== 'normal' && Math.abs(dMin) >= 1 ? `<small class="${dMin > 0 ? 'mas' : 'ok'}">${dMin > 0 ? '+' : '−'}${Math.round(Math.abs(dMin))} min</small>` : ''}</span>
      <span class="gps-datos">${fmtDist(r.km)} · ${fmtL(r.litros)}${coste ? ` · ≈ ${eur(coste)} €` : ''}</span>
      ${extra}
    </button>`;
  }

  function iconoPaso(p) {
    const m = p.maneuver;
    if (m.type === 'arrive') return '<svg viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2 4 2 4H6"/></svg>';
    if (m.type === 'depart') return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4"/></svg>';
    if (/roundabout|rotary/.test(m.type)) return `<svg viewBox="0 0 24 24"><circle cx="12" cy="11" r="4"/><path d="M12 21v-6"/><text x="12" y="13.5" text-anchor="middle" font-size="7" fill="currentColor" stroke="none">${m.exit || ''}</text></svg>`;
    const ang = { straight: 0, 'slight right': 40, right: 90, 'sharp right': 135, uturn: 180, 'slight left': -40, left: -90, 'sharp left': -135 }[m.modifier] ?? 0;
    if (ang === 180) return '<svg viewBox="0 0 24 24"><path d="M8 20V9a4 4 0 0 1 8 0v6M13 12l3 3 3-3"/></svg>';
    return `<svg viewBox="0 0 24 24"><g transform="rotate(${ang} 12 12)"><path d="M12 21V4M6.5 9.5L12 4l5.5 5.5"/></g></svg>`;
  }

  function textoPaso(p, ruta) {
    const m = p.maneuver;
    const mod = m.modifier || '';
    const dir = { left: 'a la izquierda', right: 'a la derecha', 'slight left': 'ligeramente a la izquierda', 'slight right': 'ligeramente a la derecha', 'sharp left': 'muy cerrado a la izquierda', 'sharp right': 'muy cerrado a la derecha', straight: 'recto', uturn: 'para cambiar de sentido' }[mod] || '';
    const via = p.name || p.ref || '';
    const por = via ? ` por ${via}` : '';
    switch (m.type) {
      case 'depart':
        return `Sal${por || ' hacia tu destino'}`;
      case 'arrive':
        if (p.ultimoTramo) return 'Has llegado a tu destino';
        if (ruta?.parada && Math.abs(p.maneuver.location[1] - ruta.parada.e.lat) < 0.002 && Math.abs(p.maneuver.location[0] - ruta.parada.e.lng) < 0.002) return `Llegas a la gasolinera ${ruta.parada.e.rotulo}`;
        return st.via ? `Llegas a tu parada: ${st.via.nombre}` : 'Llegas a tu parada';
      case 'roundabout':
      case 'rotary':
        return m.exit ? `En la rotonda, toma la ${m.exit}.ª salida${por}` : `Entra en la rotonda${por}`;
      case 'exit roundabout':
      case 'exit rotary':
        return `Sal de la rotonda${por}`;
      case 'roundabout turn':
        return `En la rotonda, gira ${dir}${por}`;
      case 'merge':
        return `Incorpórate${via ? ` a ${via}` : ''}`;
      case 'on ramp':
        return `Toma el acceso${p.destinations ? ` hacia ${p.destinations}` : via ? ` a ${via}` : ''}`;
      case 'off ramp':
        return `Toma la salida${p.exits ? ` ${p.exits.split(';')[0]}` : ''}${p.destinations ? ` hacia ${p.destinations}` : por}`;
      case 'fork':
        return `En la bifurcación, mantente ${mod.includes('left') ? 'a la izquierda' : mod.includes('right') ? 'a la derecha' : 'recto'}${p.destinations ? ` hacia ${p.destinations}` : por}`;
      case 'end of road':
        return `Al final de la vía, gira ${dir}${por}`;
      case 'continue':
      case 'new name':
      case 'notification':
        if (mod === 'uturn') return 'Cambia de sentido';
        return mod && mod !== 'straight' ? `Sigue ${dir}${por}` : `Continúa${por}`;
      default:
        if (mod === 'uturn') return `Cambia de sentido${por}`;
        if (mod === 'straight') return `Sigue recto${por}`;
        return `Gira ${dir}${por}`;
    }
  }

  // Compartir la ruta (o la hora de llegada si ya vas en camino)
  function compartirRuta() {
    const r = st.nav?.ruta || st.calc?.[st.modo] || st.calc?.normal || {};
    let texto = `Ruta a ${st.destino.nombre}`;
    if (st.nav) {
      const resto = Math.max(0, st.nav.total - st.nav.kmAct);
      const min = st.nav.ruta.min * (resto / Math.max(0.001, st.nav.total));
      texto = `Voy de camino a ${st.destino.nombre}. Llego sobre las ${fmtHora(new Date(Date.now() + min * 60000))} (${fmtDist(resto)}).`;
    } else if (r.min) texto += `: ${fmtMin(r.min)}, ${fmtDist(r.km)}${r.parada ? `, repostando en ${r.parada.e.rotulo} (${A().euros(r.parada.precio)} €/l)` : ''}.`;
    A().compartirDatos({ title: 'GasoCheck · GPS', text: texto + ' Abrir la ruta:', url: enlaceGoogle(r) });
  }

  function enlaceGoogle(r) {
    const u = new URL('https://www.google.com/maps/dir/');
    u.searchParams.set('api', '1');
    u.searchParams.set('origin', `${st.origen.lat},${st.origen.lng}`);
    u.searchParams.set('destination', `${st.destino.lat},${st.destino.lng}`);
    const paradas = [st.via, r.parada && { lat: r.parada.e.lat, lng: r.parada.e.lng }].filter(Boolean);
    if (paradas.length) u.searchParams.set('waypoints', paradas.map((p) => `${p.lat},${p.lng}`).join('|'));
    u.searchParams.set('travelmode', 'driving');
    return u.href;
  }

  // Botones de debajo de los destinos: activos cuando la ruta elegida está calculada
  function pintarAcciones() {
    const r = st.calc?.[st.modo];
    const listo = Boolean(r);
    $('#gIniciar').disabled = !listo;
    $('#gSimular').disabled = !listo;
    $('#gCompartir').disabled = !(st.origen && st.destino);
    const g = $('#gGoogle');
    // Google Maps se puede abrir en cuanto hay origen y destino
    if (st.origen && st.destino) {
      g.href = enlaceGoogle(r || {});
      g.setAttribute('aria-disabled', 'false');
    } else {
      g.removeAttribute('href');
      g.setAttribute('aria-disabled', 'true');
    }
  }

  /* ---------- Depósito: ¿me llega? ---------- */
  function capacidadDeposito() {
    const a = A().estado.ajustes;
    const coche = (a.coches || []).find((c) => c.id === a.cocheActivo) || (a.coches || [])[0];
    const v = Number(coche?.deposito) || Number(a.deposito) || 50;
    return v > 0 ? v : 50;
  }

  function bloqueDeposito(r) {
    const frac = parseFloat(st.opciones.deposito);
    if (!(frac > 0) || !r?.km) return '';
    const app = A();
    const litros = capacidadDeposito() * frac;
    const autonomia = (litros / consumoBase()) * 100;
    const margen = autonomia - r.km;
    if (margen > 30) return `<div class="gps-aviso ok-borde">✅ <span>Te llega el depósito: te sobrarán unos <b>${fmtDist(margen)}</b> de autonomía al llegar.</span></div>`;
    if (margen > 0) return `<div class="gps-aviso medio-borde">⛽ <span>Llegarás muy justo: unos ${fmtDist(margen)} de margen. Mejor repostar por el camino.</span></div>`;
    // No llega: la más barata antes de quedarte sin combustible (con 15 km de margen)
    const limite = Math.max(5, autonomia - 15);
    const opciones = (st.calc.cercanas || []).filter((p) => p.kmDesdeOrigen <= limite).sort((a, b) => a.precio - b.precio);
    const p = opciones[0];
    return `<div class="gps-aviso peligro-borde">⚠️ <span><b>No te llega el depósito</b>: tienes para unos ${fmtDist(autonomia)} y el viaje son ${fmtDist(r.km)}.
      ${p ? `Reposta antes del km ${Math.round(limite)}. La más barata: <b>${esc(p.e.rotulo)}</b> (${esc(p.e.localidad)}), ${app.euros(p.precio)} €/l, en el km ${p.kmDesdeOrigen}.` : 'No hay gasolineras con tu combustible antes de ese punto cerca de la ruta.'}</span>
      ${p ? `<button type="button" class="boton" id="gParadaDeposito" data-nombre="${esc(p.e.rotulo + ' · ' + p.e.localidad)}" data-lat="${p.e.lat}" data-lng="${p.e.lng}">Parar ahí</button>` : ''}</div>`;
  }

  /* ---------- Hora de salida para llegar a tiempo ---------- */
  function bloqueSalida(r) {
    const h = st.opciones.llegada;
    if (!h || !r?.min) return '';
    const [hh, mm] = h.split(':').map(Number);
    const llegada = new Date();
    llegada.setHours(hh, mm, 0, 0);
    if (llegada < Date.now()) llegada.setDate(llegada.getDate() + 1);
    const min = r.min * 1.1 + (r.parada ? 7 : 0); // 10 % de margen y 7 min para repostar
    const salida = new Date(llegada.getTime() - min * 60000);
    const ya = salida <= Date.now();
    return `<div class="gps-aviso ${ya ? 'peligro-borde' : 'info-borde'}">🕒 <span>${ya ? `Para llegar a las ${esc(h)} deberías haber salido a las <b>${fmtHora(salida)}</b>. Si sales ahora llegas sobre las ${fmtHora(new Date(Date.now() + min * 60000))}.` : `Para llegar a las ${esc(h)}, sal a las <b>${fmtHora(salida)}</b>.`} <small>(Con un 10 % de margen${r.parada ? ' y 7 min para repostar' : ''}; sin datos de tráfico en tiempo real.)</small></span></div>`;
  }

  /* ---------- ¿Y en eléctrico o híbrido? ---------- */
  function bloqueElectrico(r) {
    if (!r?.km) return '';
    const precio = r.parada?.precio ?? st.calc.precioRef;
    if (!precio) return '';
    const kwh = leer('gm.gps.kwh', 0.2);
    const tuyo = r.litros * precio;
    const electrico = (r.km * 17) / 100; // kWh (eléctrico medio: 17 kWh/100 km)
    const hibrido = r.litros * 0.72 * precio;
    const fila = (t, v, extra = '') => `<li><span>${t}</span><b>${eur(v)} €</b>${extra}</li>`;
    return `<details class="gps-electrico"><summary>¿Y en coche eléctrico o híbrido?</summary>
      <ul>
        ${fila('Tu coche', tuyo, `<small>${fmtL(r.litros)}</small>`)}
        ${fila('Híbrido', hibrido, `<small>${tuyo - hibrido > 0 ? '−' + eur(tuyo - hibrido) + ' €' : ''}</small>`)}
        ${fila('Eléctrico (cargando en casa)', electrico * kwh, `<small>${Math.round(electrico)} kWh</small>`)}
        ${fila('Eléctrico, carga rápida', electrico * 0.49, '<small>0,49 €/kWh</small>')}
      </ul>
      <label class="gps-kwh">Precio de tu luz <input id="gElecPrecio" inputmode="decimal" value="${String(kwh).replace('.', ',')}"> €/kWh</label>
      <p class="texto-ayuda">Estimación orientativa: eléctrico medio de 17 kWh/100 km e híbrido que gasta un 28 % menos que tu coche.</p>
    </details>`;
  }

  /* ---------- Rutas vigiladas: aviso si baja el precio en tu ruta habitual ---------- */
  const rutasVigiladas = () => (A().estado.ajustes.gpsRutas || []).filter((r) => r && r.id);
  function bloqueVigilar() {
    const rutas = rutasVigiladas();
    const nombre = `${st.origen?.nombre || ''} → ${st.destino?.nombre || ''}`;
    const ya = rutas.find((r) => r.nombre === nombre);
    return `<div class="gps-vigilar">
      ${ya ? `<p class="texto-ayuda">🔔 Ya vigilas esta ruta: te avisaremos si baja el precio en sus gasolineras.</p>` : `<button type="button" class="boton" id="gVigilar">🔔 Avisarme si baja el precio en esta ruta</button>`}
      ${rutas.length ? `<ul class="gps-rutas-v">${rutas.map((r) => `<li><span>${esc(r.nombre)} · ${esc(A().NOMBRES[r.combustible] || '')}</span><button type="button" data-quitar-ruta="${esc(r.id)}" aria-label="Dejar de vigilar ${esc(r.nombre)}">✕</button></li>`).join('')}</ul>` : ''}
    </div>`;
  }
  function vigilarRuta() {
    const app = A();
    if (!app.conSesion()) return app.pedirCuenta('recibir avisos de precio en tu ruta');
    const ids = (st.calc?.cercanas || []).map((p) => p.e.id).slice(0, 300);
    if (!ids.length) return app.avisar('No hay gasolineras cerca de esta ruta para vigilar.');
    const ruta = { id: Math.random().toString(36).slice(2, 10), nombre: `${st.origen.nombre} → ${st.destino.nombre}`.slice(0, 80), combustible: app.estado.combustible, estaciones: ids };
    app.guardarAjustes({ gpsRutas: [...rutasVigiladas(), ruta].slice(-10) });
    pedirPush();
    app.avisar('Hecho: te avisaremos cuando baje el precio en esta ruta.', 4000);
    pintarResultados({ encuadrar: false });
  }
  function quitarRutaVigilada(id) {
    A().guardarAjustes({ gpsRutas: rutasVigiladas().filter((r) => r.id !== id) });
    if (st.calc) pintarResultados({ encuadrar: false });
  }
  // Notificaciones push (si no las tiene activadas, se le pide permiso)
  function pedirPush() {
    if (!('Notification' in window) || Notification.permission === 'granted' || Notification.permission === 'denied') return;
    window.GasoAvisos?.activarPush?.().catch(() => {});
  }

  /* ---------- Mis lugares (Casa, Trabajo y los que quieras) + precio del día ---------- */
  // Casa y Trabajo se guardan en ajustes.gpsCasa / gpsTrabajo (el servidor usa Casa para el precio del día);
  // el resto en ajustes.gpsLugares = [{ id, nombre, lat, lng, dir }]. Todo se sincroniza con la cuenta.
  const FIJOS = { casa: { e: '🏠', n: 'Casa', clave: 'gpsCasa' }, trabajo: { e: '💼', n: 'Trabajo', clave: 'gpsTrabajo' } };
  const MAX_LUGARES = 12;
  const misLugares = () => (A().estado.ajustes.gpsLugares || []).filter((l) => l && l.id && Number.isFinite(l.lat));
  const lugarDe = (tipo, id) => (FIJOS[tipo] ? A().estado.ajustes[FIJOS[tipo].clave] : misLugares().find((l) => l.id === id));

  function pintarFavs() {
    const el = $('#gFavs');
    if (!el) return;
    const app = A();
    const a = app.estado.ajustes;
    const chipFijo = (k) => {
      const f = FIJOS[k];
      const l = a[f.clave];
      return l?.lat
        ? `<span class="gps-fav"><button type="button" class="gps-fav-ir" data-ir="${k}" title="${esc(l.dir || l.nombre)}">${f.e} ${f.n}<small data-min="${k}"></small></button><button type="button" class="gps-fav-ed" data-editar="${k}" aria-label="Cambiar la dirección de ${f.n}" title="Cambiar la dirección">✎</button></span>`
        : `<button type="button" class="gps-fav vacio" data-editar="${k}">${f.e} Añadir ${f.n.toLowerCase()}</button>`;
    };
    const otros = misLugares()
      .map((l) => `<span class="gps-fav"><button type="button" class="gps-fav-ir" data-ir="otro" data-id="${esc(l.id)}" title="${esc(l.dir || l.nombre)}">📍 ${esc(l.nombre)}<small data-min="${esc(l.id)}"></small></button><button type="button" class="gps-fav-ed" data-editar="otro" data-id="${esc(l.id)}" aria-label="Editar ${esc(l.nombre)}" title="Editar">✎</button></span>`)
      .join('');
    const pd = a.precioDia || {};
    el.innerHTML = `${chipFijo('casa')}${chipFijo('trabajo')}${otros}
      ${misLugares().length < MAX_LUGARES ? '<button type="button" class="gps-fav vacio" data-editar="nuevo">＋ Añadir lugar</button>' : ''}
      ${a.gpsCasa?.lat ? `<label class="interruptor gps-precio-dia"><input type="checkbox" id="gPrecioDia"${pd.activo ? ' checked' : ''}><i></i>Cada mañana, avísame de la más barata cerca de casa</label>` : ''}`;
    $$('[data-ir]', el).forEach((b) =>
      b.addEventListener('click', () => {
        const l = lugarDe(b.dataset.ir, b.dataset.id);
        if (!l) return;
        st.destino = { nombre: l.nombre, lat: l.lat, lng: l.lng, detalle: l.dir || '' };
        pintarCampos();
        if (st.origen) calcular();
        else usarMiUbicacion();
      })
    );
    $$('[data-editar]', el).forEach((b) => b.addEventListener('click', () => abrirEditorLugar(b.dataset.editar, b.dataset.id)));
    $('#gPrecioDia')?.addEventListener('change', (ev) => {
      if (ev.target.checked && !app.conSesion()) {
        ev.target.checked = false;
        return app.pedirCuenta('recibir el precio del día');
      }
      app.guardarAjustes({ precioDia: { activo: ev.target.checked, combustible: app.estado.combustible, radio: 5 } });
      if (ev.target.checked) {
        pedirPush();
        app.avisar(`Cada mañana te diremos la gasolinera con ${app.NOMBRES[app.estado.combustible]} más barata a menos de 5 km de casa.`, 5000);
      }
    });
    // Tiempo hasta cada lugar desde donde estás (como mucho 6)
    const o = st.origen?.lat ? st.origen : app.estado.yo;
    if (!o) return;
    const todos = [...Object.keys(FIJOS).map((k) => [k, a[FIJOS[k].clave]]), ...misLugares().map((l) => [l.id, l])].filter(([, l]) => l?.lat).slice(0, 6);
    for (const [k, l] of todos) {
      if (kmEntre([o.lat, o.lng], [l.lat, l.lng]) < 0.3) continue;
      osrm([o, l], { excluir: st.opciones.evitar || '' })
        .then(([r]) => {
          const m = el.querySelector(`[data-min="${CSS.escape(k)}"]`);
          if (m) m.textContent = ` · ${fmtMin(r.min)}`;
        })
        .catch(() => {});
    }
  }

  // Editor de un lugar: nombre (si no es Casa ni Trabajo) y dirección buscada aquí mismo
  function abrirEditorLugar(tipo, id) {
    const app = A();
    if (!app.conSesion()) return app.pedirCuenta('guardar tus lugares');
    const ed = $('#gLugarEd');
    const fijo = FIJOS[tipo];
    const actual = tipo === 'nuevo' ? null : lugarDe(tipo, id);
    st.edLugar = { tipo, id: tipo === 'otro' ? id : null, elegido: actual?.lat ? { nombre: actual.dir || actual.nombre, lat: actual.lat, lng: actual.lng } : null };
    $('#gLugarTit').textContent = fijo ? `${fijo.e} Dirección de ${fijo.n.toLowerCase()}` : actual ? `📍 Editar «${actual.nombre}»` : '📍 Nuevo lugar';
    $('#gLugarNombreCaja').hidden = Boolean(fijo);
    $('#gLugarNombre').value = fijo ? fijo.n : actual?.nombre || '';
    $('#gLugarDir').value = actual ? actual.dir || actual.nombre : '';
    $('#gLugarBorrar').hidden = !actual;
    pintarElegido();
    $('#gSugL').hidden = true;
    $('#gLugarDir').setAttribute('aria-expanded', 'false');
    ed.hidden = false;
    (fijo || actual ? $('#gLugarDir') : $('#gLugarNombre')).focus();
    ed.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function pintarElegido() {
    const e = st.edLugar?.elegido;
    $('#gLugarElegido').textContent = e ? `✔ ${e.nombre}` : 'Escribe la dirección y elige una de las sugerencias.';
    $('#gLugarElegido').classList.toggle('ok', Boolean(e));
    $('#gLugarGuardar').disabled = !e;
  }
  function cerrarEditorLugar() {
    st.edLugar = null;
    $('#gSugL').hidden = true;
    $('#gLugarEd').hidden = true;
  }
  function guardarLugar() {
    const app = A();
    const ed = st.edLugar;
    if (!ed?.elegido) return;
    const dir = ed.elegido.nombre;
    if (FIJOS[ed.tipo]) {
      app.guardarAjustes({ [FIJOS[ed.tipo].clave]: { nombre: FIJOS[ed.tipo].n, dir, lat: ed.elegido.lat, lng: ed.elegido.lng } });
      app.avisar(`${FIJOS[ed.tipo].n}: ${dir}`, 3000);
    } else {
      const nombre = $('#gLugarNombre').value.trim().slice(0, 30);
      if (!nombre) {
        $('#gLugarNombre').focus();
        return app.avisar('Ponle un nombre al lugar (por ejemplo «Gimnasio»).');
      }
      const lista = misLugares();
      const nuevo = { id: ed.id || Math.random().toString(36).slice(2, 10), nombre, dir, lat: ed.elegido.lat, lng: ed.elegido.lng };
      const i = lista.findIndex((l) => l.id === nuevo.id);
      if (i >= 0) lista[i] = nuevo;
      else lista.push(nuevo);
      app.guardarAjustes({ gpsLugares: lista.slice(0, MAX_LUGARES) });
      app.avisar(`Guardado: ${nombre}`, 3000);
    }
    cerrarEditorLugar();
    pintarFavs();
  }
  function borrarLugar() {
    const app = A();
    const ed = st.edLugar;
    if (!ed) return;
    if (FIJOS[ed.tipo]) {
      if (!confirm(`¿Borrar la dirección de ${FIJOS[ed.tipo].n.toLowerCase()}?`)) return;
      app.guardarAjustes({ [FIJOS[ed.tipo].clave]: null, ...(ed.tipo === 'casa' ? { precioDia: { ...(app.estado.ajustes.precioDia || {}), activo: false } } : {}) });
    } else {
      const l = lugarDe('otro', ed.id);
      if (!confirm(`¿Borrar «${l?.nombre || 'este lugar'}»?`)) return;
      app.guardarAjustes({ gpsLugares: misLugares().filter((x) => x.id !== ed.id) });
    }
    cerrarEditorLugar();
    pintarFavs();
  }

  /* ---------- Resumen al llegar y sitios cerca del destino ---------- */
  async function resumenLlegada(nav) {
    const app = A();
    const fraccion = Math.min(1, nav.kmAct / Math.max(0.001, nav.total));
    if (fraccion < 0.6) return; // terminó muy pronto: no es un viaje completo
    const r = nav.ruta;
    const km = nav.total * fraccion;
    const litros = r.litros * fraccion;
    const precio = r.parada?.precio ?? st.calc?.precioRef;
    const min = (Date.now() - nav.inicio) / 60000;
    const destino = st.destino;
    let el = $('#gpsFin');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gpsFin';
      el.className = 'gps-fin';
      document.body.appendChild(el);
    }
    el.innerHTML = `<div class="gps-fin-caja" role="dialog" aria-labelledby="gFinTit">
      <h3 id="gFinTit">🏁 Has llegado${destino ? ` a ${esc(destino.nombre)}` : ''}</h3>
      <div class="gps-fin-datos">
        <div><b>${fmtDist(km)}</b><span>recorridos</span></div>
        <div><b>${nav.simulada ? fmtMin(r.min) : fmtMin(min)}</b><span>de viaje</span></div>
        <div><b>${fmtL(litros)}</b><span>${precio ? `≈ ${eur(litros * precio)} €` : 'gastados'}</span></div>
      </div>
      ${r.parada?.ahorro > 0.05 ? `<p class="ok">Repostando en ${esc(r.parada.e.rotulo)} ahorraste unos ${eur(r.parada.ahorro)} € frente a la media del camino.</p>` : ''}
      ${r.parada ? `<button type="button" class="boton primario" id="gFinRepostaje">⛽ Apuntar el repostaje en ${esc(r.parada.e.rotulo)}</button>` : ''}
      <h4>Cerca de tu destino</h4>
      <div id="gFinCerca"><p class="texto-ayuda">Buscando aparcamientos y lavados…</p></div>
      <button type="button" class="boton" id="gFinCerrar">Cerrar</button>
    </div>`;
    el.hidden = false;
    $('#gFinCerrar').addEventListener('click', () => (el.hidden = true));
    $('#gFinRepostaje')?.addEventListener('click', () => {
      el.hidden = true;
      app.apuntarRepostaje(r.parada.e.id);
    });
    if (!destino) return;
    // Lavados: gasolineras verificadas que lo indican, a menos de 3 km
    const lavados = app.estado.estaciones
      .filter((e) => (app.estado.extras[e.id]?.s || []).includes('lavado'))
      .map((e) => ({ e, km: kmEntre([destino.lat, destino.lng], [e.lat, e.lng]) }))
      .filter((x) => x.km <= 3)
      .sort((a, b) => a.km - b.km)
      .slice(0, 3);
    // Aparcamientos de OpenStreetMap (Overpass), a menos de 700 m
    let parkings = [];
    try {
      const q = `[out:json][timeout:10];nwr["amenity"="parking"]["access"!="private"](around:700,${destino.lat},${destino.lng});out center 25;`;
      const resp = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(12000) });
      const d = await resp.json();
      parkings = (d.elements || [])
        .map((x) => {
          const lat = x.lat ?? x.center?.lat, lng = x.lon ?? x.center?.lon;
          const t = x.tags || {};
          return { lat, lng, nombre: t.name || (t.parking === 'underground' ? 'Parking subterráneo' : 'Aparcamiento'), gratis: t.fee === 'no', pago: t.fee === 'yes', km: kmEntre([destino.lat, destino.lng], [lat, lng]) };
        })
        .filter((x) => Number.isFinite(x.lat))
        .sort((a, b) => a.km - b.km)
        .slice(0, 5);
    } catch {
      /* sin servicio de aparcamientos */
    }
    const caja = $('#gFinCerca');
    if (!caja) return;
    const fila = (ico, t, sub, lat, lng) => `<li><span class="gps-cerca-ico">${ico}</span><span><b>${esc(t)}</b><small>${sub}</small></span><a class="boton" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking">Ir</a></li>`;
    caja.innerHTML =
      parkings.length || lavados.length
        ? `<ul class="gps-cerca">${parkings.map((x) => fila('🅿️', x.nombre, `${fmtDist(x.km)}${x.gratis ? ' · gratis' : x.pago ? ' · de pago' : ''}`, x.lat, x.lng)).join('')}${lavados
            .map((x) => fila('🧽', `${x.e.rotulo} (lavado)`, `${fmtDist(x.km)} · ${esc(x.e.localidad)}`, x.e.lat, x.e.lng))
            .join('')}</ul><p class="texto-ayuda">Aparcamientos de OpenStreetMap; los lavados, de gasolineras verificadas.</p>`
        : '<p class="texto-ayuda">No hemos encontrado aparcamientos ni lavados cerca.</p>';
  }

  /* ---------- Modo noche automático ---------- */
  // ¿Es de noche ahora en ese punto? (altura aproximada del sol)
  function esDeNoche(lat, lng, fecha = new Date()) {
    const d = (fecha - Date.UTC(fecha.getUTCFullYear(), 0, 0)) / 864e5;
    const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (d - 81)) * RAD;
    const horaSolar = fecha.getUTCHours() + fecha.getUTCMinutes() / 60 + lng / 15;
    const angHora = (horaSolar - 12) * 15 * RAD;
    const alt = Math.asin(Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(angHora));
    return alt / RAD < -4; // pasado el crepúsculo
  }

  /* ---------- Viaje en directo ---------- */
  async function compartirEnDirecto() {
    const nav = st.nav;
    if (!nav) return;
    const app = A();
    if (nav.directo) return app.compartirDatos({ title: 'GasoCheck · Viaje en directo', text: `Sigue mi viaje a ${st.destino.nombre} en directo:`, url: nav.directo.url });
    try {
      const r = await fetch(`${API()}/api/viajes`, { method: 'POST', headers: cab(), body: JSON.stringify({ alias: window.Cuenta?.usuario?.()?.alias || '', destino: { nombre: st.destino.nombre, lat: st.destino.lat, lng: st.destino.lng } }) });
      const d = await r.json();
      if (!r.ok) return app.avisar(d.error || 'No se pudo compartir el viaje.');
      const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}viaje.html?id=${encodeURIComponent(d.id)}`;
      nav.directo = { id: d.id, clave: d.clave, url, ultimo: 0 };
      $('#gnDirecto').hidden = false;
      enviarPosicionDirecto(nav, true);
      app.compartirDatos({ title: 'GasoCheck · Viaje en directo', text: `Sigue mi viaje a ${st.destino.nombre} en directo:`, url });
    } catch {
      app.avisar('Sin conexión: no se pudo compartir el viaje.');
    }
  }
  function enviarPosicionDirecto(nav, forzar = false, extra = {}) {
    const dir = nav?.directo;
    if (!dir || !nav.pos) return;
    if (!forzar && Date.now() - dir.ultimo < 12000) return;
    dir.ultimo = Date.now();
    const resto = Math.max(0, nav.total - nav.kmAct);
    const min = nav.ruta.min * (resto / Math.max(0.001, nav.total));
    fetch(`${API()}/api/viajes/${encodeURIComponent(dir.id)}`, {
      method: 'PUT',
      headers: cab(),
      body: JSON.stringify({ clave: dir.clave, lat: nav.pos[0], lng: nav.pos[1], rumbo: nav.rumbo, eta: Date.now() + min * 60000, restoKm: Math.round(resto * 10) / 10, ...extra }),
      keepalive: true,
    }).catch(() => {});
  }
  function pararDirecto(nav, llegado = false) {
    const dir = nav?.directo;
    if (!dir) return;
    if (llegado) enviarPosicionDirecto(nav, true, { llegado: true });
    else fetch(`${API()}/api/viajes/${encodeURIComponent(dir.id)}`, { method: 'PUT', headers: cab(), body: JSON.stringify({ clave: dir.clave, fin: true }), keepalive: true }).catch(() => {});
    nav.directo = null;
    const el = $('#gnDirecto');
    if (el) el.hidden = true;
  }

  function pintarResultados({ encuadrar = true } = {}) {
    const res = $('#gRes');
    const app = A();
    if (!res || !st.calc) return;
    const r = st.calc[st.modo];
    const listo = r && r !== undefined;
    const sel = r || st.calc.normal;
    const extras = $('#gExtrasRes');
    const abiertoElec = $('.gps-electrico', extras)?.open;
    extras.innerHTML = `${bloqueElectrico(sel)}${bloqueVigilar()}`;
    res.innerHTML = `
      ${bloqueDeposito(sel)}
      ${bloqueSalida(sel)}
      <div class="gps-tarjetas">${Object.keys(MODOS).map(tarjeta).join('')}</div>
      <p class="texto-ayuda gps-nota">Gasto estimado con ${String(consumoBase()).replace('.', ',')} l/100 km y ${esc(app.NOMBRES[app.estado.combustible])}${st.calc.precioRef ? ` a ${app.euros(st.calc.precioRef)} €/l (media del camino)` : ''}${app.tieneDescuentos?.() ? ', con tus descuentos' : ''}. Los tiempos no incluyen el tráfico en tiempo real.</p>`;
    if (abiertoElec) $('.gps-electrico', extras)?.setAttribute('open', '');
    $$('.gps-tarjeta', res).forEach((b) => b.addEventListener('click', () => elegirModo(b.dataset.modo)));
    $('#gParadaDeposito')?.addEventListener('click', (ev) => {
      const b = ev.currentTarget;
      st.via = { nombre: b.dataset.nombre, lat: +b.dataset.lat, lng: +b.dataset.lng };
      pintarCampos();
      calcular();
    });
    $('#gVigilar')?.addEventListener('click', vigilarRuta);
    $$('[data-quitar-ruta]', extras).forEach((b) => b.addEventListener('click', () => quitarRutaVigilada(b.dataset.quitarRuta)));
    $('#gElecPrecio')?.addEventListener('change', (ev) => {
      guardar('gm.gps.kwh', parseFloat(String(ev.target.value).replace(',', '.')) || 0.2);
      pintarResultados({ encuadrar: false });
      $('.gps-electrico')?.setAttribute('open', '');
    });
    pintarAcciones();
    pintarRecientes();
    if (listo) pintarMapa({ encuadrar });
    app.hoja('medio');
  }

  /* ---------------- Incidentes (avisos de los conductores, como Waze) ---------------- */
  const INC = {
    accidente: { n: 'Accidente', e: '💥', c: '#e5484d' },
    atasco: { n: 'Atasco', e: '🚗', c: '#f5a524' },
    control: { n: 'Control policial', e: '👮', c: '#3b82f6' },
    radar: { n: 'Radar móvil', e: '📷', c: '#8b5cf6' },
    obras: { n: 'Obras', e: '🚧', c: '#f97316' },
    peligro: { n: 'Peligro en la vía', e: '⚠️', c: '#eab308' },
    averiado: { n: 'Vehículo parado', e: '🚙', c: '#64748b' },
    tiempo: { n: 'Mal tiempo', e: '🌧️', c: '#0ea5e9' },
  };
  const API = () => (window.GASOCHECK_API || '').replace(/\/$/, '');
  const cab = () => ({ 'Content-Type': 'application/json', ...(window.Cuenta?.cabeceras?.() || {}) });
  st.incidentes = [];
  st.misAvisos = new Set(leer('gm.gps.misAvisos', []));

  function limpiarIncidentes() {
    if (st.capaInc) A().mapa.removeLayer(st.capaInc);
    st.capaInc = null;
  }

  function pintarIncidentes() {
    limpiarIncidentes();
    if (!st.incidentes.length) return;
    const g = L.layerGroup();
    for (const i of st.incidentes) {
      const t = INC[i.tipo] || { n: i.nombre, e: '❗', c: '#e5484d' };
      const hace = Math.max(1, Math.round((Date.now() - i.creado) / 60000));
      panes();
      L.marker([i.lat, i.lng], { pane: 'gpsTop', icon: L.divIcon({ className: '', html: `<div class="gps-inc${i.confirmado ? ' confirmado' : ''}" style="--c:${t.c}"><span>${t.e}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34] }), zIndexOffset: 900 })
        .bindTooltip(`${esc(t.n)}${i.confirmado ? ' · ✔ confirmado' : ''} · hace ${hace >= 60 ? Math.round(hace / 60) + ' h' : hace + ' min'}${i.confirmaciones ? ` · ${i.confirmaciones} confirmación${i.confirmaciones > 1 ? 'es' : ''}` : ''}`)
        .addTo(g);
    }
    st.capaInc = g.addTo(A().mapa);
  }

  // Incidentes activos alrededor de una ruta
  async function cargarIncidentes(linea) {
    if (!linea?.length) return;
    let s_ = 90, w = 180, n = -90, e = -180;
    for (const [la, ln] of linea) {
      s_ = Math.min(s_, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln);
    }
    const m = 0.02;
    const q = `s=${(s_ - m).toFixed(4)}&w=${(w - m).toFixed(4)}&n=${(n + m).toFixed(4)}&e=${(e + m).toFixed(4)}`;
    try {
      const r = await fetch(`${API()}/api/incidentes?${q}`, { headers: cab(), signal: AbortSignal.timeout(10000) });
      if (!r.ok) return;
      const d = await r.json();
      st.incidentes = d.incidentes || [];
      if (st.nav) st.nav.incKm = new Map(); // se recalcula su posición en la ruta
      if (st.calc || st.nav) pintarIncidentes();
    } catch {
      /* sin conexión: se reintentará */
    }
  }

  async function enviarIncidente(tipo) {
    const nav = st.nav;
    cerrarReporte();
    if (!nav?.pos) return A().avisar('Todavía no tenemos tu posición. Espera un momento y vuelve a intentarlo.');
    try {
      const r = await fetch(`${API()}/api/incidentes`, { method: 'POST', headers: cab(), body: JSON.stringify({ tipo, lat: nav.pos[0], lng: nav.pos[1], rumbo: nav.rumbo }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return A().avisar(d.error || 'No se pudo enviar el aviso.');
      if (d.incidente) {
        st.misAvisos.add(d.incidente.id);
        guardar('gm.gps.misAvisos', [...st.misAvisos].slice(-50));
        st.incidentes = [d.incidente, ...st.incidentes.filter((x) => x.id !== d.incidente.id)];
        pintarIncidentes();
      }
      const pts = A().conSesion() ? (d.existente ? ' +2 puntos' : ' +5 puntos') : '';
      A().avisar((d.existente ? 'Gracias: has confirmado un aviso que ya estaba.' : 'Gracias. Tu aviso ayudará a otros conductores.') + pts, 4000);
      hablar('Aviso enviado');
    } catch {
      A().avisar('Sin conexión: no se pudo enviar el aviso.');
    }
  }

  async function votarIncidente(id, sigue) {
    $('#gnPregunta').hidden = true;
    try {
      const r = await fetch(`${API()}/api/incidentes/${encodeURIComponent(id)}/voto`, { method: 'POST', headers: cab(), body: JSON.stringify({ sigue }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        st.incidentes = d.incidente ? st.incidentes.map((x) => (x.id === id ? d.incidente : x)) : st.incidentes.filter((x) => x.id !== id);
        pintarIncidentes();
        A().avisar(`Gracias por confirmarlo.${A().conSesion() ? ' +2 puntos' : ''}`, 2500);
      }
    } catch {
      /* sin conexión */
    }
  }

  function abrirReporte() {
    const el = $('#gnReporte');
    el.hidden = false;
    el.querySelector('button[data-inc]')?.focus();
  }
  function cerrarReporte() {
    const el = $('#gnReporte');
    if (el) el.hidden = true;
  }

  // Durante la navegación: avisa de los incidentes que hay por delante y pregunta si siguen al pasar
  function revisarIncidentes(nav) {
    if (!st.incidentes.length) {
      $('#gnIncidente').hidden = true;
      return;
    }
    nav.incKm ||= new Map();
    let proximo = null;
    for (const i of st.incidentes) {
      let pos = nav.incKm.get(i.id);
      if (!pos) {
        const m = proyectar({ ...nav, idx: 0 }, [i.lat, i.lng]);
        pos = { km: m.km, d: m.d };
        nav.incKm.set(i.id, pos);
      }
      if (pos.d > 0.08) continue; // no está en tu ruta
      const delante = pos.km - nav.kmAct;
      if (delante > 0 && delante < 2 && (!proximo || delante < proximo.delante)) proximo = { i, delante };
      // Acabas de pasar: ¿sigue ahí?
      if (delante < -0.02 && delante > -0.4 && !nav.preguntados.has(i.id) && !st.misAvisos.has(i.id)) {
        nav.preguntados.add(i.id);
        const t = INC[i.tipo] || { n: i.nombre, e: '❗' };
        const el = $('#gnPregunta');
        el.innerHTML = `<span>${t.e} ¿Sigue ahí: ${esc(t.n.toLowerCase())}?</span><button type="button" data-si>Sí, sigue</button><button type="button" data-no>Ya no está</button>`;
        el.hidden = false;
        el.querySelector('[data-si]').onclick = () => votarIncidente(i.id, true);
        el.querySelector('[data-no]').onclick = () => votarIncidente(i.id, false);
        clearTimeout(nav.timerPregunta);
        nav.timerPregunta = setTimeout(() => (el.hidden = true), 15000);
      }
    }
    const chip = $('#gnIncidente');
    if (!proximo) {
      chip.hidden = true;
      return;
    }
    const t = INC[proximo.i.tipo] || { n: proximo.i.nombre, e: '❗', c: '#e5484d' };
    chip.hidden = false;
    chip.style.setProperty('--c', t.c);
    chip.innerHTML = `<span class="e">${t.e}</span><span><b>${esc(t.n)}</b> a ${fmtDist(proximo.delante)}${proximo.i.confirmado ? ' <small>✔ confirmado</small>' : ''}</span>`;
    if (proximo.delante < 0.8 && !nav.incAvisados.has(proximo.i.id)) {
      nav.incAvisados.add(proximo.i.id);
      hablar(`Atención: ${t.n.toLowerCase()}${proximo.i.confirmado ? ' confirmado' : ''} a ${fmtDist(proximo.delante).replace(',', ' coma ')}`);
    }
  }

  /* ---------------- Navegación ---------------- */
  function prepararNav(ruta) {
    const L_ = ruta.linea;
    const cum = [0];
    for (let i = 1; i < L_.length; i++) cum.push(cum[i - 1] + kmEntre(L_[i - 1], L_[i]));
    // Posición (km desde la salida) de cada maniobra
    let j = 0;
    const pasos = ruta.pasos.map((p) => {
      const loc = [p.maneuver.location[1], p.maneuver.location[0]];
      let mejor = j, dMin = Infinity;
      for (let i = j; i < Math.min(L_.length, j + 4000); i++) {
        const d = kmEntre(loc, L_[i]);
        if (d < dMin) {
          dMin = d;
          mejor = i;
        }
        if (dMin < 0.002 && d > 0.5) break;
      }
      j = mejor;
      return { ...p, km: cum[mejor], texto: textoPaso(p, ruta) };
    });
    const total = cum[cum.length - 1];
    const paradaKm = ruta.parada ? kmEnRuta(L_, ruta.parada.e) : null;
    const viaKm = st.via ? kmEnRuta(L_, st.via) : null;
    return { ruta, cum, pasos, total, viaKm, idx: 0, kmAct: 0, avisados: new Set(), fuera: 0, paradaKm, seguir: true, incKm: new Map(), incAvisados: new Set(), preguntados: new Set() };
  }

  // Punto de la ruta más cercano a la posición (busca alrededor del último para ir rápido)
  function proyectar(nav, p) {
    const L_ = nav.ruta.linea;
    const buscar = (desde, hasta) => {
      let mejor = { d: Infinity, i: desde, km: 0 };
      const cos = Math.cos(p[0] * RAD);
      for (let i = Math.max(1, desde); i < Math.min(L_.length, hasta); i++) {
        const a = L_[i - 1], b = L_[i];
        const ax = a[1] * cos, ay = a[0], bx = b[1] * cos, by = b[0], px = p[1] * cos, py = p[0];
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.sqrt((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2) * 111.32;
        if (d < mejor.d) mejor = { d, i, km: nav.cum[i - 1] + t * (nav.cum[i] - nav.cum[i - 1]) };
      }
      return mejor;
    };
    let m = buscar(nav.idx - 30, nav.idx + 600);
    if (m.d > 0.08) {
      const g = buscar(1, L_.length);
      if (g.d < m.d) m = g;
    }
    return m;
  }

  function hablar(texto) {
    if (!st.nav?.voz || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(texto);
      u.lang = 'es-ES';
      const v = speechSynthesis.getVoices().find((x) => /^es(-|_)ES/i.test(x.lang)) || speechSynthesis.getVoices().find((x) => /^es/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch {
      /* sin voz */
    }
  }

  function pintarNavUI() {
    let el = $('#gpsNav');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gpsNav';
      el.className = 'gps-nav';
      el.innerHTML = `
        <div class="gps-banner" role="status" aria-live="polite">
          <span class="gps-ico grande" id="gnIco"></span>
          <div class="gps-banner-txt"><b id="gnDist"></b><span id="gnTexto"></span></div>
          <div class="gps-luego" id="gnLuego" hidden></div>
        </div>
        <div class="gps-velocidad" id="gnVel" hidden><span class="gps-limite" id="gnLim" hidden></span><span class="gps-vel-actual"><b id="gnVelNum">0</b><small>km/h</small></span></div>
        <div class="gps-inc-chip" id="gnIncidente" hidden></div>
        <div class="gps-pregunta" id="gnPregunta" role="alert" hidden></div>
        <button type="button" class="gps-centrar" id="gnCentrar" hidden><svg aria-hidden="true"><use href="#i-diana"/></svg>Centrar</button>
        <button type="button" class="gps-avisar" id="gnAvisar" aria-label="Avisar de un incidente" title="Avisar de un incidente"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/></svg><span>Avisar</span></button>
        <div class="gps-reporte" id="gnReporte" role="dialog" aria-label="Avisar de un incidente" hidden>
          <div class="gps-reporte-caja">
            <h3>¿Qué hay en la vía?</h3>
            <div class="gps-reporte-grid">${Object.entries(INC).map(([k, t]) => `<button type="button" data-inc="${k}" style="--c:${t.c}"><span>${t.e}</span>${t.n}</button>`).join('')}</div>
            <button type="button" class="boton gps-reporte-cancelar" id="gnReporteCancelar">Cancelar</button>
            <p class="texto-ayuda">El aviso se envía con tu posición actual y lo verán los demás conductores durante un rato. Avisa solo cuando sea seguro (mejor si lo hace tu acompañante).</p>
          </div>
        </div>
        <div class="gps-comp-menu" id="gnCompMenu" hidden>
          <button type="button" data-comp="eta">🕒 Compartir hora de llegada</button>
          <button type="button" data-comp="directo">📡 Compartir mi ubicación en directo</button>
        </div>
        <div class="gps-barra-nav">
          <button type="button" class="gps-salir" id="gnSalir" aria-label="Terminar navegación">✕</button>
          <div class="gps-eta"><b id="gnEta"></b><span id="gnResto"></span><span class="gps-directo" id="gnDirecto" hidden>📡 En directo · <button type="button" id="gnDirectoParar">Parar</button></span></div>
          <button type="button" class="gps-voz gps-comp-nav" id="gnCompartir" aria-label="Compartir hora de llegada" title="Compartir hora de llegada"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg></button>
          <button type="button" class="gps-voz" id="gnVoz" aria-pressed="true" aria-label="Voz"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path class="ondas" d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg></button>
        </div>`;
      $('.mapa-zona').appendChild(el);
      $('#gnSalir').addEventListener('click', terminarNavegacion);
      $('#gnCompartir').addEventListener('click', () => {
        const m = $('#gnCompMenu');
        m.hidden = !m.hidden;
      });
      $('#gnCompMenu').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-comp]');
        if (!b) return;
        $('#gnCompMenu').hidden = true;
        if (b.dataset.comp === 'eta') compartirRuta();
        else compartirEnDirecto();
      });
      $('#gnDirectoParar').addEventListener('click', () => {
        pararDirecto(st.nav);
        A().avisar('Has dejado de compartir tu viaje.', 3000);
      });
      $('#gnAvisar').addEventListener('click', abrirReporte);
      $('#gnReporteCancelar').addEventListener('click', cerrarReporte);
      $('#gnReporte').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-inc]');
        if (b) enviarIncidente(b.dataset.inc);
        else if (ev.target.id === 'gnReporte') cerrarReporte();
      });
      $('#gnCentrar').addEventListener('click', () => {
        if (!st.nav) return;
        st.nav.seguir = true;
        $('#gnCentrar').hidden = true;
        if (st.nav.pos) A().mapa.setView(st.nav.pos, 17);
      });
      $('#gnVoz').addEventListener('click', () => {
        if (!st.nav) return;
        st.nav.voz = !st.nav.voz;
        $('#gnVoz').setAttribute('aria-pressed', String(st.nav.voz));
        if (!st.nav.voz) speechSynthesis?.cancel();
      });
    }
    el.hidden = false;
    $('#gnCompMenu').hidden = true;
    $('#gnDirecto').hidden = true;
    $('#gnIncidente').hidden = true;
    $('#gnPregunta').hidden = true;
    cerrarReporte();
    $('#gnVoz').setAttribute('aria-pressed', String(st.nav.voz));
  }

  // Velocidad actual y límite del tramo (si se conoce): en rojo si vas por encima
  function velocidad(nav, vel) {
    const el = $('#gnVel');
    if (vel == null && nav.prevT && nav.prevPos) {
      const dt = (Date.now() - nav.prevT) / 3600000;
      if (dt > 0) vel = kmEntre(nav.prevPos, nav.pos) / dt / (nav.simulada ? 15 : 1);
    }
    nav.prevT = Date.now();
    nav.prevPos = nav.pos;
    const lim = nav.ruta.limites?.[Math.max(0, nav.idx - 1)] ?? null;
    if (vel == null && !lim) return (el.hidden = true);
    el.hidden = false;
    const v = vel == null ? null : Math.round(vel);
    $('#gnVelNum').textContent = v == null ? '—' : v;
    $('#gnLim').hidden = !lim;
    if (lim) $('#gnLim').textContent = lim;
    const pasado = lim && v != null && v > lim + 4;
    el.classList.toggle('exceso', Boolean(pasado));
    if (pasado && lim !== nav.limAvisado) {
      nav.limAvisado = lim;
      hablar(`Atención, límite ${lim}`);
    }
    if (!pasado && v != null && lim && v < lim) nav.limAvisado = null;
  }

  const rumboEntre = (a, b) => (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * RAD), b[0] - a[0]) / RAD + 360) % 360;
  const difAngulo = (a, b) => {
    const d = Math.abs(((a - b) % 360) + 360) % 360;
    return d > 180 ? 360 - d : d;
  };

  function actualizarNav(lat, lng, rumbo, vel, precision) {
    const nav = st.nav;
    if (!nav) return;
    const app = A();
    const p = [lat, lng];
    nav.pos = p;
    // Rumbo: el del GPS o, si no lo da, el del último desplazamiento
    if ((rumbo == null || Number.isNaN(rumbo)) && nav.prev && kmEntre(nav.prev, p) > 0.008) rumbo = rumboEntre(nav.prev, p);
    if (rumbo == null || Number.isNaN(rumbo)) rumbo = null;
    const m = proyectar(nav, p);
    // Margen para considerar que sigues en la ruta: según la precisión del GPS (entre 45 y 100 m)
    const margen = Math.max(0.045, Math.min(0.1, ((precision || 20) / 1000) * 1.5));
    if (!nav.simulada) {
      // Fuera de la ruta: 2 posiciones seguidas lejos de ella
      nav.fuera = m.d > margen ? nav.fuera + 1 : 0;
      // En sentido contrario: vas por la ruta pero hacia atrás (has dado la vuelta)
      const L_ = nav.ruta.linea;
      const rRuta = rumboEntre(L_[Math.max(0, m.i - 1)], L_[Math.min(L_.length - 1, m.i)]);
      const enMarcha = rumbo != null && (vel == null || vel > 8);
      nav.contra = m.d <= margen && enMarcha && difAngulo(rumbo, rRuta) > 120 ? (nav.contra || 0) + 1 : 0;
      const puede = !nav.recalculando && Date.now() - (nav.ultimoRecalc || 0) > 6000;
      if (puede && (nav.fuera >= 2 || nav.contra >= 3)) recalcular(p, rumbo);
    }
    if (m.d <= margen || nav.simulada) {
      nav.idx = m.i;
      nav.kmAct = m.km; // también puede bajar: si vuelves atrás, las indicaciones se actualizan
    }
    // Marcador con flecha
    if (!nav.marca) nav.marca = L.marker(p, { pane: 'gpsTop', icon: L.divIcon({ className: '', html: '<div class="gps-flecha"><svg viewBox="0 0 24 24"><path d="M12 2l7 19-7-4-7 4z"/></svg></div>', iconSize: [40, 40], iconAnchor: [20, 20] }), interactive: false, zIndexOffset: 2000 }).addTo(app.mapa);
    nav.marca.setLatLng(p);
    if (rumbo != null) {
      nav.rumbo = rumbo;
      const f = nav.marca.getElement()?.querySelector('.gps-flecha');
      if (f) f.style.transform = `rotate(${rumbo}deg)`;
    }
    nav.prev = p;
    if (nav.seguir) app.mapa.setView(p, Math.max(app.mapa.getZoom(), 16), { animate: true });

    // Próxima maniobra
    const kmAct = nav.kmAct;
    const k = nav.pasos.findIndex((x, i) => i > 0 && x.km > kmAct + 0.01);
    const sig = k >= 0 ? nav.pasos[k] : nav.pasos[nav.pasos.length - 1];
    const falta = Math.max(0, (k >= 0 ? sig.km : nav.total) - kmAct);
    $('#gnIco').innerHTML = iconoPaso(sig);
    $('#gnDist').textContent = fmtDist(falta);
    $('#gnTexto').textContent = sig.texto;
    const luego = k >= 0 ? nav.pasos[k + 1] : null;
    $('#gnLuego').hidden = !(luego && luego.km - sig.km < 0.25);
    if (luego) $('#gnLuego').innerHTML = `<span class="gps-luego-et">Después</span><span class="gps-ico">${iconoPaso(luego)}</span><span class="gps-luego-txt">${esc(luego.texto)}</span>`;
    velocidad(nav, vel);
    // Voz: aviso previo y en el momento
    const clave = k + ':';
    const previo = sig.km - nav.pasos[Math.max(0, k - 1)].km > 1.5 ? 1 : 0.4;
    if (k >= 0 && falta <= previo && falta > 0.12 && !nav.avisados.has(clave + 'p')) {
      nav.avisados.add(clave + 'p');
      hablar(`En ${fmtDist(falta).replace(',', ' coma ')}, ${sig.texto}`);
    }
    if (k >= 0 && falta <= 0.08 && !nav.avisados.has(clave + 'a')) {
      nav.avisados.add(clave + 'a');
      nav.avisados.add(clave + 'p');
      hablar(sig.texto);
    }
    revisarIncidentes(nav);
    // Tiempo y distancia que faltan
    const resto = Math.max(0, nav.total - kmAct);
    const minResto = nav.ruta.min * (resto / Math.max(0.001, nav.total));
    $('#gnEta').textContent = `Llegada ${fmtHora(new Date(Date.now() + minResto * 60000))}`;
    $('#gnResto').textContent = `${fmtMin(minResto)} · ${fmtDist(resto)}`;
    enviarPosicionDirecto(nav);
    if (resto < 0.03) {
      hablar('Has llegado a tu destino');
      nav.llegado = true;
      pararDirecto(nav, true);
      terminarNavegacion();
    }
  }

  async function recalcular(p, rumbo = null) {
    const nav = st.nav;
    nav.recalculando = true;
    nav.ultimoRecalc = Date.now();
    $('#gnTexto').textContent = 'Recalculando la ruta…';
    try {
      // Paradas que aún no se han pasado, en orden
      const pendientes = [];
      if (st.via && nav.viaKm != null && nav.kmAct < nav.viaKm - 0.05) pendientes.push({ km: nav.viaKm, p: st.via });
      const conParada = nav.ruta.parada && (nav.paradaKm == null || nav.kmAct < nav.paradaKm - 0.05);
      if (conParada) pendientes.push({ km: nav.paradaKm ?? Infinity, p: { lat: nav.ruta.parada.e.lat, lng: nav.ruta.parada.e.lng } });
      pendientes.sort((a, b) => a.km - b.km);
      const puntos = [{ lat: p[0], lng: p[1] }, ...pendientes.map((x) => x.p), st.destino];
      let r;
      try {
        [r] = await osrm(puntos, { excluir: nav.ruta.excluir, rumbo });
      } catch {
        [r] = await osrm(puntos, { excluir: nav.ruta.excluir }); // sin rumbo, por si no hay ruta en ese sentido
      }
      if (st.nav !== nav) return;
      const nueva = prepararNav({ ...r, parada: conParada ? nav.ruta.parada : null });
      Object.assign(nav, { ...nueva, ultimoRecalc: Date.now(), contra: 0, voz: nav.voz, marca: nav.marca, watch: nav.watch, wake: nav.wake, simulada: nav.simulada, seguir: nav.seguir, pos: nav.pos, prev: nav.prev, incAvisados: nav.incAvisados, preguntados: nav.preguntados, timerInc: nav.timerInc });
      st.calc[st.modo] = { ...nav.ruta };
      pintarMapa({ encuadrar: false });
      hablar('Ruta recalculada');
    } catch {
      /* se reintentará con la siguiente posición */
    } finally {
      nav.recalculando = false;
      nav.fuera = 0;
    }
  }

  async function iniciarNavegacion(simular) {
    const ruta = st.calc?.[st.modo];
    if (!ruta) return;
    const app = A();
    if (st.nav) terminarNavegacion();
    st.nav = { ...prepararNav(ruta), voz: leer('gm.gps.voz', true), simulada: simular, inicio: Date.now() };
    document.body.classList.add('navegando');
    document.body.classList.toggle('gps-grande', Boolean(st.opciones.letraGrande));
    // De noche, mapa oscuro (se mira cada 5 minutos)
    const cont = app.mapa.getContainer();
    st.nav.oscuroAntes = cont.classList.contains('mapa-oscuro');
    const revisarNoche = () => {
      if (!st.nav || st.opciones.nocheAuto === false) return;
      const p = st.nav.pos || ruta.linea[0];
      cont.classList.toggle('mapa-oscuro', st.nav.oscuroAntes || esDeNoche(p[0], p[1]));
    };
    revisarNoche();
    st.nav.timerNoche = setInterval(revisarNoche, 5 * 60000);
    pintarNavUI();
    pintarMapa({ encuadrar: false });
    setTimeout(() => app.mapa.invalidateSize(), 50);
    app.mapa.on('dragstart', alArrastrar);
    app.capaEstaciones(false);
    pintarIncidentes();
    cargarIncidentes(ruta.linea);
    const navInc = st.nav;
    navInc.timerInc = setInterval(() => (st.nav === navInc ? cargarIncidentes(navInc.ruta.linea) : clearInterval(navInc.timerInc)), 60000);
    try {
      st.nav.wake = await navigator.wakeLock?.request('screen');
    } catch {
      /* la pantalla podrá apagarse */
    }
    hablar(simular ? 'Simulación del recorrido' : `Vamos allá. ${ruta.parada ? `Pararemos a repostar en ${ruta.parada.e.rotulo}. ` : ''}${fmtMin(ruta.min)} hasta tu destino.`);
    if (simular) {
      // Recorre la ruta a velocidad acelerada
      const nav = st.nav;
      let km = 0;
      const paso = Math.max(0.03, nav.total / 220);
      nav.timer = setInterval(() => {
        if (st.nav !== nav) return clearInterval(nav.timer);
        km = Math.min(nav.total, km + paso);
        const i = nav.cum.findIndex((c) => c >= km);
        const b = nav.ruta.linea[Math.max(0, i)];
        const a = nav.ruta.linea[Math.max(0, i - 1)];
        const t = i > 0 ? (km - nav.cum[i - 1]) / Math.max(1e-9, nav.cum[i] - nav.cum[i - 1]) : 1;
        actualizarNav(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      }, 450);
      return;
    }
    if (!navigator.geolocation) {
      app.avisar('Tu navegador no permite usar el GPS.');
      return terminarNavegacion();
    }
    st.nav.watch = navigator.geolocation.watchPosition(
      (pos) => actualizarNav(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, pos.coords.speed != null && pos.coords.speed >= 0 ? pos.coords.speed * 3.6 : null, pos.coords.accuracy),
      (e) => {
        if (e.code === 1) {
          app.avisar('Para navegar, permite el acceso a tu ubicación en el navegador.');
          terminarNavegacion();
        }
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
    // Mientras llega la primera posición, se ve la salida
    actualizarNav(ruta.linea[0][0], ruta.linea[0][1]);
    st.nav.prev = null; // esa no es una posición real: no sirve para calcular el rumbo
  }

  function alArrastrar() {
    if (!st.nav) return;
    st.nav.seguir = false;
    $('#gnCentrar').hidden = false;
  }

  function terminarNavegacion() {
    const nav = st.nav;
    if (!nav) return;
    guardar('gm.gps.voz', nav.voz);
    if (nav.watch != null) navigator.geolocation.clearWatch(nav.watch);
    clearInterval(nav.timer);
    clearInterval(nav.timerInc);
    clearInterval(nav.timerNoche);
    clearTimeout(nav.timerPregunta);
    pararDirecto(nav, nav.llegado);
    document.body.classList.remove('gps-grande');
    A().mapa.getContainer().classList.toggle('mapa-oscuro', Boolean(nav.oscuroAntes));
    if (nav.llegado || nav.kmAct / Math.max(0.001, nav.total) > 0.9) setTimeout(() => resumenLlegada(nav), 120);
    nav.wake?.release?.().catch(() => {});
    nav.marca?.remove();
    try {
      speechSynthesis?.cancel();
    } catch {
      /* */
    }
    A().mapa.off('dragstart', alArrastrar);
    st.nav = null;
    document.body.classList.remove('navegando');
    const el = $('#gpsNav');
    if (el) el.hidden = true;
    // Si se sale del GPS (desde otra pestaña), vuelven las gasolineras del mapa
    A().capaEstaciones($('#vGps')?.hidden !== false);
    setTimeout(() => {
      A().mapa.invalidateSize();
      if ($('#vGps') && !$('#vGps').hidden) pintarMapa();
      else limpiarMapa(), limpiarIncidentes();
    }, 50);
  }

  /* ---------------- Integración con la app ---------------- */
  window.GasoGPS = {
    // Se llama al cambiar de pestaña
    alCambiar(p) {
      A().capaEstaciones(p !== 'gps' && !st.nav);
      if (p === 'gps') {
        montar();
        pintarFavs();
        $('#gConsumo') && ($('#gConsumo').textContent = String(consumoBase()).replace('.', ','));
        if (st.calc) pintarMapa();
        else if (st.destino && st.origen) calcular();
        else if (!st.origen) {
          const yo = A().estado.yo;
          if (yo) {
            st.origen = { nombre: 'Mi ubicación', lat: yo.lat, lng: yo.lng, yo: true };
            pintarCampos();
          }
        }
      } else if (!st.nav) {
        limpiarMapa();
        limpiarIncidentes();
      }
    },
    // Al cambiar de combustible o de precios, la parada puede ser otra
    alCambiarCombustible() {
      if (st.calc && $('#vGps') && !$('#vGps').hidden && !st.nav) calcular();
    },
    ir(destino) {
      st.destino = destino;
      A().cambiarPestana('gps');
      pintarCampos();
      if (st.origen) calcular();
      else usarMiUbicacion();
    },
    // Para pruebas
    _estado: st,
    _textoPaso: textoPaso,
  };
})();
