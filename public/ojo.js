/* Ver / ocultar contraseña: añade un botón con un ojo a cada campo de contraseña.
   Funciona también con campos que se crean después (formularios que se pintan con JavaScript). */
(() => {
  'use strict';
  const OJO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const OJO_TACHADO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7c2 0 3.8.7 5.2 1.6M22 12s-3.6 7-10 7c-2 0-3.8-.7-5.2-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';

  function preparar(input) {
    if (input.dataset.ojo) return;
    input.dataset.ojo = '1';
    const caja = document.createElement('span');
    caja.className = 'pass';
    input.parentNode.insertBefore(caja, input);
    caja.appendChild(input);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ver-pass';
    b.setAttribute('aria-label', 'Mostrar contraseña');
    b.setAttribute('aria-pressed', 'false');
    b.title = 'Mostrar contraseña';
    b.innerHTML = OJO;
    b.addEventListener('click', () => {
      const ver = input.type === 'password';
      input.type = ver ? 'text' : 'password';
      b.innerHTML = ver ? OJO_TACHADO : OJO;
      b.setAttribute('aria-pressed', String(ver));
      b.setAttribute('aria-label', ver ? 'Ocultar contraseña' : 'Mostrar contraseña');
      b.title = ver ? 'Ocultar contraseña' : 'Mostrar contraseña';
      input.focus({ preventScroll: true });
    });
    caja.appendChild(b);
    // Al enviar el formulario se vuelve a ocultar (por si alguien mira la pantalla después)
    input.form?.addEventListener('submit', () => {
      if (input.type === 'text') b.click();
    });
  }

  const revisar = (raiz = document) => raiz.querySelectorAll('input[type="password"]').forEach(preparar);
  const iniciar = () => {
    revisar();
    new MutationObserver((cambios) => {
      for (const c of cambios) for (const n of c.addedNodes) if (n.nodeType === 1) revisar(n.matches?.('input[type="password"]') ? n.parentNode : n);
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
