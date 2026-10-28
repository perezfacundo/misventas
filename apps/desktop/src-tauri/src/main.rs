// En Windows, sin consola de fondo en la versión final.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    misventas_desktop_lib::run()
}
