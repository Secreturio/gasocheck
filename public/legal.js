/* ============================================================================
   DATOS DEL TITULAR DE GASOCHECK — rellena esto una vez y se aplica a todos los
   textos legales (aviso legal, privacidad, condiciones y almacenamiento).
   Mientras quede algún campo vacío, las páginas legales muestran un aviso.
   ============================================================================ */
window.LEGAL = {
  // GasoCheck se publica como proyecto personal, gratuito y sin ánimo de lucro de una persona física.
  titular: 'Antonio Fernández González-Haba', // OBLIGATORIO. Tu nombre y apellidos. Ej.: 'Antonio Pérez García'
  email: 'gasochecklegal@gmail.com', // OBLIGATORIO. Correo de contacto y para ejercer derechos de privacidad (mejor uno solo para GasoCheck)
  nif: '',                // OPCIONAL. Si lo dejas vacío no se muestra
  domicilio: '',          // OPCIONAL. Si lo dejas vacío no se muestra (basta con el correo de contacto)
  registro: '',           // Solo si algún día lo gestiona una sociedad. Déjalo vacío
  dominio: 'gasocheck.es', // Dirección web donde se publica la app
  alojamiento: 'Netlify, Inc. (EE. UU.)', // Empresa donde alojas la web y los datos. Si cambias de proveedor, cámbialo aquí
  actualizado: '7 de octubre de 2026',
};

// Rellena los huecos de la página: <span data-legal="titular"></span>
(() => {
  const L = window.LEGAL;
  const faltan = [];
  const OPCIONALES = ['nif', 'domicilio', 'registro'];
  const etiquetas = { titular: 'nombre y apellidos', nif: 'NIF', domicilio: 'domicilio', email: 'correo de contacto', alojamiento: 'proveedor de alojamiento' };
  const aplicar = () => {
    document.querySelectorAll('[data-legal]').forEach((el) => {
      const k = el.dataset.legal;
      const v = L[k];
      if (v) {
        el.textContent = v;
      } else {
        el.textContent = `[${etiquetas[k] || k}]`;
        el.classList.add('hueco-legal');
        if (!faltan.includes(k) && !OPCIONALES.includes(k)) faltan.push(k);
      }
    });
    document.querySelectorAll('[data-si-legal]').forEach((el) => (el.hidden = !L[el.dataset.siLegal]));
    const aviso = document.getElementById('avisoLegal');
    if (aviso) {
      aviso.hidden = !faltan.length;
      aviso.textContent = `Faltan datos del titular (${faltan.map((k) => etiquetas[k] || k).join(', ')}). Complétalos en public/legal.js antes de publicar la app.`;
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', aplicar);
  else aplicar();
})();
