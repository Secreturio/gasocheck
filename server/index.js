// GasoCheck en tu ordenador (sin Netlify): npm start  ·  npm run demo
// Sirve la web de public/ y la misma API que en Netlify (server/app.js), guardando los datos en data/almacen/.

import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearApp, VERSION } from './app.js';
import { crearAlmacen } from './almacen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(__dirname, '..', 'public');
const DATOS = path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT) || 3000;
const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const REFRESCO_MS = 30 * 60 * 1000;

const almacen = await crearAlmacen({ carpeta: path.join(DATOS, DEMO ? 'almacen-demo' : 'almacen') });
const app = await crearApp({ almacen, demo: DEMO, appUrl: APP_URL });

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function estatico(req, res, ruta) {
  let rel;
  try {
    rel = decodeURIComponent(ruta);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const fichero = path.join(PUBLICO, path.normalize(rel));
  if (!fichero.startsWith(PUBLICO + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const info = await fs.stat(fichero);
    const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
    const codigo = /\.(html|js|css|webmanifest)$/.test(fichero);
    const cab = {
      'Content-Type': TIPOS[path.extname(fichero)] || 'application/octet-stream',
      'Cache-Control': codigo ? 'no-cache' : 'public, max-age=600',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin',
      'X-Frame-Options': 'DENY',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, cab);
      return res.end();
    }
    res.writeHead(200, cab);
    res.end(await fs.readFile(fichero));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
}

// De la petición de Node a un Request estándar, y del Response a la respuesta de Node
async function api(req, res) {
  const cuerpo = ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    ? undefined
    : await new Promise((resolve, reject) => {
        const trozos = [];
        let n = 0;
        req.on('data', (c) => {
          n += c.length;
          if (n > 5 * 1024 * 1024) {
            reject(new Error('demasiado grande'));
            req.destroy();
          } else trozos.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(trozos)));
        req.on('error', reject);
      });
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'desconocida';
  const r = await app.manejar(new Request(`http://localhost${req.url}`, { method: req.method, headers, body: cuerpo }), { ip });
  const cab = {};
  r.headers.forEach((v, k) => {
    if (!k.startsWith('netlify-')) cab[k] = v;
  });
  let salida = r.body ? Buffer.from(await r.arrayBuffer()) : undefined;
  // En Netlify comprime la CDN; aquí lo hacemos nosotros
  if (salida && salida.length > 2048 && /json/.test(cab['content-type'] || '') && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    salida = zlib.gzipSync(salida);
    cab['content-encoding'] = 'gzip';
    cab['vary'] = 'Accept-Encoding';
  }
  res.writeHead(r.status, cab);
  res.end(salida);
}

const servidor = http.createServer(async (req, res) => {
  try {
    const ruta = new URL(req.url, 'http://x').pathname;
    if (ruta.startsWith('/api/')) return await api(req, res);
    return await estatico(req, res, ruta);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Error interno.' }));
    }
  }
});

const refrescar = () =>
  app.actualizar({ tiempoMax: 90_000 }).catch((e) => console.warn('No se pudo actualizar el listado:', e.message));

servidor.listen(PORT, async () => {
  console.log(`GasoCheck v${VERSION} en ${APP_URL}${DEMO ? '  (modo demostración: precios inventados)' : ''}`);
  console.log(`Datos guardados en ${path.join(DATOS, DEMO ? 'almacen-demo' : 'almacen')}`);
  if (!app.moderacion) console.log('Moderación desactivada (define ADMIN_TOKEN para usar /admin.html)');
  if (!app.correoReal) console.log('Correos en modo desarrollo: se muestran aquí');
  if (DEMO) await app.prepararDemo().catch((e) => console.error('Demo:', e));
  else {
    refrescar();
    setInterval(refrescar, REFRESCO_MS).unref?.();
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
