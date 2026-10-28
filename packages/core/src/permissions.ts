export type Role = "dueno" | "encargado" | "cajero";

export const ROLE_LABELS: Record<Role, string> = {
  dueno: "Dueño/a",
  encargado: "Encargado/a",
  cajero: "Cajero/a",
};

export type Permission =
  | "anularVenta"
  | "descontar"
  | "verCostos"
  | "editarProductos"
  | "ingresarMercaderia"
  | "cerrarCajaAjena"
  | "verReportes"
  | "gestionarProveedores"
  | "ajustes"
  | "usuarios";

/** Qué puede hacer cada rol. El dueño puede todo; el cajero vende, cobra, fía y maneja su caja. */
const GRANTS: Record<Role, ReadonlySet<Permission>> = {
  dueno: new Set<Permission>([
    "anularVenta", "descontar", "verCostos", "editarProductos", "ingresarMercaderia",
    "cerrarCajaAjena", "verReportes", "gestionarProveedores", "ajustes", "usuarios",
  ]),
  encargado: new Set<Permission>([
    "anularVenta", "descontar", "verCostos", "editarProductos", "ingresarMercaderia",
    "cerrarCajaAjena", "verReportes", "gestionarProveedores",
  ]),
  cajero: new Set<Permission>(["ingresarMercaderia"]),
};

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return role ? GRANTS[role].has(permission) : false;
}
