/* GasoCheck — lectura de tickets de gasolinera.
   La foto se procesa en el propio dispositivo con Tesseract (OCR) y NO se sube a ningún servidor:
   solo se envían los datos leídos (fecha, litros, importe) y una huella de la imagen para que
   el mismo ticket no pueda usarse dos veces. */
(() => {
  'use strict';
  const num = (s) => (s == null ? null : parseFloat(String(s).replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

  // Correcciones típicas del OCR: dentro de un número, O → 0 e l/I → 1 ("3O,OO" → "30,00"),
  // y espacios sueltos junto a la coma o el punto ("40 ,25" → "40,25"). Las palabras no se tocan.
  function limpiarOcr(t) {
    return t
      .replace(/(^|[^A-Za-z])([\dOolI][\dOolI,.]*)(?=$|[^A-Za-z])/gm, (m, antes, tok) => (/\d/.test(tok) ? antes + tok.replace(/[Oo]/g, '0').replace(/[lI]/g, '1') : m))
      .replace(/(\d)\s+([,.])\s*(\d)/g, '$1$2$3')
      .replace(/(\d)([,.])\s+(\d)/g, '$1$2$3');
  }

  /**
   * Interpreta el texto de un ticket. Devuelve { fecha: 'AAAA-MM-DD'|null, hora, litros, importe, precioLitro, cif, cps[], completo }
   */
  function leerTicket(textoOriginal, hoy = new Date()) {
    const texto = limpiarOcr(String(textoOriginal || ''));
    const T = norm(texto);

    // Fecha: dd/mm/aaaa, dd-mm-aa o dd.mm.aaaa (la primera que sea una fecha válida y no futura)
    let fecha = null;
    for (const m of T.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g)) {
      let [, d, mes, a] = m;
      a = a.length === 2 ? '20' + a : a;
      const f = `${a}-${mes.padStart(2, '0')}-${d.padStart(2, '0')}`;
      const dt = new Date(f + 'T12:00:00');
      if (!isNaN(dt) && +mes >= 1 && +mes <= 12 && +d >= 1 && +d <= 31 && dt <= new Date(hoy.getTime() + 864e5)) {
        fecha = f;
        break;
      }
    }
    const hora = (T.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/) || [])[0]?.slice(0, 5)?.padStart(5, '0') || null;

    // Litros: "40,25 L", "40.25 LTS", "LITROS: 40,25", "VOLUMEN 40,25"
    let litros = null;
    const mL = T.match(/(\d{1,3}[.,]\d{1,3})\s*(?:L\b|LT\b|LTS\b|LITROS\b)/) || T.match(/(?:LITROS|VOLUMEN|CANTIDAD)\s*:?\s*(\d{1,3}[.,]\d{1,3})/);
    if (mL) litros = num(mL[1]);

    // Precio por litro: "1,449 €/L", "1,449 EUR/L", "PRECIO/L 1,449", "PVP 1,449"
    let precioLitro = null;
    const mP = T.match(/(\d[.,]\d{3})\s*(?:€|EUR|E)?\s*\/\s*L/) || T.match(/(?:PRECIO|P\.?V\.?P\.?|PRECIO\s*\/\s*L(?:ITRO)?)\s*:?\s*(\d[.,]\d{3})/) || T.match(/\bX\s*(\d[.,]\d{3})\b/);
    if (mP) precioLitro = num(mP[1]);

    // Importe: la última línea con TOTAL / IMPORTE / A PAGAR
    let importe = null;
    const totales = [...T.matchAll(/(?:TOTAL(?:\s*A\s*PAGAR)?|IMPORTE(?:\s*TOTAL)?|A\s*PAGAR)\s*(?:EUR|€)?\s*:?\s*(\d{1,4}[.,]\d{2})\b/g)];
    if (totales.length) importe = num(totales[totales.length - 1][1]);

    // Completar el dato que falte con los otros dos
    if (litros && precioLitro && !importe) importe = Math.round(litros * precioLitro * 100) / 100;
    if (importe && precioLitro && !litros) litros = Math.round((importe / precioLitro) * 100) / 100;
    if (importe && litros && !precioLitro) precioLitro = Math.round((importe / litros) * 1000) / 1000;
    // Si los tres no cuadran (más de un 3 %), se fía del importe y los litros
    if (importe && litros && precioLitro && Math.abs(litros * precioLitro - importe) / importe > 0.03) precioLitro = Math.round((importe / litros) * 1000) / 1000;

    const cif = (T.match(/\b(?:C\.?I\.?F\.?|N\.?I\.?F\.?)\s*:?\s*([A-Z]-?\d{7}[0-9A-J]|\d{8}-?[A-Z])\b/) || [])[1]?.replace('-', '') || null;
    const cps = [...new Set([...T.matchAll(/\b((?:0[1-9]|[1-4]\d|5[0-2])\d{3})\b/g)].map((m) => m[1]))];

    return { fecha, hora, litros, importe, precioLitro, cif, cps, completo: Boolean(fecha && litros && importe) };
  }

  // ¿El ticket es de esta gasolinera? Por la marca del rótulo o por su código postal
  function coincideCon(textoOriginal, datos, estacion) {
    const T = norm(textoOriginal);
    const palabras = norm(estacion.rotulo).split(/[^A-Z0-9]+/).filter((w) => w.length >= 3 && !['SIN', 'MARCA', 'ESTACION', 'SERVICIO', 'GASOLINERA', 'E.S'].includes(w));
    const porMarca = palabras.some((w) => T.includes(w));
    const porCp = estacion.cp && datos.cps.includes(String(estacion.cp));
    const porLocalidad = estacion.localidad && norm(estacion.localidad).length >= 4 && T.includes(norm(estacion.localidad));
    return porMarca || porCp || porLocalidad;
  }

  const api = { leerTicket, coincideCon };
  if (typeof window === 'undefined') {
    globalThis.GasoTicket = api;
    return;
  }

  /* ---------------- OCR en el dispositivo ---------------- */
  let cargando = null;
  function cargarTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    cargando ||= new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js';
      s.onload = () => ok(window.Tesseract);
      s.onerror = () => {
        cargando = null;
        ko(new Error('No se pudo cargar el lector de tickets. Comprueba la conexión.'));
      };
      document.head.appendChild(s);
    });
    return cargando;
  }

  // Reduce la foto (más rápido y más fiable) y la pasa a gris
  async function prepararImagen(fichero) {
    const img = await createImageBitmap(fichero);
    const escala = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * escala);
    c.height = Math.round(img.height * escala);
    const g = c.getContext('2d');
    g.filter = 'grayscale(1) contrast(1.4)';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  async function huella(fichero) {
    const buf = await fichero.arrayBuffer();
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Lee la foto: { datos, texto, hash, coincide } */
  async function leerFoto(fichero, estacion, alProgreso = () => {}) {
    if (!fichero || !/^image\//.test(fichero.type)) throw new Error('Elige una foto del ticket.');
    if (fichero.size > 15 * 1024 * 1024) throw new Error('La foto es demasiado grande.');
    alProgreso(0, 'Preparando la foto…');
    const [T, lienzo, hash] = await Promise.all([cargarTesseract(), prepararImagen(fichero), huella(fichero)]);
    const r = await T.recognize(lienzo, 'spa', {
      logger: (m) => m.status === 'recognizing text' && alProgreso(Math.round(m.progress * 100), 'Leyendo el ticket…'),
    });
    const texto = r.data.text || '';
    const datos = leerTicket(texto);
    return { datos, texto, hash, coincide: coincideCon(texto, datos, estacion) };
  }

  window.GasoTicket = { ...api, leerFoto };
})();
