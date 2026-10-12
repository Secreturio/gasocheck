/* GasoCheck — Mantenimiento del coche (apartado de «Mi coche»).
   Cada intervención: coche, tipo (mantenimiento o cambio de pieza), qué se hizo, pieza nueva o de desguace,
   fecha, kilometraje, precio, taller, notas y la factura (foto o PDF).
   Se guarda en ajustes.mantenimientos (se sincroniza con la cuenta) y la factura con GasoFotos (privada). */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const A = () => window.GasoApp;
  const C = () => window.GasoCoches;
  const num = (n, d = 2) => Number(n).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
  const decimal = (v) => {
    const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const hoyISO = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
  const nuevoId = () => 'mt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const MAX = 500;
  const MAX_PDF = 3 * 1024 * 1024;

  const svg = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICO = {
    llave: svg('<path d="M14.7 6.3a4.5 4.5 0 0 0-5.9 5.9L3.5 17.5a2 2 0 0 0 2.9 2.9l5.3-5.3a4.5 4.5 0 0 0 5.9-5.9l-2.7 2.7-2.4-.5-.5-2.4z"/>'),
    pieza: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3"/>'),
    factura: svg('<path d="M6 2.5h8.5L19 7v13.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z"/><path d="M14 2.5V7h5M8.5 12h7M8.5 15.5h7M8.5 8.5h3"/>'),
    taller: svg('<path d="M3 21V9l9-5.5L21 9v12"/><path d="M7 21v-7h10v7M7 17.5h10"/>'),
    km: svg('<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>'),
    euro: svg('<path d="M17.5 6.5A7 7 0 1 0 17.5 17.5M4 10h9M4 14h9"/>'),
    lapiz: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    papelera: svg('<path d="M4 7h16M10 3.5h4M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/>'),
    camara: svg('<path d="M4 8h3l1.6-2.5h6.8L17 8h3a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.3" r="3.6"/>'),
    mas: svg('<path d="M12 5v14M5 12h14"/>'),
    barras: svg('<path d="M6 20V12M12 20V5M18 20v-9"/>'),
    chevron: svg('<path d="M6 15l6-6 6 6"/>'),
  };
  const SUGERENCIAS = [
    'Cambio de aceite y filtros', 'Revisión oficial', 'ITV', 'Pastillas de freno', 'Discos de freno', 'Neumáticos',
    'Batería', 'Correa de distribución', 'Kit de embrague', 'Amortiguadores', 'Escobillas', 'Filtro de aire',
    'Filtro de habitáculo', 'Bujías', 'Líquido de frenos', 'Anticongelante', 'Recarga de aire acondicionado',
    'Alineación y equilibrado', 'Alternador', 'Motor de arranque', 'Faro', 'Retrovisor', 'Luna / parabrisas',
  ];

  const lista = () => (A().ajustes().mantenimientos || []).filter((x) => x && x.id);
  const guardarLista = (xs) => A().guardarAjustes({ mantenimientos: xs.slice(-MAX) });
  let filtro = null; // id de coche, 'todos' o null (= el coche elegido)
  let editando = null; // id de la intervención que se está editando
  let facturaNueva = null; // fichero elegido en el formulario
  let quitarFactura = false;

  // Factura: foto (se reduce) o PDF (tal cual)
  const esPDF = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
  async function guardarFactura(id, f) {
    if (esPDF(f)) {
      if (f.size > MAX_PDF) throw new Error('El PDF ocupa más de 3 MB. Haz una foto de la factura o usa un PDF más ligero.');
      const blob = f.type === 'application/pdf' ? f : new Blob([f], { type: 'application/pdf' });
      return { ...(await window.GasoFotos.guardar(id, blob, { directo: true })), tipo: 'pdf' };
    }
    return { ...(await window.GasoFotos.guardar(id, f)), tipo: 'img' };
  }
  const urlsPDF = new Map(); // se preparan al pintar, para abrir el PDF en el mismo toque
  async function verFactura(x) {
    if (x.facturaTipo !== 'pdf') return window.GasoFotos.ver(x.factura, `Factura · ${x.concepto}`);
    if (urlsPDF.has(x.factura) && window.open(urlsPDF.get(x.factura), '_blank')) return;
    // Se abre la pestaña antes de esperar (si no, el navegador la bloquea)
    const w = window.open('', '_blank');
    const u = await window.GasoFotos.url(x.factura);
    if (!u) {
      w?.close();
      return A().avisar('Esta factura no está disponible en este dispositivo.');
    }
    if (w) w.location.href = u;
    else {
      const a = document.createElement('a');
      a.href = u;
      a.download = `factura-${x.fecha}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  function pintar(el) {
    if (!el) return;
    const app = A();
    const coches = C().lista();
    const act = C().activo();
    if (!coches.length) {
      el.innerHTML = `<section class="rp-tarjeta rp-vacio"><span class="rp-ico grande">${ICO.llave}</span><p>Añade tu coche en <b>Datos del coche</b> para apuntar sus revisiones, reparaciones y piezas cambiadas.</p></section>`;
      return;
    }
    const varios = coches.length > 1;
    if (filtro !== 'todos' && !coches.some((c) => c.id === filtro)) filtro = null;
    const verCoche = filtro === 'todos' ? null : filtro || act?.id;
    const todas = lista();
    const xs = todas
      .filter((x) => !verCoche || x.coche === verCoche || (!varios && !coches.some((c) => c.id === x.coche)))
      .sort((a, b) => b.fecha.localeCompare(a.fecha) || (b.km || 0) - (a.km || 0));
    const ed = editando ? todas.find((x) => x.id === editando) : null;
    if (editando && !ed) editando = null;
    const anio = hoyISO().slice(0, 4);
    const total = xs.reduce((s, x) => s + (x.precio || 0), 0);
    const esteAnio = xs.filter((x) => x.fecha.startsWith(anio)).reduce((s, x) => s + (x.precio || 0), 0);
    const ultimo = xs[0];
    const kmMax = Math.max(0, ...xs.map((x) => x.km || 0));
    const nombreCoche = (id) => {
      const c = coches.find((k) => k.id === id);
      return c ? C().nombre(c) : '';
    };
    const formAbierto = Boolean(ed) || !xs.length || el.dataset.form === '1';
    const tipo = ed?.tipo || 'mantenimiento';
    const cocheForm = ed?.coche || verCoche || act?.id;

    const fila = (x) => {
      const f = new Date(x.fecha + 'T12:00:00');
      const etq = [
        `<span class="mt-etq ${x.tipo === 'pieza' ? 'pieza' : ''}">${x.tipo === 'pieza' ? 'Cambio de pieza' : 'Mantenimiento'}</span>`,
        x.tipo === 'pieza' && x.origen ? `<span class="mt-etq ${x.origen}">${x.origen === 'desguace' ? '♻ Desguace' : '✦ Pieza nueva'}</span>` : '',
        varios && !verCoche ? `<span class="mt-etq coche">${esc(nombreCoche(x.coche))}</span>` : '',
      ].join('');
      return `<li class="rp-item mt-item" data-mt="${esc(x.id)}">
        <div class="rp-dia"><span>${DIAS[f.getDay()]}</span><b>${f.getDate()}</b><span>${MESES[f.getMonth()]} ${String(f.getFullYear()).slice(2)}</span></div>
        <div class="mt-que"><b>${esc(x.concepto)}</b><div class="mt-etqs">${etq}</div></div>
        <div class="rp-cifras mt-cifras">
          <div><b>${x.precio != null ? num(x.precio) : '—'}<small> €</small></b><span>Precio</span></div>
          <div><b>${x.km ? x.km.toLocaleString('es-ES') : '—'}<small> km</small></b><span>Kilometraje</span></div>
        </div>
        <p class="rp-meta mt-meta">${ICO.taller}<span>${x.taller ? esc(x.taller) : 'Taller sin indicar'}</span>${x.notas ? `<span class="mt-notas">· ${esc(x.notas)}</span>` : ''}</p>
        <div class="rp-acc">
          ${x.factura
            ? `<button type="button" class="rp-btn" data-mt-factura="${esc(x.id)}">${ICO.factura}<span>Ver factura${x.facturaTipo === 'pdf' ? ' (PDF)' : ''}</span></button>`
            : `<label class="rp-btn" for="mtSubir-${esc(x.id)}">${ICO.camara}<span>Añadir factura</span></label>`}
          <input type="file" id="mtSubir-${esc(x.id)}" class="sr" accept="image/*,application/pdf" data-mt-subir="${esc(x.id)}">
          <button type="button" class="rp-btn" data-mt-editar="${esc(x.id)}">${ICO.lapiz}<span>Editar</span></button>
          <button type="button" class="rp-btn peligro" data-mt-borrar="${esc(x.id)}">${ICO.papelera}<span>Borrar</span></button>
        </div>
      </li>`;
    };

    el.innerHTML = `
      <header class="rp-tarjeta rp-cab mt-cab">
        <span class="cs-ico grande">${ICO.llave}</span>
        <h3>Mantenimiento<small>${verCoche ? esc(nombreCoche(verCoche)) : 'Todos tus coches'}</small></h3>
        <button type="button" class="rp-apuntar" id="mtAnadir" aria-controls="mtForm" aria-expanded="${formAbierto}">${ICO.mas}<span>Añadir</span></button>
      </header>
      ${varios ? `<div class="mt-filtro" role="group" aria-label="Ver el mantenimiento de">
        <button type="button" data-mt-ver="todos" aria-pressed="${!verCoche}">Todos</button>
        ${coches.map((c) => `<button type="button" data-mt-ver="${esc(c.id)}" aria-pressed="${verCoche === c.id}">${esc(C().nombre(c))}</button>`).join('')}
      </div>` : ''}
      <section class="rp-tarjeta mt-form-caja" id="mtForm" ${formAbierto ? '' : 'hidden'}>
        <div class="rp-form-cab"><span class="rp-ico">${ed ? ICO.lapiz : ICO.llave}</span><h4>${ed ? 'Editar intervención' : 'Apuntar mantenimiento o pieza'}</h4>${xs.length || ed ? '<button type="button" class="rp-cerrar" id="mtCerrar" aria-label="Cerrar el formulario">✕</button>' : ''}</div>
        <form id="fMant" class="mt-form" novalidate>
          ${varios
            ? `<label class="ancho" for="mtCoche">Coche<select id="mtCoche">${coches.map((c) => `<option value="${esc(c.id)}" ${c.id === cocheForm ? 'selected' : ''}>${esc(C().nombre(c))}${c.anio ? ' · ' + esc(c.anio) : ''}</option>`).join('')}</select></label>`
            : `<input type="hidden" id="mtCoche" value="${esc(coches[0].id)}">`}
          <fieldset class="ancho mt-seg" id="mtTipo">
            <legend>¿Qué le has hecho?</legend>
            <label><input type="radio" name="mtTipo" value="mantenimiento" ${tipo !== 'pieza' ? 'checked' : ''}><span>${ICO.llave}Mantenimiento</span></label>
            <label><input type="radio" name="mtTipo" value="pieza" ${tipo === 'pieza' ? 'checked' : ''}><span>${ICO.pieza}Cambio de pieza</span></label>
          </fieldset>
          <label class="ancho" for="mtConcepto"><span id="mtConceptoTxt">${tipo === 'pieza' ? 'Pieza cambiada' : 'Trabajo realizado'}</span><input id="mtConcepto" list="mtSug" maxlength="80" autocomplete="off" placeholder="${tipo === 'pieza' ? 'Ej.: pastillas de freno delanteras' : 'Ej.: cambio de aceite y filtros'}" value="${esc(ed?.concepto || '')}"></label>
          <datalist id="mtSug">${SUGERENCIAS.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
          <fieldset class="ancho mt-seg" id="mtOrigen" ${tipo === 'pieza' ? '' : 'hidden'}>
            <legend>La pieza es…</legend>
            <label><input type="radio" name="mtOrigen" value="nueva" ${ed?.origen !== 'desguace' ? 'checked' : ''}><span>✦ Nueva</span></label>
            <label><input type="radio" name="mtOrigen" value="desguace" ${ed?.origen === 'desguace' ? 'checked' : ''}><span>♻ De desguace</span></label>
          </fieldset>
          <label for="mtFecha">Fecha<input id="mtFecha" type="date" value="${esc(ed?.fecha || hoyISO())}" max="${hoyISO()}"></label>
          <label for="mtKm">Kilometraje<span class="cs-campo"><input id="mtKm" inputmode="numeric" placeholder="${kmMax ? kmMax.toLocaleString('es-ES') : '145.000'}" value="${ed?.km ? ed.km.toLocaleString('es-ES') : ''}"><span class="cs-ud">km</span></span></label>
          <label for="mtPrecio">Precio<span class="cs-campo"><input id="mtPrecio" inputmode="decimal" placeholder="120,00" value="${ed?.precio != null ? num(ed.precio).replace(/\./g, '') : ''}"><span class="cs-ud">€</span></span></label>
          <label for="mtTaller">Taller<input id="mtTaller" maxlength="60" list="mtTalleres" autocomplete="off" placeholder="Nombre del taller" value="${esc(ed?.taller || '')}"></label>
          <datalist id="mtTalleres">${[...new Set(todas.map((x) => x.taller).filter(Boolean))].map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          <div class="ancho mt-factura">
            <label class="boton" for="mtFactura">${ICO.factura}<span>${ed?.factura ? 'Cambiar factura' : 'Subir factura'}</span> <small>(foto o PDF, opcional)</small></label>
            <input type="file" id="mtFactura" class="sr" accept="image/*,application/pdf">
            <span id="mtFacturaEstado" class="texto-ayuda">${ed?.factura ? `Tiene factura guardada. <button type="button" class="enlace texto-peligro" id="mtQuitarFactura">Quitarla</button>` : 'Se guarda en privado: solo la ves tú.'}</span>
          </div>
          <label class="ancho" for="mtNotas"><span>Notas <small>(opcional)</small></span><textarea id="mtNotas" maxlength="300" rows="2" placeholder="Garantía, referencia de la pieza, próxima revisión…">${esc(ed?.notas || '')}</textarea></label>
          <p class="error ancho" id="mtError" hidden></p>
          <button class="boton primario ancho cs-guardar" type="submit"><span>${ed ? 'Guardar cambios' : 'Guardar'}</span></button>
        </form>
      </section>
      ${xs.length ? `
      <section class="rp-tarjeta rp-resumen">
        <div class="rp-resumen-cab"><span class="rp-ico grande">${ICO.barras}</span><div><b>${num(esteAnio)} €</b><span>gastado en ${anio}</span></div></div>
        <div class="rp-stats${verCoche ? '' : ' dos'}">
          <div><span class="rp-ico">${ICO.llave}</span><p><b>${xs.length}</b><span>${xs.length === 1 ? 'intervención' : 'intervenciones'}</span></p></div>
          <div><span class="rp-ico">${ICO.euro}</span><p><b>${num(total)}<small> €</small></b><span>en total</span></p></div>
          ${verCoche ? `<div><span class="rp-ico">${ICO.km}</span><p><b>${kmMax ? kmMax.toLocaleString('es-ES') : '—'}</b><span>km (último)</span></p></div>` : ''}
        </div>
        ${ultimo ? `<p class="mt-ultimo">Lo último: <b>${esc(ultimo.concepto)}</b> el ${new Date(ultimo.fecha + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}${ultimo.taller ? ` en ${esc(ultimo.taller)}` : ''}.</p>` : ''}
      </section>
      <section class="rp-tarjeta rp-mes mt-lista-caja">
        <ol class="rp-lista mt-lista">${xs.map(fila).join('')}</ol>
      </section>` : `<p class="rp-tarjeta rp-nota"><span class="rp-ico">${ICO.factura}</span><span>Apunta aquí las revisiones, reparaciones y piezas que le cambies${varios ? ' a cada coche' : ' al coche'}, con la factura. Tendrás todo el historial a mano para la próxima revisión, la ITV o si lo vendes.</span></p>`}`;

    activar(el, { xs, todas, ed });
  }

  function activar(el, { todas, ed }) {
    const app = A();
    const repintar = () => pintar(el);
    const form = $('#mtForm', el);
    facturaNueva = null;
    quitarFactura = false;
    for (const x of todas) if (x.facturaTipo === 'pdf' && x.factura) window.GasoFotos.url(x.factura).then((u) => u && urlsPDF.set(x.factura, u)).catch(() => {});

    $('#mtAnadir', el).addEventListener('click', () => {
      if (!form.hidden && !editando) {
        el.dataset.form = '';
        form.hidden = true;
        $('#mtAnadir', el).setAttribute('aria-expanded', 'false');
        return;
      }
      if (editando) {
        editando = null;
        el.dataset.form = '1';
        repintar();
        $('#mtForm', el).scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      el.dataset.form = '1';
      form.hidden = false;
      $('#mtAnadir', el).setAttribute('aria-expanded', 'true');
      form.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setTimeout(() => $('#mtConcepto', el)?.focus({ preventScroll: true }), 250);
    });
    $('#mtCerrar', el)?.addEventListener('click', () => {
      el.dataset.form = '';
      if (editando) {
        editando = null;
        return repintar();
      }
      form.hidden = true;
      $('#mtAnadir', el).setAttribute('aria-expanded', 'false');
    });
    $$('[data-mt-ver]', el).forEach((b) => b.addEventListener('click', () => {
      filtro = b.dataset.mtVer;
      repintar();
    }));
    // Tipo: con «cambio de pieza» se pregunta si es nueva o de desguace
    $$('input[name="mtTipo"]', el).forEach((r) => r.addEventListener('change', () => {
      const pieza = r.value === 'pieza' && r.checked;
      $('#mtOrigen', el).hidden = !pieza;
      $('#mtConceptoTxt', el).textContent = pieza ? 'Pieza cambiada' : 'Trabajo realizado';
      $('#mtConcepto', el).placeholder = pieza ? 'Ej.: pastillas de freno delanteras' : 'Ej.: cambio de aceite y filtros';
    }));
    $('#mtFactura', el).addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      facturaNueva = f || null;
      quitarFactura = false;
      const est = $('#mtFacturaEstado', el);
      if (!f) return;
      if (esPDF(f) && f.size > MAX_PDF) {
        facturaNueva = null;
        est.innerHTML = '<span class="texto-peligro">El PDF ocupa más de 3 MB. Haz una foto de la factura o usa un PDF más ligero.</span>';
        return;
      }
      est.innerHTML = `<span class="ok">✓ ${esc(f.name || 'Factura')} lista. Se guardará con la intervención.</span>`;
    });
    $('#mtQuitarFactura', el)?.addEventListener('click', () => {
      quitarFactura = true;
      facturaNueva = null;
      $('#mtFacturaEstado', el).textContent = 'La factura se quitará al guardar.';
    });

    $('#fMant', el).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('#mtError', el);
      err.hidden = true;
      const fallo = (m, campo) => {
        err.textContent = m;
        err.hidden = false;
        if (campo) $(campo, el)?.focus();
      };
      const tipo = $('input[name="mtTipo"]:checked', el)?.value || 'mantenimiento';
      const concepto = $('#mtConcepto', el).value.trim().slice(0, 80);
      const fecha = $('#mtFecha', el).value;
      const kmTxt = $('#mtKm', el).value.trim();
      const km = kmTxt ? Math.round(decimal(kmTxt.replace(/\./g, ''))) : null;
      const precioTxt = $('#mtPrecio', el).value.trim();
      const precio = precioTxt ? decimal(precioTxt) : null;
      if (!concepto) return fallo(tipo === 'pieza' ? 'Escribe qué pieza se cambió.' : 'Escribe qué se le hizo al coche.', '#mtConcepto');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha > hoyISO()) return fallo('Elige una fecha que no sea futura.', '#mtFecha');
      if (kmTxt && !(km >= 0 && km < 3000000)) return fallo('Escribe el kilometraje en números (por ejemplo 145000).', '#mtKm');
      if (precioTxt && !(precio >= 0 && precio < 1000000)) return fallo('Escribe el precio en euros (por ejemplo 120,50).', '#mtPrecio');
      const id = ed?.id || nuevoId();
      const entrada = {
        id,
        coche: $('#mtCoche', el).value,
        tipo,
        concepto,
        origen: tipo === 'pieza' ? $('input[name="mtOrigen"]:checked', el)?.value || 'nueva' : null,
        fecha,
        km,
        precio: precio != null ? Math.round(precio * 100) / 100 : null,
        taller: $('#mtTaller', el).value.trim().slice(0, 60),
        notas: $('#mtNotas', el).value.trim().slice(0, 300),
        factura: quitarFactura ? null : ed?.factura || null,
        facturaTipo: quitarFactura ? null : ed?.facturaTipo || null,
      };
      const boton = $('#fMant button[type=submit]', el);
      boton.disabled = true;
      let aviso = ed ? 'Cambios guardados' : 'Guardado en el mantenimiento';
      try {
        if (quitarFactura && ed?.factura) await window.GasoFotos.borrar(ed.factura).catch(() => {});
        if (facturaNueva) {
          try {
            const r = await guardarFactura('fac-' + id, facturaNueva);
            entrada.factura = 'fac-' + id;
            entrada.facturaTipo = r.tipo;
            if (window.Cuenta?.usuario() && !r.enCuenta) aviso += ' (la factura quedó solo en este dispositivo)';
          } catch (e) {
            aviso += `. ${e.message || 'No se pudo guardar la factura.'}`;
          }
        }
      } finally {
        boton.disabled = false;
      }
      const actual = lista();
      const i = actual.findIndex((x) => x.id === id);
      if (i >= 0) actual[i] = entrada;
      else actual.push(entrada);
      guardarLista(actual);
      // Si se apuntó para otro coche, se pasa a verlo
      if (filtro !== 'todos' && entrada.coche !== (filtro || C().activo()?.id)) filtro = entrada.coche;
      editando = null;
      el.dataset.form = '';
      app.avisar(aviso, 4000);
      repintar();
      $(`[data-mt="${CSS.escape(id)}"]`, el)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });

    $$('[data-mt-editar]', el).forEach((b) => b.addEventListener('click', () => {
      editando = b.dataset.mtEditar;
      repintar();
      $('#mtForm', el).scrollIntoView({ block: 'start', behavior: 'smooth' });
    }));
    $$('[data-mt-borrar]', el).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.paso !== 'confirmar') {
        b.dataset.paso = 'confirmar';
        (b.querySelector('span') || b).textContent = '¿Seguro? Pulsa otra vez';
        return;
      }
      const x = todas.find((y) => y.id === b.dataset.mtBorrar);
      if (x?.factura) window.GasoFotos.borrar(x.factura).catch(() => {});
      if (editando === x?.id) editando = null;
      guardarLista(lista().filter((y) => y.id !== b.dataset.mtBorrar));
      repintar();
    }));
    $$('[data-mt-factura]', el).forEach((b) => b.addEventListener('click', () => {
      const x = todas.find((y) => y.id === b.dataset.mtFactura);
      if (x) verFactura(x);
    }));
    $$('[data-mt-subir]', el).forEach((inp) => inp.addEventListener('change', async () => {
      const f = inp.files[0];
      const xs = lista();
      const x = xs.find((y) => y.id === inp.dataset.mtSubir);
      if (!f || !x) return;
      try {
        const r = await guardarFactura('fac-' + x.id, f);
        x.factura = 'fac-' + x.id;
        x.facturaTipo = r.tipo;
        guardarLista(xs);
        repintar();
        app.avisar(window.Cuenta?.usuario() && !r.enCuenta ? 'Factura guardada en este dispositivo (no se pudo subir a tu cuenta)' : 'Factura guardada');
      } catch (e) {
        app.avisar(e.message || 'No se pudo guardar la factura.');
      }
    }));
  }

  window.GasoMantenimiento = { pintar };
})();
