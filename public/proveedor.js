/* Panel de gasolinera: mis gasolineras, ficha, respuestas y reclamaciones */
(() => {
  'use strict';
  const API = (window.GASOCHECK_API || '').replace(/\/$/, '');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const leer = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const guardar = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };
  const hoy = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
  const NOMBRES = { gasoleoA: 'Gasóleo A', gasoleoPremium: 'Gasóleo Premium', gasolina95: 'Gasolina 95', gasolina98: 'Gasolina 98', glp: 'Autogás (GLP)' };
  const euros = (n) => (n == null ? '—' : n.toFixed(3).replace('.', ','));
  function hace(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return `hace ${Math.max(1, m)} min`;
    const h = Math.round(m / 60);
    return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
  }
  const ESTADOS = { pendiente: 'Pendiente de revisión', aprobada: 'Aprobada', rechazada: 'Rechazada', revocada: 'Revocada' };
  const raiz = $('#prov');
  let token = leer('gm.token');
  let panel = null;
  let todas = null; // listado de gasolineras para reclamar

  let avisoT;
  function avisar(m, ms = 3500) {
    const a = $('#aviso');
    a.textContent = m;
    a.hidden = false;
    clearTimeout(avisoT);
    avisoT = setTimeout(() => (a.hidden = true), ms);
  }

  async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
    const r = await fetch(API + ruta, {
      method: metodo,
      headers: { ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(d.error || `Error ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return d;
  }

  function pantallaEntrar(msg = '') {
    raiz.innerHTML = `
      <div class="prov-cab"><div class="marca-prov"><img src="img/logo.png" alt="GasoCheck" width="40" height="48"><div><h1>Panel de gasolinera</h1><p>Entra con tu cuenta de gasolinera.</p></div></div></div>
      <form id="fEntrar" class="form-cuenta entrar-prov" novalidate>
        <label class="campo" for="eEmail">Correo electrónico<input id="eEmail" type="email" autocomplete="email" required></label>
        <label class="campo" for="ePass">Contraseña<input id="ePass" type="password" autocomplete="current-password" required></label>
        <p class="error" id="eError" ${msg ? '' : 'hidden'}>${esc(msg)}</p>
        <button class="boton primario" type="submit">Entrar</button>
        <p class="texto-ayuda">¿No tienes cuenta? Créala desde <a href="./">GasoCheck</a> → Entrar → “Tengo una gasolinera”.</p>
      </form>`;
    $('#fEntrar').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const r = await api('/api/auth/entrar', { metodo: 'POST', cuerpo: { email: $('#eEmail').value, password: $('#ePass').value } });
        token = r.token;
        guardar('gm.token', r.token);
        guardar('gm.usuario', r.usuario);
        cargar();
      } catch (e) {
        $('#eError').textContent = e.message;
        $('#eError').hidden = false;
      }
    });
  }

  async function cargar() {
    if (!token) return pantallaEntrar();
    try {
      panel = await api('/api/proveedor/panel');
      pintar();
    } catch (e) {
      if (e.status === 401) {
        token = null;
        guardar('gm.token', null);
        return pantallaEntrar('Tu sesión ha caducado. Vuelve a entrar.');
      }
      if (e.status === 403) {
        raiz.innerHTML = `<div class="prov-cab"><div><h1>Panel de gasolinera</h1></div></div>
          <p>Has entrado con una cuenta personal. Este panel es para cuentas de gasolinera.</p>
          <p><a class="boton" href="./">Volver a GasoCheck</a></p>`;
        return;
      }
      raiz.innerHTML = `<p class="error">${esc(e.message)}</p><button class="boton" type="button" onclick="location.reload()">Reintentar</button>`;
    }
  }

  const estrellas = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

  function tarjetaEstacion(e) {
    const q = e.calidad.resumen;
    const f = e.ficha;
    const alerta = q.alerta;
    const servs = Object.entries(panel.servicios)
      .map(([k, t]) => `<label><input type="checkbox" name="serv" value="${k}" ${f.servicios.includes(k) ? 'checked' : ''}> ${esc(t)}</label>`)
      .join('');
    const vals = e.calidad.reportes.length
      ? `<ul class="vals">${e.calidad.reportes
          .slice(0, 15)
          .map(
            (r) => `<li>
          <div class="cab"><span><b>${estrellas(r.puntuacion)}</b> ${r.autor ? esc(r.autor) : 'Anónimo'}</span><span>${new Date(r.fecha).toLocaleDateString('es-ES')}</span></div>
          ${r.problemas.length ? `<p class="tags">${r.problemas.map((p) => esc(panel.problemas[p] || p)).join(' · ')}</p>` : ''}
          ${r.comentario ? `<p>${esc(r.comentario)}</p>` : ''}
          <form class="resp" data-r="${esc(r.id)}">
            <label class="sr" for="resp-${esc(r.id)}">Tu respuesta</label>
            <textarea id="resp-${esc(r.id)}" maxlength="500" placeholder="Responde de forma pública y educada">${esc(r.respuesta?.texto || '')}</textarea>
            <button class="boton" type="submit">${r.respuesta ? 'Actualizar respuesta' : 'Responder'}</button>
          </form></li>`
          )
          .join('')}</ul>`
      : '<p class="texto-ayuda">Aún no hay valoraciones en los últimos 12 meses.</p>';

    return `<article class="tarjeta" data-est="${esc(e.id)}">
      <div><h3>${esc(e.rotulo || 'Gasolinera ' + e.id)}</h3><p class="dir">${esc([e.direccion, e.localidad, e.provincia].filter(Boolean).join(', '))} · <a href="./#e${esc(e.id)}" target="_blank" rel="noopener">Ver en el mapa</a></p></div>
      ${alerta ? `<div class="banner-alerta"><b>⚠ Alerta de calidad activa</b>${alerta.n} conductores han reportado “${esc(alerta.texto)}” en 7 días. Revisa tus depósitos y responde a las valoraciones.</div>` : ''}
      <div class="cifras">
        <div class="${q.puntuacion != null && q.puntuacion < 5 ? 'mal' : ''}"><span>Nota de calidad</span><strong>${q.puntuacion != null ? q.puntuacion.toFixed(1).replace('.', ',') : '—'}</strong></div>
        <div><span>Valoraciones (12 meses)</span><strong>${q.total}</strong></div>
        <div><span>Visitas a la ficha (30 días)</span><strong>${e.visitas30}</strong></div>
        <div><span>Promoción</span><strong style="font-size:18px">${f.promocion ? 'Activa' : 'No'}</strong></div>
      </div>
      <section>
        <h2>Tus precios</h2>
        <p class="texto-ayuda">Publica tus precios aunque el Ministerio aún no los tenga o no estén actualizados. En la app se verán <b>junto al oficial</b>, nunca en su lugar, con la hora a la que los publicaste. Mantenlos al día: si 3 clientes con cuenta indican que el precio real es otro, se mostrará el suyo en lugar del tuyo hasta que publiques uno nuevo. Deja una casilla vacía para retirar un precio.</p>
        <form class="form-precios" novalidate>
          <div class="tabla-precios" role="table">
            <div role="row" class="tp-cab"><span role="columnheader">Combustible</span><span role="columnheader">Ministerio</span><span role="columnheader">Tu precio (€/l)</span><span role="columnheader">Publicado</span></div>
            ${panel.combustibles
              .map((k) => {
                const d = f.precios?.[k];
                const of = e.oficiales?.[k];
                const propio = d ? (d.origen === 'usuarios' ? d.declarado : d) : null;
                const pend = e.correcciones?.[k];
                const nota = d && d.origen === 'usuarios'
                  ? `<span class="aviso-corr fuerte">${d.n} clientes indican ${euros(d.precio)} €. Se muestra en lugar del tuyo.</span>`
                  : pend ? `<span class="aviso-corr">${pend.n} cliente${pend.n === 1 ? '' : 's'} indica${pend.n === 1 ? '' : 'n'} otro precio (${pend.precios.map(euros).join(', ')} €)</span>` : '';
                return `<div role="row"><span role="cell">${NOMBRES[k] || k}</span><span role="cell" class="num">${euros(of)}</span>
                  <span role="cell"><label class="sr" for="pr-${esc(e.id)}-${k}">Tu precio de ${NOMBRES[k] || k}</label><input id="pr-${esc(e.id)}-${k}" name="${k}" inputmode="decimal" placeholder="${of != null ? euros(of) : '1,459'}" value="${propio ? euros(propio.precio) : ''}"></span>
                  <span role="cell" class="texto-ayuda">${propio ? hace(propio.fecha) : '—'}</span>${nota ? `<span role="cell" class="ancho-fila">${nota}</span>` : ''}</div>`;
              })
              .join('')}
          </div>
          <p class="error" hidden></p>
          <button class="boton primario" type="submit">Publicar precios</button>
        </form>
      </section>
      <details>
        <summary>Editar la ficha pública</summary>
        <form class="form-ficha" novalidate>
          <fieldset class="servs ancho"><legend>Servicios</legend>${servs}</fieldset>
          <label>Teléfono<input name="telefono" value="${esc(f.telefono)}" inputmode="tel"></label>
          <label>Web<input name="web" value="${esc(f.web)}" placeholder="www.tugasolinera.es"></label>
          <label class="ancho">Descripción (máx. 400)<textarea name="descripcion" maxlength="400">${esc(f.descripcion)}</textarea></label>
          <label class="ancho">Promoción (máx. 140, vacía para quitarla)<input name="promoTexto" maxlength="140" value="${esc(f.promocion?.texto || '')}" placeholder="Ej.: Lavado gratis repostando 40 litros"></label>
          <label>Válida hasta<input name="promoHasta" type="date" min="${hoy()}" value="${esc(f.promocion?.hasta || '')}"></label>
          <p class="error ancho" hidden></p>
          <button class="boton primario ancho" type="submit">Guardar ficha</button>
          <p class="texto-ayuda ancho">Recuerda que el precio oficial lo comunicas al Ministerio a través del Geoportal de Gasolineras; aquí solo publicas el tuyo al lado.</p>
        </form>
      </details>
      <section class="pro-caja" data-pro="${esc(e.id)}">${panel.cuenta.plan?.pro ? '<p class="texto-ayuda">Cargando estadísticas Pro…</p>' : proBloqueado()}</section>
      <div><h2>Valoraciones</h2>${vals}</div>
    </article>`;
  }

  function pintar() {
    const c = panel.cuenta;
    const pendientes = panel.reclamaciones.filter((r) => r.estado === 'pendiente').length;
    raiz.innerHTML = `
      <div class="prov-cab">
        <div class="marca-prov"><img src="img/logo.png" alt="GasoCheck" width="40" height="48"><div><h1>${esc(c.proveedor?.empresa || c.alias)}</h1><p>GasoCheck para gasolineras · ${esc(c.email)}${c.plan?.pro && !c.plan?.gratis ? ' · <span class="ins-pro">PRO</span>' : ''}</p></div></div>
        <div class="acciones"><a class="boton" href="./">Ir al mapa</a><button class="boton" type="button" id="bSalir">Cerrar sesión</button></div>
      </div>
      ${c.verificado ? '' : `<div class="aviso-cuenta"><p><b>Confirma tu correo</b> para poder reclamar gasolineras.</p><button class="boton" type="button" id="bReenviar">Reenviar el correo</button></div>`}
      <section>
        <h2>Mis gasolineras (${panel.estaciones.length})</h2>
        ${panel.estaciones.length
          ? panel.estaciones.map(tarjetaEstacion).join('')
          : `<p class="texto-ayuda">${pendientes ? 'Tus reclamaciones están en revisión. Te avisaremos cuando estén aprobadas.' : 'Todavía no tienes gasolineras. Búscalas abajo y reclámalas.'}</p>`}
      </section>
      <section>
        <h2>Mis reclamaciones</h2>
        ${panel.reclamaciones.length
          ? `<ul class="lista-rec">${panel.reclamaciones
              .map((r) => `<li><span>${esc(r.gasolinera.rotulo || r.estacion)} · ${esc(r.gasolinera.localidad || '')}</span><span><span class="estado ${r.estado}">${ESTADOS[r.estado] || r.estado}</span>${r.nota ? ` <small>${esc(r.nota)}</small>` : ''}</span></li>`)
              .join('')}</ul>`
          : '<p class="texto-ayuda">Ninguna todavía.</p>'}
      </section>
      <section class="tarjeta">
        <h2>Reclamar una gasolinera</h2>
        <p class="texto-ayuda">Busca por código postal, municipio, calle o marca. Revisamos cada reclamación a mano antes de activarla: indica cómo podemos comprobar que la gestionas.</p>
        <div class="buscar-gas"><label class="sr" for="bGas">Buscar gasolinera</label><input id="bGas" type="search" placeholder="Ej.: 42146 o Abejar Repsol" ${c.verificado ? '' : 'disabled'}></div>
        <ul class="resultados" id="resultados"></ul>
      </section>`;

    $('#bSalir').addEventListener('click', async () => {
      await api('/api/auth/salir', { metodo: 'POST', cuerpo: {} }).catch(() => {});
      token = null;
      guardar('gm.token', null);
      guardar('gm.usuario', null);
      pantallaEntrar();
    });
    $('#bReenviar')?.addEventListener('click', async (ev) => {
      try {
        await api('/api/auth/reenviar', { metodo: 'POST', cuerpo: {} });
        ev.target.textContent = 'Enviado';
      } catch (e) {
        avisar(e.message);
      }
    });

    // Editar ficha
    $$('.form-ficha').forEach((f) =>
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const id = f.closest('[data-est]').dataset.est;
        const err = $('.error', f);
        err.hidden = true;
        const texto = f.promoTexto.value.trim();
        if (texto && !f.promoHasta.value) {
          err.textContent = 'Indica hasta cuándo es válida la promoción.';
          err.hidden = false;
          return;
        }
        try {
          await api(`/api/proveedor/estaciones/${encodeURIComponent(id)}/ficha`, {
            metodo: 'POST',
            cuerpo: {
              servicios: $$('input[name="serv"]:checked', f).map((i) => i.value),
              telefono: f.telefono.value,
              web: f.web.value,
              descripcion: f.descripcion.value,
              promocion: texto ? { texto, hasta: f.promoHasta.value } : null,
            },
          });
          avisar('Ficha guardada. Ya es visible en el mapa.');
          cargar();
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
        }
      })
    );

    // GasoCheck Pro: estadísticas y mensajes a clientes
    if (panel.cuenta.plan?.pro) $$('[data-pro]').forEach((caja) => cargarPro(caja, caja.dataset.pro));

    // Publicar precios
    $$('.form-precios').forEach((f) =>
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const id = f.closest('[data-est]').dataset.est;
        const err = $('.error', f);
        err.hidden = true;
        const precios = {};
        for (const i of $$('input', f)) {
          const v = i.value.trim().replace(',', '.');
          precios[i.name] = v === '' ? null : v;
        }
        try {
          await api(`/api/proveedor/estaciones/${encodeURIComponent(id)}/precios`, { metodo: 'POST', cuerpo: { precios } });
          avisar('Precios publicados');
          cargar();
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
        }
      })
    );

    // Responder valoraciones
    $$('.resp').forEach((f) =>
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        try {
          await api(`/api/proveedor/reportes/${encodeURIComponent(f.dataset.r)}/respuesta`, { metodo: 'POST', cuerpo: { texto: $('textarea', f).value } });
          avisar($('textarea', f).value.trim() ? 'Respuesta publicada' : 'Respuesta eliminada');
          $('button', f).textContent = $('textarea', f).value.trim() ? 'Actualizar respuesta' : 'Responder';
        } catch (e) {
          avisar(e.message, 5000);
        }
      })
    );

    // Buscar y reclamar
    let t;
    $('#bGas').addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(buscar, 250);
    });
  }

  function proBloqueado() {
    return `<div class="pro-bloqueado"><h2><span class="ins-pro">PRO</span> Más con GasoCheck Pro</h2>
      <ul><li>Tu precio frente a la competencia a menos de 5 km, combustible a combustible</li><li>Evolución de tu nota mes a mes</li><li>Visitas a tu ficha día a día</li><li>Mensajes a los clientes que te tienen en favoritas (uno por semana)</li></ul>
      <p class="texto-ayuda">La nota y el orden en el mapa no se pueden comprar: Pro no cambia cómo te ven los conductores. Escríbenos para activarlo.</p></div>`;
  }

  async function cargarPro(caja, id) {
    try {
      const d = await api(`/api/proveedor/estaciones/${encodeURIComponent(id)}/estadisticas`);
      const comp = Object.entries(d.competencia);
      const maxV = Math.max(1, ...d.visitas.map((v) => v.n));
      const dias = [];
      for (let i = 29; i >= 0; i--) {
        const dia = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
        dias.push({ dia, n: d.visitas.find((v) => v.dia === dia)?.n || 0 });
      }
      const totalVis = dias.reduce((a, x) => a + x.n, 0);
      caja.innerHTML = `<h2>${panel.cuenta.plan?.gratis ? '' : '<span class="ins-pro">PRO</span> '}Estadísticas</h2>
        <h3 class="sub-pro">Tu precio frente a la competencia (a menos de ${d.radioKm} km)</h3>
        ${comp.length ? `<div class="tabla-pro"><table><thead><tr><th>Combustible</th><th class="num">Tu precio</th><th class="num">Posición</th><th class="num">Media zona</th><th class="num">Más barata</th><th class="num">Más cara</th></tr></thead><tbody>${comp
          .map(([c, x]) => `<tr><td>${NOMBRES[c] || c}</td><td class="num"><b>${euros(x.tuPrecio)}</b></td><td class="num ${x.posicion === 1 ? 'ok' : x.posicion > x.de / 2 ? 'ko' : ''}">${x.posicion}.ª de ${x.de}</td><td class="num">${euros(x.media)}</td><td class="num">${euros(x.min)}</td><td class="num">${euros(x.max)}</td></tr>`)
          .join('')}</tbody></table></div>` : '<p class="texto-ayuda">No hay otras gasolineras a menos de 5 km.</p>'}
        <h3 class="sub-pro">Visitas a tu ficha: ${totalVis} en 30 días</h3>
        <div class="barras-vis" role="img" aria-label="Visitas diarias de los últimos 30 días">${dias.map((x) => `<i style="height:${Math.max(3, Math.round((x.n / maxV) * 100))}%" title="${x.dia}: ${x.n}"></i>`).join('')}</div>
        <h3 class="sub-pro">Nota media por mes</h3>
        ${d.notaMensual.length ? `<ul class="nota-mes">${d.notaMensual.map((m) => `<li><span>${new Date(m.mes + '-15').toLocaleDateString('es-ES', { month: 'short', year: '2-digit' })}</span><b>${m.media.toFixed(1).replace('.', ',')} ★</b><small>${m.n}</small></li>`).join('')}</ul>` : '<p class="texto-ayuda">Sin valoraciones en los últimos 6 meses.</p>'}
        <h3 class="sub-pro">Mensaje a tus clientes</h3>
        <p class="texto-ayuda">${d.seguidores} ${d.seguidores === 1 ? 'persona te tiene' : 'personas te tienen'} en favoritas. Les llegará como aviso en la app${d.ultimoMensaje ? `. Último: “${esc(d.ultimoMensaje.texto)}” (${new Date(d.ultimoMensaje.fecha).toLocaleDateString('es-ES')}, ${d.ultimoMensaje.enviados} personas)` : ''}.</p>
        <form class="msg-pro" novalidate><label class="sr" for="msg-${esc(id)}">Mensaje</label><textarea id="msg-${esc(id)}" maxlength="160" placeholder="Ej.: Esta semana, lavado gratis repostando 40 litros"></textarea>
          <div class="acciones"><button class="boton primario" type="submit" ${d.seguidores ? '' : 'disabled'}>Enviar a ${d.seguidores} ${d.seguidores === 1 ? 'cliente' : 'clientes'}</button><span class="texto-ayuda">Uno por semana · máx. 160 caracteres</span></div>
          <p class="error" hidden></p></form>`;
      $('.msg-pro', caja).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const err = $('.error', caja);
        try {
          const r = await api(`/api/proveedor/estaciones/${encodeURIComponent(id)}/mensaje`, { metodo: 'POST', cuerpo: { texto: $('textarea', caja).value } });
          avisar(`Mensaje enviado a ${r.enviados} ${r.enviados === 1 ? 'cliente' : 'clientes'}`);
          cargarPro(caja, id);
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
        }
      });
    } catch (e) {
      caja.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  async function buscar() {
    const q = norm($('#bGas').value).trim();
    const ul = $('#resultados');
    if (q.length < 3) return (ul.innerHTML = '');
    if (!todas) {
      ul.innerHTML = '<li>Cargando el listado oficial…</li>';
      try {
        todas = (await api('/api/estaciones')).estaciones.map((e) => ({ ...e, _t: norm(`${e.rotulo} ${e.direccion} ${e.localidad} ${e.municipio} ${e.provincia} ${e.cp}`) }));
      } catch (e) {
        ul.innerHTML = `<li class="error">${esc(e.message)}</li>`;
        return;
      }
    }
    const palabras = q.split(/\s+/);
    const mias = new Set([...panel.estaciones.map((e) => e.id), ...panel.reclamaciones.filter((r) => r.estado === 'pendiente').map((r) => r.estacion)]);
    const res = todas.filter((e) => palabras.every((w) => e._t.includes(w))).slice(0, 20);
    ul.innerHTML = res.length
      ? res
          .map(
            (e) => `<li data-id="${esc(e.id)}"><div><b>${esc(e.rotulo)}</b><br><span class="texto-ayuda">${esc(e.direccion)}, ${esc(e.cp)} ${esc(e.localidad)} (${esc(e.provincia)})</span></div>
          ${mias.has(e.id) ? '<span class="estado">Ya reclamada</span>' : '<button class="boton" type="button" data-reclamar>Es mía</button>'}</li>`
          )
          .join('')
      : '<li>No hay resultados. Prueba con el código postal.</li>';
    $$('[data-reclamar]', ul).forEach((b) =>
      b.addEventListener('click', () => {
        const li = b.closest('li');
        if ($('.reclamar', li)) return;
        li.insertAdjacentHTML(
          'beforeend',
          `<form class="reclamar" style="flex-basis:100%">
            <label class="campo" for="m-${esc(li.dataset.id)}">¿Cómo podemos comprobar que la gestionas?<textarea id="m-${esc(li.dataset.id)}" maxlength="600" placeholder="Ej.: soy el titular de la licencia; podéis llamar al teléfono de la gasolinera y preguntar por mí."></textarea></label>
            <button class="boton primario" type="submit">Enviar reclamación</button>
          </form>`
        );
        $('.reclamar', li).addEventListener('submit', async (ev) => {
          ev.preventDefault();
          try {
            await api('/api/proveedor/reclamaciones', { metodo: 'POST', cuerpo: { estacion: li.dataset.id, mensaje: $('textarea', li).value } });
            avisar('Reclamación enviada. La revisaremos pronto.');
            cargar();
          } catch (e) {
            avisar(e.message, 5000);
          }
        });
      })
    );
  }

  cargar();
})();
