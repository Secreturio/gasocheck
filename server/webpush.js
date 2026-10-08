// Notificaciones Web Push sin dependencias: cifrado RFC 8291 (aes128gcm) y firma VAPID (RFC 8292).
// Funciona con Chrome/Edge/Firefox en Android y escritorio, y con Safari en iPhone (app añadida a la pantalla de inicio, iOS 16.4+).
// Las claves VAPID se generan la primera vez y se guardan en el almacén (config/vapid.json),
// salvo que se indiquen en las variables VAPID_PUBLICA / VAPID_PRIVADA.

import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const deB64u = (s) => Buffer.from(String(s), 'base64url');

/**
 * Cifra el contenido para una suscripción (RFC 8291, un solo registro).
 * p256dh y auth vienen de la suscripción del navegador. "pruebas" permite fijar la clave efímera y la sal.
 */
export function cifrar(contenido, p256dh, auth, pruebas = {}) {
  const uaPublica = deB64u(p256dh);
  const secretoAuth = deB64u(auth);
  if (uaPublica.length !== 65 || secretoAuth.length !== 16) throw new Error('Suscripción push no válida');
  const ecdh = crypto.createECDH('prime256v1');
  if (pruebas.clavePrivada) ecdh.setPrivateKey(deB64u(pruebas.clavePrivada));
  else ecdh.generateKeys();
  const asPublica = ecdh.getPublicKey();
  const secreto = ecdh.computeSecret(uaPublica);
  const sal = pruebas.sal ? deB64u(pruebas.sal) : crypto.randomBytes(16);

  const infoClave = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublica, asPublica]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secreto, secretoAuth, infoClave, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, sal, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, sal, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cifrador = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const texto = Buffer.concat([Buffer.from(contenido), Buffer.from([2])]); // 0x02 = último registro
  const cifrado = Buffer.concat([cifrador.update(texto), cifrador.final(), cifrador.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([sal, rs, Buffer.from([asPublica.length]), asPublica, cifrado]);
}

export async function crearWebPush(almacen, { sujeto = 'mailto:gasochecklegal@gmail.com' } = {}) {
  let publica = process.env.VAPID_PUBLICA || '';
  let privadaJwk = null;
  if (process.env.VAPID_PRIVADA && publica) {
    const pub = deB64u(publica);
    privadaJwk = { kty: 'EC', crv: 'P-256', d: process.env.VAPID_PRIVADA, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  } else {
    const CLAVE = 'config/vapid.json';
    const leido = await almacen.leer(CLAVE, { tipo: 'json' });
    if (leido?.datos) ({ publica, privadaJwk } = leido.datos);
    else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      privadaJwk = privateKey.export({ format: 'jwk' });
      const j = publicKey.export({ format: 'jwk' });
      publica = b64u(Buffer.concat([Buffer.from([4]), deB64u(j.x), deB64u(j.y)]));
      // Si otra copia de la función las creó a la vez, se usan las suyas
      const r = await almacen.escribir(CLAVE, { publica, privadaJwk }, { siNuevo: true });
      if (!r.ok) ({ publica, privadaJwk } = (await almacen.leer(CLAVE, { tipo: 'json' })).datos);
      else console.log('Claves de notificaciones (VAPID) generadas y guardadas en el almacén');
    }
  }
  const clavePrivada = crypto.createPrivateKey({ key: privadaJwk, format: 'jwk' });

  function jwt(audiencia) {
    const cab = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const datos = b64u(JSON.stringify({ aud: audiencia, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sujeto }));
    const firma = crypto.sign('sha256', Buffer.from(`${cab}.${datos}`), { key: clavePrivada, dsaEncoding: 'ieee-p1363' });
    return `${cab}.${datos}.${b64u(firma)}`;
  }

  return {
    clavePublica: publica,
    // Devuelve 'ok', 'caducada' (hay que borrar la suscripción) o lanza un error
    async enviar(sub, datos, { ttl = 24 * 3600, urgencia = 'normal' } = {}) {
      const url = new URL(sub.endpoint);
      const cuerpo = cifrar(JSON.stringify(datos), sub.p256dh, sub.auth);
      const r = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          TTL: String(ttl),
          Urgency: urgencia,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          Authorization: `vapid t=${jwt(url.origin)}, k=${publica}`,
        },
        body: cuerpo,
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 404 || r.status === 410) return 'caducada';
      if (!r.ok) throw new Error(`El servicio de notificaciones respondió ${r.status}`);
      return 'ok';
    },
  };
}
