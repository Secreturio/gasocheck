/* GasoCheck — editor de imágenes (foto de perfil).
   Zoom, encuadre (arrastrar), giro de 90° y giro fino, espejo y brillo/contraste.
   Funciona con ratón (arrastrar, rueda), teclado (flechas, + / −) y táctil (un dedo mueve, dos dedos hacen zoom).

   Uso:  const blob = await EditorImagen.abrir(fichero, { titulo: 'Foto de perfil', salida: 512 });
         // blob (JPEG cuadrado) o null si la persona cancela */
(() => {
  'use strict';

  const MAX_ORIGEN = 2400; // lado máximo de la imagen de trabajo (memoria en móviles)
  const ZOOM_MAX = 5;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  async function cargar(fuente) {
    let bmp;
    try {
      bmp = await createImageBitmap(fuente); // respeta la orientación EXIF en los navegadores actuales
    } catch {
      const url = URL.createObjectURL(fuente);
      try {
        bmp = await new Promise((ok, ko) => {
          const i = new Image();
          i.onload = () => ok(i);
          i.onerror = () => ko(new Error('No se pudo leer la imagen.'));
          i.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const w = bmp.width, h = bmp.height;
    const e = Math.min(1, MAX_ORIGEN / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * e));
    c.height = Math.max(1, Math.round(h * e));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return c;
  }

  function abrir(fuente, { titulo = 'Ajustar foto', salida = 512, calidad = 0.88 } = {}) {
    return new Promise((resolver) => {
      cargar(fuente)
        .then((img) => montar(img, { titulo, salida, calidad }, resolver))
        .catch((e) => {
          window.GasoApp?.avisar?.(e.message || 'No se pudo abrir la imagen.', 4000);
          resolver(null);
        });
    });
  }

  function montar(img, { titulo, salida, calidad }, resolver) {
    const previo = document.activeElement;
    // Estado del encuadre. El desplazamiento (ox, oy) se guarda como fracción del lado del recuadro,
    // así vale igual para la vista previa y para la imagen final.
    const st = { giro90: 0, fino: 0, espejo: false, zoom: 1, ox: 0, oy: 0, brillo: 100, contraste: 100 };

    const capa = document.createElement('div');
    capa.className = 'editor-img';
    capa.setAttribute('role', 'dialog');
    capa.setAttribute('aria-modal', 'true');
    capa.setAttribute('aria-labelledby', 'edImgTit');
    capa.innerHTML = `
      <div class="ed-caja">
        <header class="ed-cab">
          <h2 id="edImgTit">${titulo}</h2>
          <button type="button" class="ed-x" data-ed="cancelar" aria-label="Cancelar">✕</button>
        </header>
        <div class="ed-escenario-caja">
          <div class="ed-escenario" tabindex="0" role="application" aria-label="Zona de encuadre. Arrastra para mover; rueda, pellizco o más y menos para el zoom; flechas para mover.">
            <canvas></canvas>
            <div class="ed-mascara" aria-hidden="true"></div>
            <div class="ed-rejilla" aria-hidden="true"></div>
          </div>
        </div>
        <p class="ed-ayuda">Arrastra para encuadrar · pellizca o usa la rueda para el zoom</p>
        <div class="ed-controles">
          <div class="ed-fila">
            <button type="button" class="ed-mini" data-ed="menos" aria-label="Alejar">−</button>
            <label class="ed-rango"><span>Zoom</span><input type="range" min="100" max="${ZOOM_MAX * 100}" value="100" data-r="zoom"></label>
            <button type="button" class="ed-mini" data-ed="mas" aria-label="Acercar">+</button>
          </div>
          <div class="ed-fila">
            <span class="ed-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 4v3M12 17v3M4 12h3M17 12h3"/><circle cx="12" cy="12" r="3.2"/></svg></span>
            <label class="ed-rango"><span>Giro fino <output data-o="fino">0°</output></span><input type="range" min="-45" max="45" value="0" step="1" data-r="fino"></label>
          </div>
          <div class="ed-botones">
            <button type="button" class="boton" data-ed="izq" aria-label="Girar a la izquierda"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4M4 9h5M4.6 9A8 8 0 1 1 4 13"/></svg>90°</button>
            <button type="button" class="boton" data-ed="der" aria-label="Girar a la derecha"><svg viewBox="0 0 24 24" aria-hidden="true" style="transform:scaleX(-1)"><path d="M4 9V4M4 9h5M4.6 9A8 8 0 1 1 4 13"/></svg>90°</button>
            <button type="button" class="boton" data-ed="espejo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M8 7L3 17h5zM16 7l5 10h-5z"/></svg>Espejo</button>
            <button type="button" class="boton" data-ed="reset"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/></svg>Restablecer</button>
          </div>
          <details class="ed-mas">
            <summary>Brillo y contraste</summary>
            <label class="ed-rango"><span>Brillo <output data-o="brillo">100%</output></span><input type="range" min="60" max="140" value="100" data-r="brillo"></label>
            <label class="ed-rango"><span>Contraste <output data-o="contraste">100%</output></span><input type="range" min="60" max="140" value="100" data-r="contraste"></label>
          </details>
        </div>
        <footer class="ed-pie">
          <button type="button" class="boton" data-ed="cancelar">Cancelar</button>
          <button type="button" class="boton primario" data-ed="guardar">Guardar foto</button>
        </footer>
      </div>`;
    document.body.appendChild(capa);
    document.body.classList.add('editor-abierto');

    const $ = (s) => capa.querySelector(s);
    const escenario = $('.ed-escenario');
    const canvas = $('canvas');
    const ctx = canvas.getContext('2d');
    let lado = 300; // píxeles CSS del recuadro

    /* ---- Geometría ---- */
    const theta = () => ((st.giro90 * 90 + st.fino) * Math.PI) / 180;
    // Escala mínima para que la imagen girada cubra por completo el recuadro (sin huecos en las esquinas)
    function escalaMin(L) {
      const t = theta();
      return (L * (Math.abs(Math.cos(t)) + Math.abs(Math.sin(t)))) / Math.min(img.width, img.height);
    }
    const escala = (L) => escalaMin(L) * st.zoom;

    // Mantiene el recuadro dentro de la imagen: corrige el desplazamiento si alguna esquina se sale
    function limitar() {
      const L = 1; // trabajamos en fracciones del lado
      const s = escala(L);
      const t = theta(), c = Math.cos(t), sn = Math.sin(t);
      const mx = (img.width * s) / 2, my = (img.height * s) / 2;
      for (let it = 0; it < 6; it++) {
        let movido = false;
        for (const [qx, qy] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
          const rx = qx - st.ox, ry = qy - st.oy; // esquina respecto al centro de la imagen
          const ix = rx * c + ry * sn; // rotada por −θ, al sistema de la imagen
          const iy = -rx * sn + ry * c;
          const ex = ix > mx ? ix - mx : ix < -mx ? ix + mx : 0;
          const ey = iy > my ? iy - my : iy < -my ? iy + my : 0;
          if (ex || ey) {
            // el exceso (sistema de la imagen) se pasa a pantalla con la rotación +θ y se suma al desplazamiento:
            // así la imagen se acerca a la esquina que se salía
            st.ox += ex * c - ey * sn;
            st.oy += ex * sn + ey * c;
            movido = true;
          }
        }
        if (!movido) break;
      }
    }

    function dibujar(c2, px) {
      const s = escala(px);
      c2.save();
      c2.fillStyle = '#000';
      c2.fillRect(0, 0, px, px);
      c2.translate(px / 2 + st.ox * px, px / 2 + st.oy * px);
      c2.rotate(theta());
      c2.scale(st.espejo ? -s : s, s);
      c2.drawImage(img, -img.width / 2, -img.height / 2);
      c2.restore();
    }

    function pintar() {
      limitar();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const px = Math.round(lado * dpr);
      if (canvas.width !== px) canvas.width = canvas.height = px;
      dibujar(ctx, px);
      canvas.style.filter = st.brillo !== 100 || st.contraste !== 100 ? `brightness(${st.brillo}%) contrast(${st.contraste}%)` : '';
      $('[data-r="zoom"]').value = String(Math.round(st.zoom * 100));
      $('[data-o="fino"]').textContent = st.fino + '°';
      $('[data-r="fino"]').value = String(st.fino);
      $('[data-o="brillo"]').textContent = st.brillo + '%';
      $('[data-o="contraste"]').textContent = st.contraste + '%';
      $('[data-ed="espejo"]').setAttribute('aria-pressed', String(st.espejo));
    }

    function medir() {
      lado = Math.round(escenario.getBoundingClientRect().width) || 300;
      pintar();
    }

    function ponerZoom(z, cx = 0, cy = 0) {
      // El punto bajo (cx, cy) —fracción del lado respecto al centro— se queda quieto al hacer zoom
      const nuevo = clamp(z, 1, ZOOM_MAX);
      const k = nuevo / st.zoom;
      st.ox = cx - (cx - st.ox) * k;
      st.oy = cy - (cy - st.oy) * k;
      st.zoom = nuevo;
      pintar();
    }

    /* ---- Gestos ---- */
    const punteros = new Map();
    let ultimoPar = null;
    const centro = (ev) => {
      const r = escenario.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / r.width - 0.5, y: (ev.clientY - r.top) / r.height - 0.5 };
    };
    escenario.addEventListener('pointerdown', (ev) => {
      escenario.setPointerCapture(ev.pointerId);
      punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      ultimoPar = null;
      escenario.classList.add('moviendo');
    });
    escenario.addEventListener('pointermove', (ev) => {
      const p = punteros.get(ev.pointerId);
      if (!p) return;
      const r = escenario.getBoundingClientRect();
      if (punteros.size === 1) {
        st.ox += (ev.clientX - p.x) / r.width;
        st.oy += (ev.clientY - p.y) / r.height;
        p.x = ev.clientX;
        p.y = ev.clientY;
        pintar();
      } else if (punteros.size === 2) {
        p.x = ev.clientX;
        p.y = ev.clientY;
        const [a, b] = [...punteros.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = ((a.x + b.x) / 2 - r.left) / r.width - 0.5;
        const my = ((a.y + b.y) / 2 - r.top) / r.height - 0.5;
        if (ultimoPar) {
          st.ox += mx - ultimoPar.mx;
          st.oy += my - ultimoPar.my;
          if (ultimoPar.dist > 0) ponerZoom(st.zoom * (dist / ultimoPar.dist), mx, my);
          else pintar();
        }
        ultimoPar = { dist, mx, my };
      }
    });
    const soltar = (ev) => {
      punteros.delete(ev.pointerId);
      ultimoPar = null;
      // al quedar un dedo, que su posición actual sea la de partida (sin saltos)
      if (!punteros.size) escenario.classList.remove('moviendo');
    };
    escenario.addEventListener('pointerup', soltar);
    escenario.addEventListener('pointercancel', soltar);
    escenario.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const c = centro(ev);
      ponerZoom(st.zoom * Math.exp(-ev.deltaY * 0.0015), c.x, c.y);
    }, { passive: false });
    escenario.addEventListener('keydown', (ev) => {
      const paso = 0.03;
      const m = { ArrowLeft: [-paso, 0], ArrowRight: [paso, 0], ArrowUp: [0, -paso], ArrowDown: [0, paso] }[ev.key];
      if (m) {
        st.ox += m[0];
        st.oy += m[1];
        pintar();
      } else if (ev.key === '+' || ev.key === '=') ponerZoom(st.zoom * 1.1);
      else if (ev.key === '-') ponerZoom(st.zoom / 1.1);
      else return;
      ev.preventDefault();
    });

    /* ---- Controles ---- */
    $('[data-r="zoom"]').addEventListener('input', (ev) => ponerZoom(Number(ev.target.value) / 100));
    $('[data-r="fino"]').addEventListener('input', (ev) => { st.fino = Number(ev.target.value); pintar(); });
    $('[data-r="brillo"]').addEventListener('input', (ev) => { st.brillo = Number(ev.target.value); pintar(); });
    $('[data-r="contraste"]').addEventListener('input', (ev) => { st.contraste = Number(ev.target.value); pintar(); });

    function girar90(d) {
      st.giro90 += d;
      // el encuadre gira con la imagen
      const { ox, oy } = st;
      st.ox = d > 0 ? -oy : oy;
      st.oy = d > 0 ? ox : -ox;
      pintar();
    }

    const acciones = {
      mas: () => ponerZoom(st.zoom * 1.25),
      menos: () => ponerZoom(st.zoom / 1.25),
      izq: () => girar90(-1),
      der: () => girar90(1),
      // Espejo horizontal de lo que se ve: se invierte también el giro para que los controles sigan siendo coherentes
      espejo: () => { st.espejo = !st.espejo; st.ox = -st.ox; st.giro90 = -st.giro90; st.fino = -st.fino; pintar(); },
      reset: () => Object.assign(st, { giro90: 0, fino: 0, espejo: false, zoom: 1, ox: 0, oy: 0, brillo: 100, contraste: 100 }) && pintar(),
      cancelar: () => cerrar(null),
      guardar: guardarImagen,
    };
    capa.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-ed]');
      if (b) acciones[b.dataset.ed]?.();
      else if (ev.target === capa) cerrar(null);
    });

    function guardarImagen() {
      const out = document.createElement('canvas');
      out.width = out.height = salida;
      const c2 = out.getContext('2d');
      dibujar(c2, salida);
      aplicarTono(out, c2);
      out.toBlob((b) => cerrar(b), 'image/jpeg', calidad);
    }
    // Brillo y contraste en la imagen final (ctx.filter no existe en todos los navegadores, así que se hace a mano)
    function aplicarTono(out, c2) {
      if (st.brillo === 100 && st.contraste === 100) return;
      const d = c2.getImageData(0, 0, out.width, out.height);
      const b = st.brillo / 100, k = st.contraste / 100, px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        for (let j = 0; j < 3; j++) px[i + j] = clamp(((px[i + j] * b - 128) * k) + 128, 0, 255);
      }
      c2.putImageData(d, 0, 0);
    }

    /* ---- Cierre, foco y teclado ---- */
    function cerrar(resultado) {
      document.removeEventListener('keydown', tecla, true);
      window.removeEventListener('resize', medir);
      capa.remove();
      document.body.classList.remove('editor-abierto');
      previo?.focus?.({ preventScroll: true });
      resolver(resultado);
    }
    function tecla(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cerrar(null);
      } else if (ev.key === 'Tab') {
        const f = [...capa.querySelectorAll('button, input, summary, [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const primero = f[0], ultimo = f[f.length - 1];
        if (ev.shiftKey && document.activeElement === primero) { ultimo.focus(); ev.preventDefault(); }
        else if (!ev.shiftKey && document.activeElement === ultimo) { primero.focus(); ev.preventDefault(); }
      }
    }
    document.addEventListener('keydown', tecla, true);
    window.addEventListener('resize', medir);

    medir();
    requestAnimationFrame(medir); // por si la caja aún no tenía su tamaño final
    escenario.focus({ preventScroll: true });
  }

  window.EditorImagen = { abrir };
})();
