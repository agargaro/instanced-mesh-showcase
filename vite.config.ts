import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * Absolute site URL for the social preview tags (Twitter and Open Graph need absolute image URLs): `SITE_URL` if set,
 * otherwise the production domain Vercel exposes at build time.
 */
function siteUrl(): Plugin {
  const vercel = process.env['VERCEL_PROJECT_PRODUCTION_URL'];
  const url = (process.env['SITE_URL'] ?? (vercel !== undefined ? `https://${vercel}` : '')).replace(/\/$/, '');
  return {
    name: 'site-url',
    transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', url)
  };
}

export default defineConfig({
  plugins: [siteUrl()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 }
});
