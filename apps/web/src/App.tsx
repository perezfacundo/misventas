import { useEffect } from "react";
import { useSettings, applyUiPrefs } from "./data/settings";
import { useHashRoute, type Route } from "./lib/hooks";
import { Layout } from "./components/Layout";
import { SessionGate, useSession } from "./components/Session";
import { Vender } from "./screens/Vender";
import { Hoy } from "./screens/Hoy";
import { Productos } from "./screens/Productos";
import { Caja } from "./screens/Caja";
import { Ventas } from "./screens/Ventas";
import { Clientes } from "./screens/Clientes";
import { Proveedores } from "./screens/Proveedores";
import { Reportes } from "./screens/Reportes";
import { Promociones } from "./screens/Promociones";
import { Ajustes } from "./screens/Ajustes";
import { Onboarding } from "./screens/Onboarding";
import type { Settings } from "./db";

export function App() {
  const settings = useSettings();

  useEffect(() => {
    if (settings) applyUiPrefs(settings);
  }, [settings]);

  if (!settings) return null;
  if (!settings.onboarded) return <Onboarding />;

  return (
    <SessionGate>
      <Screens settings={settings} />
    </SessionGate>
  );
}

function Screens({ settings }: { settings: Settings }) {
  const [route, navigate] = useHashRoute();
  const { can } = useSession();
  // Si el rol no permite la pantalla (por ejemplo, un cajero con un link a Reportes), vuelve a Vender.
  const allowed: Route =
    (route === "reportes" && !can("verReportes")) || (route === "proveedores" && !can("gestionarProveedores")) || (route === "promociones" && !can("editarProductos"))
      ? "vender"
      : route;

  return (
    <Layout route={allowed} navigate={navigate} businessName={settings.businessName}>
      {allowed === "vender" && <Vender settings={settings} />}
      {allowed === "hoy" && <Hoy navigate={navigate} />}
      {allowed === "productos" && <Productos settings={settings} />}
      {allowed === "caja" && <Caja />}
      {allowed === "ventas" && <Ventas settings={settings} />}
      {allowed === "clientes" && <Clientes settings={settings} />}
      {allowed === "proveedores" && <Proveedores settings={settings} />}
      {allowed === "reportes" && <Reportes />}
      {allowed === "promociones" && <Promociones />}
      {allowed === "ajustes" && <Ajustes settings={settings} />}
    </Layout>
  );
}
