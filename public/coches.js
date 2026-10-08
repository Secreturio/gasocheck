/* GasoCheck — Mis coches: varios coches, cada uno con su foto, bastidor y mediciones de consumo.
   Se usa en el perfil (apartado Mi coche) y en la pestaña Mi coche.
   Los datos van en los ajustes (ajustes.coches y ajustes.cocheActivo), que se sincronizan con la cuenta. */
(() => {
  'use strict';
  const API = (window.GASOCHECK_API || '').replace(/\/$/, '');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const A = () => window.GasoApp;
  const avisar = (m, ms) => A()?.avisar(m, ms);
  const num = (n, d = 2) => Number(n).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
  const decimal = (v) => {
    const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const hoyISO = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());

  const MARCAS = ['Abarth', 'Alfa Romeo', 'Audi', 'BMW', 'BYD', 'Citroën', 'Cupra', 'Dacia', 'DS', 'Fiat', 'Ford', 'Honda', 'Hyundai', 'Jaguar', 'Jeep', 'Kia', 'Land Rover', 'Lexus', 'Mazda', 'Mercedes-Benz', 'MG', 'Mini', 'Mitsubishi', 'Nissan', 'Opel', 'Peugeot', 'Porsche', 'Renault', 'Seat', 'Skoda', 'Smart', 'SsangYong', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo'];
  const COMBUSTIBLES = { gasoleoA: 'Diésel (gasóleo A)', gasolina95: 'Gasolina 95', gasolina98: 'Gasolina 98', gasoleoPremium: 'Diésel premium', glp: 'Autogás (GLP)' };
  const SILUETA = '<svg class="silueta" viewBox="0 0 120 50" aria-hidden="true"><path d="M8 38v-9c0-3 2-5 5-6l14-4 12-9c3-2 6-3 10-3h22c4 0 7 1 10 4l10 9 14 3c4 1 7 4 7 8v7c0 2-1 3-3 3h-6M32 41H52M8 38c0 2 1 3 3 3h6"/><circle cx="24" cy="40" r="7"/><circle cx="92" cy="40" r="7"/><path d="M40 19h52M66 9v10"/></svg>';

  /* ---------- Datos ---------- */
  const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const lista = () => A()?.ajustes().coches || [];
  const activo = () => {
    const cs = lista();
    return cs.find((c) => c.id === A().ajustes().cocheActivo) || cs[0] || null;
  };
  const fotoIdDe = (c) => c.fotoId || 'coche-' + c.id;
  const nombre = (c) => window.MiCoche.nombreCoche(c);
  // Guarda la lista de coches. El consumo de la calculadora de ahorro es el del coche elegido.
  function guardar(coches, activoId) {
    const act = coches.find((c) => c.id === activoId) || coches[0] || null;
    const media = act ? window.MiCoche.consumoMedio(act.mediciones) : null;
    A().guardarAjustes({ coches, cocheActivo: act?.id || null, ...(media ? { consumo: media } : {}) });
  }
  function elegir(id) {
    const c = lista().find((x) => x.id === id);
    if (!c) return;
    guardar(lista(), id);
    if (c.combustible) A().elegirCombustible(c.combustible);
  }

  /* ---------- Fotos ---------- */
  // La tuya si la has subido; si no, una foto orientativa del modelo (Wikimedia Commons, vía nuestro servidor)
  const cache = new Map();
  async function obtenerFoto(c) {
    if (c.fotoPropia && window.GasoFotos) {
      const u = await window.GasoFotos.url(fotoIdDe(c)).catch(() => null);
      if (u) return { src: u, credito: 'Tu foto', propia: true };
    }
    if (!c.marca || !c.modelo) return { src: null, motivo: 'Guarda la marca y el modelo para ver una foto.' };
    const k = [c.marca, c.modelo, c.anio || ''].join('|').toLowerCase().trim();
    if (!cache.has(k)) {
      cache.set(k, fetch(`${API}/api/coche/foto?marca=${encodeURIComponent(c.marca)}&modelo=${encodeURIComponent(c.modelo)}&anio=${encodeURIComponent(c.anio || '')}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || 'No se pudo buscar la foto.');
          return d;
        }));
    }
    try {
      const r = await cache.get(k);
      if (!r.foto) {
        cache.delete(k); // se reintentará la próxima vez
        return { src: null, motivo: r.motivo || 'No hemos encontrado una foto de este modelo. Puedes usar la tuya.' };
      }
      const f = r.foto;
      return {
        src: `${API}/api/coche/foto/${f.id}`,
        credito: `Foto de un ${esc(c.marca)} ${esc(c.modelo)} de ${esc(c.anio)} (<a href="${esc(f.articuloUrl)}" target="_blank" rel="noopener">${esc(f.articulo)}</a>): puede no coincidir con tu versión o color. Autor: <a href="${esc(f.pagina)}" target="_blank" rel="noopener">${esc(f.autor)}</a> · ${esc(f.licencia)} · Wikimedia Commons`,
      };
    } catch (e) {
      cache.delete(k);
      return { src: null, motivo: e.message };
    }
  }
  function ponerImagen(caja, src, alt) {
    caja.innerHTML = '';
    if (!src) {
      caja.innerHTML = SILUETA;
      return;
    }
    const img = new Image();
    img.alt = alt;
    img.decoding = 'async';
    img.onerror = () => { caja.innerHTML = SILUETA; };
    img.src = src;
    caja.appendChild(img);
  }
  // Pinta la foto en una figura .coche-foto. Si mientras tanto se pide otra, gana la última.
  async function fotoEn(fig, c) {
    if (!fig || !c) return;
    const turno = (fig._turno = (fig._turno || 0) + 1);
    const cred = $('.coche-credito', fig);
    if (cred && c.marca && c.modelo && !c.fotoPropia) cred.textContent = 'Buscando una foto del modelo…';
    const r = await obtenerFoto(c);
    if (!fig.isConnected || fig._turno !== turno) return;
    // Si no hay foto de tu modelo y año, no se pone ninguna
    fig.classList.toggle('sin-foto', !r.src);
    ponerImagen($('.coche-img', fig), r.src, r.propia ? 'Foto de tu coche' : `Foto de un ${nombre(c)}`);
    if (cred) cred.innerHTML = r.src ? r.credito : esc(r.motivo || '');
  }

  /* ---------- Galería: una tarjeta con foto por coche ---------- */
  // modo 'elegir': marca el coche activo · modo 'filtro': se puede marcar uno o ninguno
  function galeriaHTML({ seleccion = null, anadir = true, modo = 'elegir', titulo = '' } = {}) {
    const cs = lista();
    return `<div class="galeria-coches" role="group" aria-label="${esc(titulo || 'Mis coches')}">
      ${cs.map((c) => `<button type="button" class="coche-chip" data-coche="${esc(c.id)}" aria-pressed="${c.id === seleccion}" title="${modo === 'filtro' ? 'Ver solo los repostajes de este coche (pulsa otra vez para ver todos)' : 'Elegir este coche'}">
        <span class="chip-img">${SILUETA}</span>
        <span class="chip-txt"><b>${esc(nombre(c))}</b><small>${c.anio ? esc(c.anio) : '&nbsp;'}</small></span>
      </button>`).join('')}
      ${anadir ? `<button type="button" class="coche-chip nuevo" data-coche="nuevo"><span class="chip-img"><span class="mas">+</span></span><span class="chip-txt"><b>Añadir coche</b><small>&nbsp;</small></span></button>` : ''}
    </div>`;
  }
  function cargarMiniaturas(el) {
    $$('.coche-chip[data-coche]:not(.nuevo)', el).forEach(async (b) => {
      const c = lista().find((x) => x.id === b.dataset.coche);
      if (!c) return;
      const r = await obtenerFoto(c);
      if (b.isConnected) ponerImagen($('.chip-img', b), r.src, '');
    });
  }

  /* ---------- Editor del coche elegido ---------- */
  let creando = false; // true: el formulario es para un coche nuevo
  const empezarNuevo = () => { creando = true; };

  function pintarGestor(el, { conGaleria = true, alCambiar } = {}) {
    if (!el) return;
    const refrescar = alCambiar || (() => pintarGestor(el, { conGaleria, alCambiar }));
    const cs = lista();
    if (!cs.length) creando = true;
    const c = creando ? { id: null, combustible: A().estado.combustible } : activo();
    const anioMax = new Date().getFullYear() + 1;
    el.innerHTML = `
      ${conGaleria && cs.length ? galeriaHTML({ seleccion: creando ? null : c.id }) : ''}
      <div class="editor-coche">
        <figure class="coche-foto ${creando ? 'sin-foto' : ''}" aria-live="polite">
          <div class="coche-img">${SILUETA}</div>
          <figcaption>
            <b>${creando ? (cs.length ? 'Nuevo coche' : 'Añade tu coche') : esc(nombre(c)) + (c.anio ? ' · ' + esc(c.anio) : '')}</b>
            <span class="coche-credito">${creando ? 'Escribe la marca y el modelo y verás aquí una foto.' : ''}</span>
          </figcaption>
          ${creando ? '' : `<div class="coche-foto-acc">
            <label class="boton" for="cFotoPropia">${c.fotoPropia ? 'Cambiar mi foto' : 'Usar mi propia foto'}</label>
            <input type="file" id="cFotoPropia" accept="image/*" class="sr">
            ${c.fotoPropia ? '<button type="button" class="boton" id="bQuitarFoto">Volver a la foto del modelo</button>' : ''}
          </div>`}
        </figure>
        <form id="fCoche" class="form-coche" novalidate>
          <div class="vin ancho">
            <label for="cVin">Número de bastidor (VIN, opcional)<input id="cVin" maxlength="24" autocomplete="off" spellcheck="false" placeholder="17 letras y números" value="${esc(c.vin || '')}"></label>
            <button type="button" class="boton" id="bVin">Rellenar con el bastidor</button>
            <p class="texto-ayuda ancho" id="vinRes">Está en el permiso de circulación (casilla E) y en la ficha técnica. Lo leemos en tu dispositivo para sacar la marca y el año; no se envía a nadie.</p>
          </div>
          <label for="cMarca">Marca<input id="cMarca" list="listaMarcasCoche" autocomplete="off" maxlength="30" placeholder="Ej.: Seat" value="${esc(c.marca || '')}"></label>
          <datalist id="listaMarcasCoche">${MARCAS.map((m) => `<option value="${m}">`).join('')}</datalist>
          <label for="cModelo">Modelo<input id="cModelo" autocomplete="off" maxlength="40" placeholder="Ej.: León 1.5 TSI" value="${esc(c.modelo || '')}"></label>
          <label for="cAnio">Año<select id="cAnio"><option value="">Elige el año</option>${Array.from({ length: anioMax - 1979 }, (_, i) => anioMax - i).map((a) => `<option value="${a}" ${String(c.anio) === String(a) ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
          <label for="cComb">Combustible<select id="cComb">${Object.entries(COMBUSTIBLES).map(([k, n]) => `<option value="${k}" ${(c.combustible || 'gasoleoA') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label for="cDep" class="ancho">Capacidad del depósito (litros, opcional)<input id="cDep" inputmode="decimal" placeholder="50" value="${c.deposito ? String(c.deposito).replace('.', ',') : ''}"></label>
          <p class="error ancho" hidden></p>
          <div class="acciones ancho">
            <button class="boton primario" type="submit">${creando ? 'Guardar coche' : 'Guardar cambios'}</button>
            ${creando && cs.length ? '<button type="button" class="boton" id="bCancelarCoche">Cancelar</button>' : ''}
            ${!creando ? '<button type="button" class="boton texto-peligro" id="bBorrarCoche">Quitar este coche</button>' : ''}
          </div>
        </form>
      </div>`;

    const fig = $('.coche-foto', el);
    if (!creando) fotoEn(fig, c);
    if (conGaleria) cargarMiniaturas(el);

    $$('.coche-chip', el).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.coche === 'nuevo') creando = true;
      else {
        creando = false;
        elegir(b.dataset.coche);
      }
      refrescar();
    }));

    // La foto se actualiza al cambiar la marca, el modelo o el año (sin esperar a guardar)
    let espera = null;
    const vistaPrevia = () => {
      clearTimeout(espera);
      espera = setTimeout(() => {
        if (!creando && c.fotoPropia) return; // con foto propia, se queda la tuya
        const borrador = { marca: $('#cMarca', el).value.trim(), modelo: $('#cModelo', el).value.trim(), anio: $('#cAnio', el).value };
        if (borrador.marca && borrador.modelo) {
          $('figcaption b', fig).textContent = nombre(borrador) + (borrador.anio ? ' · ' + borrador.anio : '');
          fotoEn(fig, borrador);
        }
      }, 700);
    };
    ['#cMarca', '#cModelo'].forEach((s) => $(s, el).addEventListener('input', vistaPrevia));
    $('#cAnio', el).addEventListener('change', vistaPrevia);

    $('#bVin', el).addEventListener('click', () => {
      const d = window.MiCoche.decodificarVin($('#cVin', el).value);
      const res = $('#vinRes', el);
      if (!d.valido) {
        res.innerHTML = `<span class="texto-peligro">${esc(d.error)}</span>`;
        return;
      }
      $('#cVin', el).value = d.vin;
      if (d.marca) $('#cMarca', el).value = d.marca;
      if (d.anio && $(`#cAnio option[value="${d.anio}"]`, el)) $('#cAnio', el).value = String(d.anio);
      res.innerHTML = d.marca || d.anio
        ? `Según el bastidor: <b>${esc(d.marca || 'fabricante desconocido')}</b>${d.anio ? ` · año <b>${d.anio}</b>` : ' · el año no viene en el bastidor'}. Escribe el <b>modelo</b> (no viene en el bastidor) y pulsa Guardar.`
        : `No reconocemos el fabricante (código ${esc(d.wmi)}). Escribe la marca, el modelo y el año a mano.`;
      $('#cModelo', el).focus();
      vistaPrevia();
    });

    $('#fCoche', el).addEventListener('submit', (ev) => {
      ev.preventDefault();
      const err = $('#fCoche .error', el);
      const fallo = (m) => { err.textContent = m; err.hidden = false; };
      err.hidden = true;
      const marca = $('#cMarca', el).value.trim().slice(0, 30);
      const modelo = $('#cModelo', el).value.trim().slice(0, 40);
      const anio = $('#cAnio', el).value;
      const combustible = $('#cComb', el).value;
      const dep = decimal($('#cDep', el).value);
      if (!marca && !modelo) return fallo('Escribe al menos la marca o el modelo de tu coche.');
      if (dep != null && (dep < 10 || dep > 200)) return fallo('La capacidad del depósito debe estar entre 10 y 200 litros.');
      let vin = null;
      const vinTxt = $('#cVin', el).value.trim();
      if (vinTxt) {
        const d = window.MiCoche.decodificarVin(vinTxt);
        if (!d.valido) return fallo(d.error);
        vin = d.vin;
        if (lista().some((x) => x.vin === vin && x.id !== c.id)) return fallo('Ya tienes otro coche con ese número de bastidor.');
      }
      const datos = { marca, modelo, anio: anio ? Number(anio) : null, combustible, deposito: dep, vin };
      let cs2, id;
      if (creando) {
        id = nuevoId();
        cs2 = [...lista(), { id, ...datos, fotoPropia: false, mediciones: [] }];
      } else {
        id = c.id;
        cs2 = lista().map((x) => (x.id === id ? { ...x, ...datos } : x));
      }
      const eraNuevo = creando;
      creando = false;
      guardar(cs2, id);
      if (combustible !== A().estado.combustible) A().elegirCombustible(combustible);
      avisar(eraNuevo ? `${nombre(datos)} añadido` : 'Coche guardado');
      refrescar();
    });

    $('#bCancelarCoche', el)?.addEventListener('click', () => { creando = false; refrescar(); });
    $('#bBorrarCoche', el)?.addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      if (b.dataset.ok !== '1') {
        b.dataset.ok = '1';
        b.textContent = `¿Seguro? Pulsa para quitar ${nombre(c)}`;
        return;
      }
      if (c.fotoPropia) await window.GasoFotos?.borrar(fotoIdDe(c)).catch(() => {});
      const resto = lista().filter((x) => x.id !== c.id);
      guardar(resto, resto[0]?.id);
      avisar(`${nombre(c)} quitado. Sus repostajes se conservan.`, 4000);
      refrescar();
    });
    $('#cFotoPropia', el)?.addEventListener('change', async (ev) => {
      const f = ev.target.files?.[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) return avisar('Elige una imagen (JPG, PNG…).');
      try {
        $('.coche-credito', fig).textContent = 'Guardando tu foto…';
        await window.GasoFotos.guardar(fotoIdDe(c), f);
        guardar(lista().map((x) => (x.id === c.id ? { ...x, fotoPropia: true, fotoId: fotoIdDe(c) } : x)), c.id);
        avisar('Foto de tu coche guardada');
        refrescar();
      } catch (e) {
        avisar('No se pudo guardar la foto: ' + e.message, 5000);
      }
    });
    $('#bQuitarFoto', el)?.addEventListener('click', async () => {
      await window.GasoFotos?.borrar(fotoIdDe(c)).catch(() => {});
      guardar(lista().map((x) => (x.id === c.id ? { ...x, fotoPropia: false } : x)), c.id);
      refrescar();
    });
  }

  /* ---------- Consumo medio del coche elegido: litros ÷ km × 100 ---------- */
  function pintarConsumo(el, { alCambiar } = {}) {
    if (!el) return;
    const refrescar = alCambiar || (() => pintarConsumo(el, { alCambiar }));
    const c = activo();
    if (!c) {
      el.innerHTML = '<p class="texto-ayuda">Añade tu coche para calcular y guardar su consumo medio.</p>';
      return;
    }
    const meds = c.mediciones || [];
    const media = window.MiCoche.consumoMedio(meds);
    el.innerHTML = `<div class="calc-consumo">
        <h4>Calcular el consumo medio de tu ${esc(nombre(c))}</h4>
        <p class="texto-ayuda">Llena el depósito y pon a cero el cuentakilómetros parcial. En el siguiente repostaje, llena otra vez y apunta los litros que echaste y los km que marca.</p>
        <form id="fMedicion" class="form-coche" novalidate>
          <label for="mLitros">Litros que echaste<input id="mLitros" inputmode="decimal" placeholder="45,2" autocomplete="off"></label>
          <label for="mKm">Km que has hecho<input id="mKm" inputmode="decimal" placeholder="700" autocomplete="off"></label>
          <div class="resultado-consumo ancho" id="mRes" aria-live="polite"><span class="formula">Consumo = litros ÷ km × 100</span></div>
          <p class="error ancho" hidden></p>
          <button class="boton primario ancho" type="submit">Guardar medición</button>
        </form>
        ${meds.length ? `
        <div class="media-consumo">
          <span>Consumo medio · ${esc(nombre(c))}${c.anio ? ' (' + esc(c.anio) + ')' : ''}</span>
          <strong>${num(media)}</strong>
          <small>litros cada 100 km · ${meds.length} ${meds.length === 1 ? 'medición' : 'mediciones'}</small>
        </div>
        <p class="texto-ayuda">La media suma todos los litros y todos los km (${num(meds.reduce((a, m) => a + m.litros, 0), 1)} L ÷ ${num(meds.reduce((a, m) => a + m.km, 0), 0)} km × 100), para que un viaje largo cuente más que uno corto. La calculadora de ahorro de cada gasolinera usa el consumo del coche que tengas elegido.</p>
        <ul class="mediciones">${meds.slice().reverse().slice(0, 12).map((m) => `<li>
          <span class="m-fecha">${new Date(m.fecha + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
          <span class="m-datos">${num(m.litros, 1)} L ÷ ${num(m.km, 0)} km</span>
          <b>${num(m.consumo)}</b>
          <button type="button" class="enlace texto-peligro" data-borrar-med="${esc(m.id)}" aria-label="Quitar la medición del ${esc(m.fecha)}">Quitar</button></li>`).join('')}</ul>` : ''}
      </div>`;
    const calcular = () => {
      const l = decimal($('#mLitros', el).value), k = decimal($('#mKm', el).value);
      const r = window.MiCoche.consumo(l, k);
      $('#mRes', el).innerHTML = r == null
        ? '<span class="formula">Consumo = litros ÷ km × 100</span>'
        : `<span class="formula">${num(l, 1)} ÷ ${num(k, 0)} × 100 =</span> <strong>${num(r)}</strong> <span>l/100 km</span>${r < 2 || r > 30 ? '<span class="texto-peligro"> Es un consumo poco habitual: revisa los datos.</span>' : ''}`;
    };
    $('#mLitros', el).addEventListener('input', calcular);
    $('#mKm', el).addEventListener('input', calcular);
    const conMediciones = (nuevas) => lista().map((x) => (x.id === c.id ? { ...x, mediciones: nuevas } : x));
    $('#fMedicion', el).addEventListener('submit', (ev) => {
      ev.preventDefault();
      const err = $('#fMedicion .error', el);
      err.hidden = true;
      const l = decimal($('#mLitros', el).value), k = decimal($('#mKm', el).value);
      if (!(l > 0 && l <= 2000)) { err.textContent = 'Escribe los litros que echaste (por ejemplo 45,2).'; err.hidden = false; return; }
      if (!(k > 0 && k <= 100000)) { err.textContent = 'Escribe los km que has hecho desde el anterior llenado (por ejemplo 700).'; err.hidden = false; return; }
      const nuevas = [...meds, { id: nuevoId(), fecha: hoyISO(), litros: l, km: k, consumo: window.MiCoche.consumo(l, k) }].slice(-100);
      guardar(conMediciones(nuevas), c.id);
      avisar(`Consumo: ${num(window.MiCoche.consumo(l, k))} l/100 km · media ${num(window.MiCoche.consumoMedio(nuevas))}`, 4500);
      refrescar();
    });
    $$('[data-borrar-med]', el).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.ok !== '1') {
        b.dataset.ok = '1';
        b.textContent = '¿Seguro?';
        return;
      }
      guardar(conMediciones(meds.filter((m) => m.id !== b.dataset.borrarMed)), c.id);
      refrescar();
    }));
  }

  window.GasoCoches = {
    lista, activo, elegir, nombre, nuevoId, empezarNuevo,
    galeriaHTML, cargarMiniaturas, pintarGestor, pintarConsumo, fotoEn, obtenerFoto,
    silueta: () => SILUETA,
    fotoIdDe,
  };
})();
