// Pages Function catch-all /api/* — el backend de Folio en el MISMO origen que
// el frontend, detrás de la misma Cloudflare Access (patrón de la skill
// blindar-app-cloudflare, regla 4: identidad = JWT de Access, nunca headers
// del cliente).
//
// Reutiliza la lógica del worker standalone (worker/src): aquí solo se valida
// el JWT y se re-enruta quitando el prefijo /api. El worker público de
// workers.dev queda como backend de desarrollo local únicamente.
//
// Variables (Pages → Settings → Variables and Secrets):
//   ACCESS_TEAM_DOMAIN  p.ej. "folio-ff.cloudflareaccess.com"
//   ACCESS_AUD          Application Audience (AUD) tag de la app en Access
// Mientras AMBAS falten (etapa previa a encender Access) el API pasa abierto,
// igual que hoy; en cuanto existan, la validación es obligatoria (fail-closed).

import workerApp from '../../worker/src/index';
import type { Env as WorkerEnv } from '../../worker/src/types';

interface PagesEnv extends WorkerEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

// ── Validación del JWT de Access (RS256 contra el JWKS del team) ──────────
let jwksCache: { domain: string | null; at: number; keys: JsonWebKey[] & { kid?: string }[] } = {
  domain: null,
  at: 0,
  keys: [],
};
const JWKS_TTL_MS = 3600000;

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToJson(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function getJwks(teamDomain: string) {
  const now = Date.now();
  if (jwksCache.keys.length && jwksCache.domain === teamDomain && now - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('No se pudo obtener el JWKS de Access');
  const data = (await res.json()) as { keys?: never[] };
  jwksCache = { domain: teamDomain, at: now, keys: data.keys || [] };
  return jwksCache.keys;
}

async function verifyAccessJwt(token: string, teamDomain: string, aud: string): Promise<void> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT mal formado');
  const header = b64urlToJson(parts[0]) as { kid?: string };
  const payload = b64urlToJson(parts[1]) as { exp?: number; iss?: string; aud?: string | string[] };

  const keys = await getJwks(teamDomain);
  const jwk = (keys as { kid?: string; kty?: string; n?: string; e?: string }[]).find(
    (k) => k.kid === header.kid,
  );
  if (!jwk) throw new Error('kid del JWT no está en el JWKS');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true } as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), signed);
  if (!ok) throw new Error('Firma del JWT inválida');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('JWT expirado');
  if (payload.iss !== `https://${teamDomain}`) throw new Error('iss inesperado');
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(aud)) throw new Error('aud inesperado');
}

// ── Handler ────────────────────────────────────────────────────────────────
export const onRequest: PagesFunction<PagesEnv> = async (context) => {
  const { request, env } = context;

  const teamDomain = (env.ACCESS_TEAM_DOMAIN || '').trim();
  const aud = (env.ACCESS_AUD || '').trim();
  const accessConfigured = Boolean(teamDomain && aud);

  // El preflight CORS no lleva cookies ni JWT; el worker interno lo responde.
  if (accessConfigured && request.method !== 'OPTIONS') {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) {
      return new Response(JSON.stringify({ error: 'no_autenticado' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    try {
      await verifyAccessJwt(token, teamDomain, aud);
    } catch {
      return new Response(JSON.stringify({ error: 'sesion_invalida' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Re-enruta /api/tts → /tts hacia la lógica del worker (mismo Env: R2 + keys).
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api/, '') || '/';
  const inner = new Request(url.toString(), request);
  return workerApp.fetch(inner, env);
};
