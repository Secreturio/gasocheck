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
    eficiente: { titulo: 'Ruta eficiente', sub: 'Menos combustible', ico: '<path d="M6 18c0-7 5-12 13-12 0 8-5 13-12 13"/><path d="M6 18l6-6"/>' },
    barata: { titulo: 'Gasolina barata', sub: 'Para en la más barata', ico: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.5"/>' },
    combinada: { titulo: 'Eficiente + barata', sub: 'Menos gasto total', ico: '<path d="M6 18c0-7 5-12 13-12 0 8-5 13-12 13"/><path d="M14 15l2.5 2.5L21 13"/>' },
  };

  const A = () => window.GasoApp;
  const st = {
    origen: null, // { nombre, lat, lng, yo? }
    destino: null,
    modo: leer('gm.gps.modo', 'normal'),
    opciones: { desvio: 3, litros: null, peajes: false, ...leer('gm.gps.opciones', {}) },
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
    // Cada giro, rotonda o stop: frenar y volver a acelerar
    litros += pasos.filter((p) => ['turn', 'end of road', 'roundabout', 'rotary', 'roundabout turn'].includes(p.maneuver.type)).length * 0.006 * (base / 6.5);
    return { linea, km: r.distance / 1000, min: r.duration / 60, pasos, litros, ...extra };
  }

  async function osrm(puntos, { alternativas = false, excluir = '' } = {}) {
    const coords = puntos.map((p) => `${(+p.lng).toFixed(6)},${(+p.lat).toFixed(6)}`).join(';');
    const url = `${SERVIDOR}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&annotations=distance,duration${alternativas ? '&alternatives=3' : ''}${excluir ? '&exclude=' + excluir : ''}`;
    if (cacheRutas.has(url)) return cacheRutas.get(url);
    const p = (async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const d = await r.json().catch(() => ({}));
      if (d.code !== 'Ok' || !d.routes?.length) throw new Error(d.message || 'No hay ruta por carretera entre esos puntos.');
      return d.routes.map((x) => prepararRuta(x, { excluir }));
    })();
    cacheRutas.set(url, p);
    p.catch(() => cacheRutas.delete(url));
    return p;
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
      precioDe: (e) => app.precio(e, c),
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
        [ruta] = await osrm([st.origen, { lat: p.e.lat, lng: p.e.lng }, st.destino], { excluir: base.excluir });
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

  async function calcular() {
    const token = ++st.token;
    const res = $('#gRes');
    if (!st.origen || !st.destino) return;
    guardar('gm.gps.ultimo', { origen: st.origen.yo ? null : st.origen, destino: st.destino });
    guardarReciente(st.destino);
    res.innerHTML = '<p class="gps-cargando"><span class="gps-spin"></span>Calculando rutas…</p>';
    st.calc = null;
    try {
      const evitar = st.opciones.peajes ? 'toll' : '';
      const rapidas = await osrm([st.origen, st.destino], { alternativas: true, excluir: evitar });
      if (token !== st.token) return;
      const candidatas = [...rapidas];
      // Una alternativa más sin autopistas (a menudo gasta menos aunque tarde algo más)
      if (!evitar) {
        try {
          for (const r of await osrm([st.origen, st.destino], { excluir: 'motorway' })) if (!candidatas.some((c) => parecidas(c, r))) candidatas.push(r);
        } catch {
          /* el servidor no permite excluir autopistas: se sigue con las demás */
        }
      }
      if (token !== st.token) return;
      const normal = rapidas[0];
      const precioRef = paradasEn(normal).media || null;
      // Eficiente: la de menos combustible sin tardar más de un 35 % que la rápida
      const eficiente = candidatas.filter((r) => r.min <= normal.min * 1.35).reduce((a, b) => (b.litros < a.litros ? b : a), normal);
      st.calc = { normal, eficiente, barata: undefined, combinada: undefined, precioRef, alternativas: candidatas };
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

  function pintarMapa({ encuadrar = true } = {}) {
    const app = A();
    limpiarMapa();
    if (!st.calc) return;
    const sel = st.calc[st.modo] || st.calc.normal;
    const g = L.layerGroup();
    const acento = getComputedStyle(document.documentElement).getPropertyValue('--acento').trim() || '#2f7bf6';
    // Otras rutas, en gris (se pueden elegir tocándolas)
    for (const m of Object.keys(MODOS)) {
      const r = st.calc[m];
      if (!r || r === sel || r.linea === sel.linea) continue;
      L.polyline(r.linea, { color: '#7b8aa6', weight: 6, opacity: 0.55 })
        .on('click', () => elegirModo(m))
        .bindTooltip(MODOS[m].titulo, { sticky: true })
        .addTo(g);
    }
    L.polyline(sel.linea, { color: '#0b2a63', weight: 10, opacity: 0.9 }).addTo(g);
    L.polyline(sel.linea, { color: acento, weight: 6, opacity: 1 }).addTo(g);
    L.marker([st.origen.lat, st.origen.lng], { icon: pin('origen'), interactive: false }).addTo(g);
    L.marker([st.destino.lat, st.destino.lng], { icon: pin('destino', '<svg viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2 4 2 4H6"/></svg>') }).bindTooltip(esc(st.destino.nombre)).addTo(g);
    if (sel.parada) {
      const p = sel.parada;
      L.marker([p.e.lat, p.e.lng], { icon: L.divIcon({ className: '', html: `<div class="gps-pin parada"><b>${app.euros(p.precio)}</b></div>`, iconSize: [64, 30], iconAnchor: [32, 30] }) })
        .on('click', () => app.abrirFicha(p.e.id))
        .addTo(g);
    }
    st.capa = g.addTo(app.mapa);
    if (encuadrar && !st.nav) {
      const movil = matchMedia('(max-width: 760px)').matches;
      app.mapa.fitBounds(L.latLngBounds(sel.linea), { paddingTopLeft: [30, movil ? 90 : 30], paddingBottomRight: [30, movil ? Math.round(innerHeight * 0.5) : 30] });
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
          <div class="gps-campo">
            <label for="gDestino" class="sr">Destino</label>
            <input id="gDestino" type="search" autocomplete="off" placeholder="¿A dónde vas?" enterkeyhint="search" aria-controls="gSugD" aria-expanded="false">
            <ul class="sugerencias gps-sug" id="gSugD" role="listbox" hidden></ul>
          </div>
        </div>
        <button type="button" class="gps-invertir" id="gInvertir" title="Intercambiar origen y destino" aria-label="Intercambiar origen y destino"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v16M8 4L4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"/></svg></button>
      </div>

      <div class="gps-modos" role="radiogroup" aria-label="Tipo de ruta">
        ${Object.entries(MODOS)
          .map(([k, m]) => `<button type="button" role="radio" data-modo="${k}" aria-checked="${k === st.modo}"><svg viewBox="0 0 24 24" aria-hidden="true">${m.ico}</svg><b>${m.titulo}</b><small>${m.sub}</small></button>`)
          .join('')}
      </div>

      <details class="gps-opciones">
        <summary>Opciones de la ruta</summary>
        <div class="gps-opc-grid">
          <label>Desvío máximo para repostar
            <select id="gDesvio">${[1, 3, 5, 10].map((v) => `<option value="${v}"${v === st.opciones.desvio ? ' selected' : ''}>${v} km</option>`).join('')}</select>
          </label>
          <label>Litros a repostar
            <input id="gLitros" inputmode="decimal" placeholder="${A().estado.ajustes.litros}" value="${esc(st.opciones.litros ?? '')}">
          </label>
          <label class="interruptor"><input type="checkbox" id="gPeajes"${st.opciones.peajes ? ' checked' : ''}><i></i>Evitar peajes</label>
        </div>
        <p class="texto-ayuda">El gasto se calcula con tu combustible (el que eliges arriba) y el consumo de tu coche: <b id="gConsumo"></b> l/100 km. Cámbialo en <a href="#" id="gMiCoche">Mi coche</a>.</p>
      </details>

      <div id="gRes" aria-live="polite"></div>
      <div id="gRecientes"></div>`;
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
    $('#gYo').addEventListener('click', () => usarMiUbicacion(true));
    $('#gInvertir').addEventListener('click', () => {
      if (!st.origen && !st.destino) return;
      [st.origen, st.destino] = [st.destino, st.origen];
      pintarCampos();
      if (st.origen && st.destino) calcular();
    });
    $$('.gps-modos [data-modo]', v).forEach((b) => b.addEventListener('click', () => elegirModo(b.dataset.modo)));
    const opc = () => {
      st.opciones = { desvio: +$('#gDesvio').value, litros: $('#gLitros').value.trim() || null, peajes: $('#gPeajes').checked };
      guardar('gm.gps.opciones', st.opciones);
      if (st.origen && st.destino) calcular();
    };
    $('#gDesvio').addEventListener('change', opc);
    $('#gPeajes').addEventListener('change', opc);
    $('#gLitros').addEventListener('change', opc);
    $('#gMiCoche').addEventListener('click', (ev) => {
      ev.preventDefault();
      A().cambiarPestana('micoche');
    });
    // Último viaje
    const u = leer('gm.gps.ultimo', null);
    if (u?.destino) st.destino = u.destino;
    if (u?.origen) st.origen = u.origen;
    pintarCampos();
    pintarRecientes();
  }

  function pintarCampos() {
    $('#gOrigen').value = st.origen ? st.origen.nombre : '';
    $('#gDestino').value = st.destino ? st.destino.nombre : '';
  }

  function elegirModo(m) {
    st.modo = m;
    guardar('gm.gps.modo', m);
    $$('#vGps .gps-modos [data-modo]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.modo === m)));
    if (st.calc) pintarResultados({ encuadrar: false });
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
      alElegir({ nombre: l.nombre, lat: l.lat, lng: l.lng, detalle: l.detalle || '' });
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
      } else if (resultados.length && input.value) pintar();
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
        return p.ultimoTramo ? 'Has llegado a tu destino' : `Llegas a la gasolinera ${ruta?.parada ? ruta.parada.e.rotulo : ''}`.trim();
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

  function enlaceGoogle(r) {
    const u = new URL('https://www.google.com/maps/dir/');
    u.searchParams.set('api', '1');
    u.searchParams.set('origin', `${st.origen.lat},${st.origen.lng}`);
    u.searchParams.set('destination', `${st.destino.lat},${st.destino.lng}`);
    if (r.parada) u.searchParams.set('waypoints', `${r.parada.e.lat},${r.parada.e.lng}`);
    u.searchParams.set('travelmode', 'driving');
    return u.href;
  }

  function pintarResultados({ encuadrar = true } = {}) {
    const res = $('#gRes');
    const app = A();
    if (!res || !st.calc) return;
    const r = st.calc[st.modo];
    const listo = r && r !== undefined;
    const sel = r || st.calc.normal;
    res.innerHTML = `
      <div class="gps-tarjetas">${Object.keys(MODOS).map(tarjeta).join('')}</div>
      <div class="gps-acciones">
        <button type="button" class="boton primario gps-iniciar" id="gIniciar"${listo ? '' : ' disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l7 19-7-4-7 4z"/></svg>Iniciar</button>
        <button type="button" class="boton" id="gSimular"${listo ? '' : ' disabled'} title="Ver el recorrido sin moverte">Simular</button>
        <a class="boton" id="gGoogle" href="${listo ? esc(enlaceGoogle(sel)) : '#'}" target="_blank" rel="noopener">Abrir en Google Maps</a>
      </div>
      ${
        listo
          ? `<details class="gps-pasos"><summary>Indicaciones · ${sel.pasos.length} pasos</summary><ol>${sel.pasos
              .filter((p) => p.maneuver.type !== 'depart' || p === sel.pasos[0])
              .map((p) => `<li><span class="gps-ico">${iconoPaso(p)}</span><span>${esc(textoPaso(p, sel))}${p.distance > 0 ? `<small>${fmtDist(p.distance / 1000)}</small>` : ''}</span></li>`)
              .join('')}</ol></details>`
          : ''
      }
      <p class="texto-ayuda gps-nota">Gasto estimado con ${String(consumoBase()).replace('.', ',')} l/100 km y ${esc(app.NOMBRES[app.estado.combustible])}${st.calc.precioRef ? ` a ${app.euros(st.calc.precioRef)} €/l (media del camino)` : ''}. Los tiempos no incluyen el tráfico en tiempo real.</p>`;
    $$('.gps-tarjeta', res).forEach((b) => b.addEventListener('click', () => elegirModo(b.dataset.modo)));
    $('#gIniciar').addEventListener('click', () => iniciarNavegacion(false));
    $('#gSimular').addEventListener('click', () => iniciarNavegacion(true));
    pintarRecientes();
    if (listo) pintarMapa({ encuadrar });
    app.hoja('medio');
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
    const paradaKm = ruta.parada ? pasos.find((p) => p.maneuver.type === 'arrive' && !p.ultimoTramo)?.km ?? null : null;
    return { ruta, cum, pasos, total, idx: 0, kmAct: 0, avisados: new Set(), fuera: 0, paradaKm, seguir: true };
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
          <div><b id="gnDist"></b><span id="gnTexto"></span></div>
        </div>
        <div class="gps-luego" id="gnLuego" hidden></div>
        <button type="button" class="gps-centrar" id="gnCentrar" hidden><svg aria-hidden="true"><use href="#i-diana"/></svg>Centrar</button>
        <div class="gps-barra-nav">
          <button type="button" class="gps-salir" id="gnSalir" aria-label="Terminar navegación">✕</button>
          <div class="gps-eta"><b id="gnEta"></b><span id="gnResto"></span></div>
          <button type="button" class="gps-voz" id="gnVoz" aria-pressed="true" aria-label="Voz"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path class="ondas" d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg></button>
        </div>`;
      $('.mapa-zona').appendChild(el);
      $('#gnSalir').addEventListener('click', terminarNavegacion);
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
    $('#gnVoz').setAttribute('aria-pressed', String(st.nav.voz));
  }

  function actualizarNav(lat, lng, rumbo) {
    const nav = st.nav;
    if (!nav) return;
    const app = A();
    const p = [lat, lng];
    nav.pos = p;
    const m = proyectar(nav, p);
    // ¿Fuera de la ruta? (3 posiciones seguidas a más de 70 m) → se recalcula desde aquí
    if (m.d > 0.07 && !nav.simulada) {
      nav.fuera++;
      if (nav.fuera >= 3 && !nav.recalculando) recalcular(p);
    } else nav.fuera = 0;
    if (m.d <= 0.07 || nav.simulada) {
      nav.idx = m.i;
      nav.kmAct = Math.max(nav.kmAct - 0.05, m.km);
    }
    // Marcador con flecha
    if (!nav.marca) nav.marca = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="gps-flecha"><svg viewBox="0 0 24 24"><path d="M12 2l7 19-7-4-7 4z"/></svg></div>', iconSize: [40, 40], iconAnchor: [20, 20] }), interactive: false, zIndexOffset: 2000 }).addTo(app.mapa);
    nav.marca.setLatLng(p);
    if (rumbo == null && nav.prev && kmEntre(nav.prev, p) > 0.005) rumbo = Math.atan2((p[1] - nav.prev[1]) * Math.cos(p[0] * RAD), p[0] - nav.prev[0]) / RAD;
    if (rumbo != null && !Number.isNaN(rumbo)) {
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
    if (luego) $('#gnLuego').innerHTML = `Después: <span class="gps-ico">${iconoPaso(luego)}</span>${esc(luego.texto)}`;
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
    // Tiempo y distancia que faltan
    const resto = Math.max(0, nav.total - kmAct);
    const minResto = nav.ruta.min * (resto / Math.max(0.001, nav.total));
    $('#gnEta').textContent = `Llegada ${fmtHora(new Date(Date.now() + minResto * 60000))}`;
    $('#gnResto').textContent = `${fmtMin(minResto)} · ${fmtDist(resto)}`;
    if (resto < 0.03) {
      hablar('Has llegado a tu destino');
      app.avisar(`Has llegado: ${st.destino.nombre}`, 6000);
      terminarNavegacion();
    }
  }

  async function recalcular(p) {
    const nav = st.nav;
    nav.recalculando = true;
    $('#gnTexto').textContent = 'Recalculando la ruta…';
    try {
      const puntos = [{ lat: p[0], lng: p[1] }];
      if (nav.ruta.parada && (nav.paradaKm == null || nav.kmAct < nav.paradaKm - 0.05)) puntos.push({ lat: nav.ruta.parada.e.lat, lng: nav.ruta.parada.e.lng });
      puntos.push(st.destino);
      const [r] = await osrm(puntos, { excluir: nav.ruta.excluir });
      if (st.nav !== nav) return;
      const nueva = prepararNav({ ...r, parada: puntos.length === 3 ? nav.ruta.parada : null });
      Object.assign(nav, { ...nueva, voz: nav.voz, marca: nav.marca, watch: nav.watch, wake: nav.wake, simulada: nav.simulada, seguir: nav.seguir, pos: nav.pos, prev: nav.prev });
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
    st.nav = { ...prepararNav(ruta), voz: leer('gm.gps.voz', true), simulada: simular };
    document.body.classList.add('navegando');
    pintarNavUI();
    pintarMapa({ encuadrar: false });
    setTimeout(() => app.mapa.invalidateSize(), 50);
    app.mapa.on('dragstart', alArrastrar);
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
      const paso = Math.max(0.03, nav.total / 400);
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
      (pos) => actualizarNav(pos.coords.latitude, pos.coords.longitude, pos.coords.heading),
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
    setTimeout(() => {
      A().mapa.invalidateSize();
      pintarMapa();
    }, 50);
  }

  /* ---------------- Integración con la app ---------------- */
  window.GasoGPS = {
    // Se llama al cambiar de pestaña
    alCambiar(p) {
      if (p === 'gps') {
        montar();
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
      } else if (!st.nav) limpiarMapa();
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
