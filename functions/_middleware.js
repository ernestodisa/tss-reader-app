// Corre ANTES de servir cualquier asset. Cierra la fuga de los alias públicos
// <hash>.tss-reader-app.pages.dev, que NO pasan por Cloudflare Access (regla 3
// de la skill blindar-app-cloudflare). Solo el host canónico sirve contenido.
const HOST_CANONICO = 'tss-reader-app.pages.dev';

export async function onRequest(context) {
  const host = new URL(context.request.url).hostname.toLowerCase();
  if (host.endsWith('.pages.dev') && host !== HOST_CANONICO) {
    return new Response('No encontrado', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return context.next();
}
