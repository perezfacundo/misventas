use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use printers::common::base::job::PrinterJobOptions;
use printers::common::converters::Converter;
use serde::Serialize;

#[derive(Serialize)]
pub struct PrinterInfo {
    /// Nombre de sistema: es el que hay que usar para imprimir.
    name: String,
    /// Nombre para mostrar.
    label: String,
    is_default: bool,
}

/// Impresoras instaladas en el sistema (CUPS en Linux y macOS, spooler en Windows).
#[tauri::command]
pub async fn list_printers() -> Vec<PrinterInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        let default = printers::get_default_printer().map(|p| p.system_name);
        printers::get_printers()
            .into_iter()
            .map(|p| PrinterInfo {
                is_default: default.as_deref() == Some(p.system_name.as_str()),
                label: if p.description.is_empty() { p.name.clone() } else { p.description.clone() },
                name: p.system_name,
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Manda bytes crudos (ESC/POS) a una impresora del sistema, sin pasar por el driver gráfico.
#[tauri::command]
pub async fn print_raw(printer: String, data: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = printers::get_printer_by_name(&printer)
            .ok_or_else(|| format!("No se encontró la impresora \"{printer}\". Revisá que esté conectada."))?;
        // En CUPS hay que pedir explícitamente el modo crudo; en Windows el modo por defecto ya es RAW
        // (pasarle esta propiedad allá cambiaría el tipo de dato del trabajo).
        #[cfg(unix)]
        let raw_properties: &[(&str, &str)] = &[("document-format", "application/vnd.cups-raw")];
        #[cfg(not(unix))]
        let raw_properties: &[(&str, &str)] = &[];
        let options = PrinterJobOptions {
            name: Some("Ticket Mis Ventas"),
            raw_properties,
            converter: Converter::None,
        };
        target
            .print(&data, options)
            .map(|_| ())
            .map_err(|e| format!("La impresora no aceptó el ticket: {}", e.message))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Impresoras de red (la mayoría de las ticketeras con Ethernet escuchan en el puerto 9100).
#[tauri::command]
pub async fn print_network(host: String, data: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (address, port) = match host.trim().rsplit_once(':') {
            Some((a, p)) if p.parse::<u16>().is_ok() => (a.to_string(), p.parse::<u16>().unwrap()),
            _ => (host.trim().to_string(), 9100),
        };
        let addr = (address.as_str(), port)
            .to_socket_addrs()
            .map_err(|_| format!("La dirección \"{host}\" no es válida."))?
            .next()
            .ok_or_else(|| format!("La dirección \"{host}\" no es válida."))?;
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(4))
            .map_err(|_| format!("No se pudo conectar con la impresora en {address}:{port}. ¿Está prendida y en la misma red?"))?;
        stream.set_write_timeout(Some(Duration::from_secs(8))).ok();
        stream.write_all(&data).and_then(|_| stream.flush()).map_err(|e| format!("Se cortó la conexión con la impresora: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    #[test]
    fn manda_los_bytes_a_una_ticketera_de_red() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let received = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            socket.read_to_end(&mut buf).unwrap();
            buf
        });
        let ticket = vec![0x1b, 0x40, b'H', b'o', b'l', b'a', 0x0a, 0x1d, 0x56, 0x42, 0x00];
        tauri::async_runtime::block_on(print_network(format!("127.0.0.1:{port}"), ticket.clone())).unwrap();
        assert_eq!(received.join().unwrap(), ticket);
    }

    #[test]
    fn avisa_si_la_ticketera_no_responde() {
        // Puerto cerrado: se conecta y falla enseguida con un mensaje para mostrar.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let err = tauri::async_runtime::block_on(print_network(format!("127.0.0.1:{port}"), vec![1])).unwrap_err();
        assert!(err.contains("No se pudo conectar"), "{err}");
    }

    #[test]
    fn rechaza_direcciones_invalidas() {
        let err = tauri::async_runtime::block_on(print_network("no es una ip".into(), vec![1])).unwrap_err();
        assert!(err.contains("no es válida"), "{err}");
    }

    #[test]
    fn listar_impresoras_no_falla_aunque_no_haya_ninguna() {
        let _ = tauri::async_runtime::block_on(list_printers());
    }
}
