import { invoke } from "@tauri-apps/api/core";

/** ¿La app corre dentro de la versión de escritorio (Tauri)? */
export const isDesktop = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface SystemPrinter {
  name: string;
  label: string;
  is_default: boolean;
}

export const listSystemPrinters = () => invoke<SystemPrinter[]>("list_printers");

export const printToSystem = (printer: string, data: Uint8Array) => invoke<void>("print_raw", { printer, data: Array.from(data) });

export const printToNetwork = (host: string, data: Uint8Array) => invoke<void>("print_network", { host, data: Array.from(data) });
