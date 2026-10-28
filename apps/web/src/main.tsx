import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { ToastProvider } from "./components/ui";
import { initDeviceId, requestPersistentStorage } from "./db";
// Registra los cambios pendientes de sincronizar: tiene que cargarse antes de cualquier escritura.
import "./sync/tracking";
import { startSync } from "./sync/engine";
import { isDesktop } from "./print/desktop";
import "./styles.css";

// Service worker: la app abre y funciona sin internet, y se actualiza sola.
// En la app de escritorio no hace falta: la interfaz ya viene empaquetada adentro.
if (!isDesktop()) registerSW({ immediate: true });
void requestPersistentStorage();
await initDeviceId();
void startSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
