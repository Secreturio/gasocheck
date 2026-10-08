// Netlify Function: toda la API de GasoCheck (/api/*).
// La lógica está en server/app.js; los datos se guardan en Netlify Blobs (no hay que configurar nada).

import { crearApp } from '../../server/app.js';
import { crearAlmacen } from '../../server/almacen.js';

let app = null;
const iniciar = async (origen) => {
  const almacen = await crearAlmacen({ netlify: true });
  return crearApp({
    almacen,
    demo: process.env.DEMO === '1',
    // Dirección para los enlaces de los correos: APP_URL si la defines; si no, la principal de Netlify (URL)
    // o, en último caso, la dirección por la que ha llegado la petición
    appUrl: process.env.APP_URL || process.env.URL || origen,
  });
};

export default async (request, context) => {
  try {
    app ||= iniciar(new URL(request.url).origin).catch((e) => {
      app = null;
      throw e;
    });
    const a = await app;
    const respuesta = await a.manejar(request, { ip: context?.ip || request.headers.get('x-nf-client-connection-ip') || 'desconocida' });
    // Si los precios se han quedado viejos, se actualizan después de responder
    const tarea = typeof context?.waitUntil === 'function' ? a.quizaActualizar() : null;
    if (tarea) context.waitUntil(tarea);
    return respuesta;
  } catch (err) {
    console.error('No se pudo iniciar GasoCheck:', err);
    return new Response(JSON.stringify({ error: 'El servidor no ha podido arrancar. Inténtalo de nuevo en un momento.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
};

export const config = {
  path: '/api/*',
};
