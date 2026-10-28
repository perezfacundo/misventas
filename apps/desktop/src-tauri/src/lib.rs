//! Mis Ventas para escritorio: la misma app web empaquetada, con impresión directa en la ticketera.
//! La interfaz arma el ticket en ESC/POS y estos comandos mandan los bytes tal cual a la impresora.

mod printing;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            printing::list_printers,
            printing::print_raw,
            printing::print_network
        ])
        .run(tauri::generate_context!())
        .expect("no se pudo iniciar Mis Ventas");
}
