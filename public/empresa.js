/* GasoCheck Empresas — panel de la empresa: código para conductores, vehículos, repostajes y avisos */
(() => {
  'use strict';
  const API = (window.GASOCHECK_API || '').replace(/\/$/, '');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const leer = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const guardar = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };
  const NOMBRES = { gasoleoA: 'Gasóleo A', gasoleoPremium: 'Gasóleo Premium', gasolina95: 'Gasolina 95', gasolina98: 'Gasolina 98', glp: 'Autogás (GLP)' };
  const eur = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const raiz = $('#emp');
  let token = leer('gm.token');
  let datos = null;
  // Periodo: el mes en curso por defecto
  const hoy = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
  let mes = hoy.slice(0, 7);

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
    if (!r.ok) throw Object.assign(new Error(d.error || `Error ${r.status}`), { status: r.status });
    return d;
  }

  function pantallaEntrar(msg = '') {
    raiz.innerHTML = `<div class="emp-cab"><div class="marca-prov"><img src="img/logo.png" alt="GasoCheck" width="40" height="48"><div><h1>Panel de empresa</h1><p>Entra con tu cuenta de empresa.</p></div></div></div>
      <form id="fEntrar" class="form-cuenta" style="max-width:420px" novalidate>
        <label class="campo" for="eEmail">Correo electrónico<input id="eEmail" type="email" autocomplete="email" required></label>
        <label class="campo" for="ePass">Contraseña<input id="ePass" type="password" autocomplete="current-password" required></label>
        <p class="error" id="eError" ${msg ? '' : 'hidden'}>${esc(msg)}</p>
        <button class="boton primario" type="submit">Entrar</button>
        <p class="texto-ayuda">¿No tienes cuenta? Créala en <a href="./">GasoCheck</a> → Entrar → “Soy una empresa con vehículos”.</p>
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

  const finMes = (m) => {
    const [a, mm] = m.split('-').map(Number);
    return `${m}-${String(new Date(a, mm, 0).getDate()).padStart(2, '0')}`;
  };

  async function cargar() {
    if (!token) return pantallaEntrar();
    try {
      datos = await api(`/api/empresa/panel?desde=${mes}-01&hasta=${finMes(mes)}`);
      pintar();
    } catch (e) {
      if (e.status === 401) {
        token = null;
        guardar('gm.token', null);
        return pantallaEntrar('Tu sesión ha caducado. Vuelve a entrar.');
      }
      if (e.status === 403) {
        raiz.innerHTML = `<h1>Panel de empresa</h1><p>Has entrado con una cuenta que no es de empresa.</p><p><a class="boton" href="./">Volver a GasoCheck</a></p>`;
        return;
      }
      raiz.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  function csv() {
    const filas = [['fecha', 'hora', 'vehiculo', 'conductor', 'gasolinera', 'combustible', 'litros', 'importe_eur', 'precio_litro', 'precio_oficial', 'km', 'avisos']];
    for (const r of datos.repostajes) {
      filas.push([r.fecha, r.hora || '', r.vehiculoMatricula, r.conductor, r.nombre_estacion, NOMBRES[r.combustible] || r.combustible, eur(r.litros), r.importe != null ? eur(r.importe) : '', r.importe ? eur(r.importe / r.litros, 3) : '', r.precio_oficial ? eur(r.precio_oficial, 3) : '', r.km || '', r.anomalias.map((a) => a.texto).join(' | ')]);
    }
    const txt = '﻿' + filas.map((f) => f.map((v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv;charset=utf-8' }));
    a.download = `repostajes-${mes}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function pintar() {
    const d = datos;
    const c = d.cuenta;
    const activos = d.vehiculos.filter((v) => v.activo);
    const res = d.resumen;
    raiz.innerHTML = `
      <div class="emp-cab">
        <div class="marca-prov"><img src="img/logo.png" alt="GasoCheck" width="40" height="48"><div><h1>${esc(d.flota.nombre)}</h1><p>GasoCheck Empresas · ${esc(c.email)}${c.plan?.pro && !c.plan?.gratis ? ' · <b class="ins-pro">PRO</b>' : ''}</p></div></div>
        <div class="acciones"><a class="boton" href="./">Ir al mapa</a><button class="boton" type="button" id="bSalir">Cerrar sesión</button></div>
      </div>
      ${c.verificado ? '' : '<div class="aviso-cuenta"><p><b>Confirma tu correo</b> con el enlace que te enviamos al registrarte.</p></div>'}

      <section class="tarjeta">
        <h2>Código para tus conductores</h2>
        <div class="codigo"><strong id="codigo">${esc(d.flota.codigo)}</strong><button class="boton" type="button" id="bCopiar">Copiar</button><button class="boton" type="button" id="bNuevoCodigo">Cambiar código</button></div>
        <p class="texto-ayuda">Cada conductor se crea una cuenta personal en GasoCheck y, en <b>Mi coche → Mi empresa</b>, escribe este código. Después, al apuntar un repostaje, marca “Repostaje de empresa”. Si cambias el código, el anterior deja de servir (los conductores ya unidos siguen dentro).</p>
      </section>

      <section>
        <div class="filtro-mes"><h2 style="margin:0 auto 0 0">Resumen</h2><label for="mes">Mes<input type="month" id="mes" value="${mes}" max="${hoy.slice(0, 7)}"></label><button class="boton" type="button" id="bCsv" ${d.repostajes.length ? '' : 'disabled'}>Exportar a Excel (CSV)</button></div>
        <div class="cifras" style="margin-top:10px">
          <div><span>Gasto</span><strong>${eur(res.gasto)} €</strong></div>
          <div><span>Litros</span><strong>${eur(res.litros, 0)}</strong></div>
          <div><span>Repostajes</span><strong>${res.repostajes}</strong></div>
          <div class="${res.conAvisos ? 'aviso-n' : ''}"><span>Con avisos</span><strong>${res.conAvisos}</strong></div>
        </div>
      </section>

      <section class="tarjeta">
        <h2>Vehículos (${activos.length}${c.plan?.pro ? '' : ` de ${d.maxVehiculosGratis} en el plan gratuito`})</h2>
        <div class="tabla"><table>
          <thead><tr><th>Matrícula</th><th>Nombre</th><th>Combustible</th><th class="num">Depósito</th><th class="num">Repostajes</th><th class="num">Litros</th><th class="num">Gasto</th><th class="num">Consumo</th><th class="num">Avisos</th><th></th></tr></thead>
          <tbody>${res.vehiculos.filter((v) => v.activo).map((v) => {
            const veh = d.vehiculos.find((x) => x.id === v.id);
            return `<tr><td><b>${esc(v.matricula)}</b></td><td>${esc(v.nombre)}</td><td>${NOMBRES[veh.combustible] || ''}</td><td class="num">${eur(veh.deposito, 0)} L</td><td class="num">${v.repostajes}</td><td class="num">${eur(v.litros, 1)}</td><td class="num">${eur(v.gasto)} €</td><td class="num">${v.consumo != null ? eur(v.consumo, 1) + ' l/100' : '—'}</td><td class="num">${v.anomalias ? `<span class="chip">${v.anomalias}</span>` : '0'}</td><td><button class="enlace texto-peligro" data-baja="${esc(v.id)}">Dar de baja</button></td></tr>`;
          }).join('') || '<tr><td colspan="10" class="texto-ayuda">Aún no hay vehículos. Añade el primero abajo.</td></tr>'}</tbody>
        </table></div>
        <form class="form-veh" id="fVeh" novalidate>
          <label for="vMat">Matrícula<input id="vMat" maxlength="12" placeholder="1234ABC" autocomplete="off"></label>
          <label for="vNom">Nombre (opcional)<input id="vNom" maxlength="40" placeholder="Furgoneta reparto"></label>
          <label for="vComb">Combustible<select id="vComb">${Object.entries(NOMBRES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
          <label for="vDep">Depósito (litros)<input id="vDep" inputmode="numeric" placeholder="60"></label>
          <button class="boton primario" type="submit">Añadir vehículo</button>
        </form>
        <p class="error" id="eVeh" hidden></p>
        <p class="texto-ayuda">El consumo se calcula con los kilómetros entre dos repostajes con el depósito lleno.</p>
      </section>

      <section class="tarjeta">
        <h2>Conductores (${d.conductores.length})</h2>
        ${d.conductores.length
          ? `<ul class="reglas">${d.conductores.map((x) => `<li><span><b>${esc(x.alias)}</b> · ${esc(x.email)} · desde ${new Date(x.unido).toLocaleDateString('es-ES')}</span><button type="button" class="enlace texto-peligro" data-expulsar="${esc(x.usuario)}">Quitar</button></li>`).join('')}</ul>`
          : '<p class="texto-ayuda">Ningún conductor se ha unido todavía. Comparte el código de arriba.</p>'}
      </section>

      <section class="tarjeta">
        <h2>Repostajes de ${new Date(mes + '-15').toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}</h2>
        ${d.repostajes.length
          ? `<div class="tabla"><table>
              <thead><tr><th>Fecha</th><th>Vehículo</th><th>Conductor</th><th>Gasolinera</th><th class="num">Litros</th><th class="num">Importe</th><th class="num">€/l</th><th class="num">Oficial</th><th class="num">Km</th><th>Avisos</th></tr></thead>
              <tbody>${d.repostajes.map((r) => {
                const graves = r.anomalias.filter((a) => a.tipo !== 'horario');
                return `<tr class="${graves.length ? 'raro' : ''}"><td>${new Date(r.fecha + 'T12:00:00').toLocaleDateString('es-ES')}${r.hora ? ' ' + esc(r.hora) : ''}</td><td>${esc(r.vehiculoMatricula)}</td><td>${esc(r.conductor)}</td><td>${esc(r.nombre_estacion || '—')}</td>
                  <td class="num">${eur(r.litros)}</td><td class="num">${r.importe != null ? eur(r.importe) + ' €' : '—'}</td><td class="num">${r.importe ? eur(r.importe / r.litros, 3) : '—'}</td><td class="num">${r.precio_oficial ? eur(r.precio_oficial, 3) : '—'}</td><td class="num">${r.km ? r.km.toLocaleString('es-ES') : '—'}</td>
                  <td class="wrap">${r.anomalias.map((a) => `<span class="chip ${a.tipo === 'horario' ? 'suave' : ''}">${esc(a.texto)}</span>`).join('') || '—'}</td></tr>`;
              }).join('')}</tbody></table></div>`
          : '<p class="texto-ayuda">No hay repostajes en este mes.</p>'}
        <p class="texto-ayuda">Avisos que se detectan: más litros que el depósito, combustible distinto del del vehículo, dos repostajes en menos de 4 horas, kilómetros que bajan, precio pagado un 8 % por encima del oficial y repostajes fuera de horario (en gris, solo informativo).</p>
      </section>

      ${c.plan?.pro ? '' : `<section class="plan"><b>GasoCheck Pro para empresas:</b> vehículos ilimitados. Escríbenos para activarlo.</section>`}`;

    $('#bSalir').addEventListener('click', async () => {
      await api('/api/auth/salir', { metodo: 'POST', cuerpo: {} }).catch(() => {});
      token = null;
      guardar('gm.token', null);
      guardar('gm.usuario', null);
      pantallaEntrar();
    });
    $('#bCopiar').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(d.flota.codigo);
        avisar('Código copiado');
      } catch {
        getSelection().selectAllChildren($('#codigo'));
        avisar('Selecciona y copia el código');
      }
    });
    $('#bNuevoCodigo').addEventListener('click', async (ev) => {
      if (ev.target.dataset.ok !== '1') {
        ev.target.dataset.ok = '1';
        ev.target.textContent = '¿Seguro? El anterior dejará de servir';
        return;
      }
      await api('/api/empresa/codigo', { metodo: 'POST', cuerpo: {} });
      cargar();
    });
    $('#mes').addEventListener('change', (ev) => {
      if (!ev.target.value) return;
      mes = ev.target.value;
      cargar();
    });
    $('#bCsv').addEventListener('click', csv);
    $('#fVeh').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('/api/empresa/vehiculos', { metodo: 'POST', cuerpo: { matricula: $('#vMat').value, nombre: $('#vNom').value, combustible: $('#vComb').value, deposito: $('#vDep').value } });
        avisar('Vehículo añadido');
        cargar();
      } catch (e) {
        $('#eVeh').textContent = e.message;
        $('#eVeh').hidden = false;
      }
    });
    $$('[data-baja]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (b.dataset.ok !== '1') {
          b.dataset.ok = '1';
          b.textContent = 'Confirmar baja';
          return;
        }
        await api('/api/empresa/vehiculos/' + encodeURIComponent(b.dataset.baja), { metodo: 'DELETE' });
        cargar();
      })
    );
    $$('[data-expulsar]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (b.dataset.ok !== '1') {
          b.dataset.ok = '1';
          b.textContent = 'Confirmar';
          return;
        }
        await api('/api/empresa/conductores/' + encodeURIComponent(b.dataset.expulsar), { metodo: 'DELETE' });
        cargar();
      })
    );
  }

  cargar();
})();
