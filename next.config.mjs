/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dos sesiones de desarrollo pueden convivir en esta carpeta: cada una puede
  // aislar su build con NEXT_DIST_DIR para no pisarse el .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // El render del PDF usa Chromium: estos paquetes no deben empaquetarse por webpack,
  // se cargan como dependencias nativas del runtime de Node.
  serverExternalPackages: ["puppeteer", "puppeteer-core", "@sparticuz/chromium"],
  // En serverless (Vercel) los archivos de `public/` no viven en el filesystem de la
  // función. El PDF embebe el logo y los medios de pago como data URI leyéndolos con fs,
  // así que hay que incluirlos explícitamente en el trazado de la función de generación.
  outputFileTracingIncludes: {
    "/api/admin/pdf/generate": [
      "./public/brand/**",
      "./public/pagos/**",
      "./node_modules/@sparticuz/chromium/bin/**"
    ],
    "/api/admin/importaciones/template": [
      "./assets/import/plantilla_importacion_productos.xlsx"
    ]
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb"
    }
  }
};

export default nextConfig;
