export default [
  {
    name: 'thorn',
    transform(code) {
      return code.replaceAll('@thorn', '\u{1F339}');
    },
  },
  {
    name: 'document-marker',
    async onResponse(ctx, res) {
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/html')) return;
      if (!res.body) return;
      const html = await res.text();
      return new Response(html.replace('<html', '<html data-hooked="1"'), {
        status: res.status,
        headers: res.headers,
      });
    },
  },
];

export const i18n = { preload: ['en', 'zh'] };
