/**
 * Inicio de sesión en el panel para las pruebas de navegador.
 *
 * El formulario de acceso es un componente cliente. Si se pulsa Enviar antes de
 * que React hidrate, el navegador envía el form de forma NATIVA —se reconoce en
 * el log del servidor como `GET /admin/login?`— y la redirección nunca ocurre.
 * Con el servidor de desarrollo frío la compilación de la ruta tarda más que
 * cualquier espera fija, así que esperar «un rato» no es una solución: es una
 * apuesta que falla de forma intermitente y siempre en el peor momento.
 *
 * Se reintenta: el segundo intento corre sobre una ruta ya compilada y una
 * página ya hidratada, de modo que el fallo se corrige solo en lugar de
 * detener la prueba.
 */
export async function signInToPanel(page, { baseUrl, email, password, expectedPath, attempts = 4 }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.goto(`${baseUrl}/admin/login`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector('input[type="email"]');

    await page.$eval('input[type="email"]', (node) => { node.value = ""; });
    await page.$eval('input[type="password"]', (node) => { node.value = ""; });
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', password);
    await page.click('button[type="submit"]');

    try {
      await page.waitForFunction(
        (path) => window.location.pathname === path,
        { timeout: 20000 },
        expectedPath
      );
      return;
    } catch {
      // Envío nativo por hidratación incompleta. Se reintenta.
    }
  }

  throw new Error(`No se pudo iniciar sesión como ${email} tras ${attempts} intentos.`);
}
