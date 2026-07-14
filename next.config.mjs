/** @type {import('next').NextConfig} */
const nextConfig = {
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
    ]
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb"
    }
  }
};

export default nextConfig;
