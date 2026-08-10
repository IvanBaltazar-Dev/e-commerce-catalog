import { redirect } from "next/navigation";
import { ToastProvider } from "@/components/admin/ToastProvider";
import { panelRole } from "@/lib/auth/panel";

/**
 * El layout de impresión.
 *
 * Aquí NO entra el panel: ni barra superior, ni navegación, ni nada del resto
 * de la aplicación. Esa es toda la razón de que este grupo exista.
 *
 * Antes la nota vivía dentro de `(panel)` y la impresión se conseguía marcando
 * con `.ticket-noprint` cada elemento que no debía salir. Eso es una lista de
 * exclusión: funciona hasta que alguien añade un elemento al panel y no se
 * acuerda de marcarlo, y entonces aparece impreso en el ticket de una clienta.
 * Sacando la ruta del panel no hay nada que esconder.
 *
 * Lo único que se conserva del panel es el control de acceso: una nota de venta
 * lleva el nombre y el teléfono de una clienta, y no se abre sin sesión. La
 * comprobación es la misma que hace `(panel)`, no una copia relajada.
 */
export default async function PrintLayout({ children }: { children: React.ReactNode }) {
  const role = await panelRole();

  if (!role) {
    redirect("/admin/login?error=forbidden");
  }

  // ToastProvider sigue porque la vista usa `useApiError`, que avisa por ahí
  // cuando la venta no se puede leer.
  return (
    <ToastProvider>
      <div className="print-shell">{children}</div>
    </ToastProvider>
  );
}
