// simpleVIS desktop backend.
//
// The Rust side owns everything a browser cannot do: UDP sockets for Art-Net
// and sACN, a serial port for USB DMX, and network interface enumeration. It
// owns no lighting logic at all — parsing MVR/GDTF, evaluating DMX and drawing
// beams all happen in the webview, shared byte-for-byte with the hosted build.
//
// Universes are pushed to the front end as Tauri events rather than polled, so
// a static look costs nothing and a fast chase is not rate-limited by the UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod diag;

// The protocol, merge, socket and serial code lives in the library half of
// this crate so the integration tests in `tests/` can drive it without a GUI.
use simplevis::{citp, merge, net, serial};

use std::net::Ipv4Addr;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

use citp::{CitpPeer, CitpPeerInfo, PatchedFixture};
use merge::MergeMode;
use net::{InputEngine, SourceStatus, UniverseFrame};
use serial::SerialInput;

struct AppState {
    input: InputEngine,
    usb: SerialInput,
    usb_universe: Mutex<u16>,
    citp: CitpPeer,
}

#[derive(serde::Serialize)]
struct Interface {
    name: String,
    address: String,
}

#[tauri::command]
fn list_interfaces() -> Vec<Interface> {
    net::list_interfaces()
        .into_iter()
        .map(|(name, address)| Interface { name, address })
        .collect()
}

#[tauri::command]
fn start_network(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    protocols: Vec<String>,
    interface_address: String,
) -> Result<(), String> {
    let interface: Ipv4Addr = interface_address.parse().unwrap_or(Ipv4Addr::UNSPECIFIED);

    let frame_app = app.clone();
    let source_app = app.clone();
    state
        .input
        .start(
            &protocols,
            interface,
            move |frame: UniverseFrame| {
                let _ = frame_app.emit("simplevis://universe", frame);
            },
            move |sources: Vec<SourceStatus>| {
                let _ = source_app.emit("simplevis://sources", sources);
            },
        )
        .map_err(|e| format!("could not start listening: {e}"))
}

#[tauri::command]
fn stop_network(state: tauri::State<'_, AppState>) {
    state.input.stop();
}

/// Tell the backend which universes the patch uses, so sACN multicast groups
/// can be joined. Without this only unicast sACN arrives.
#[tauri::command]
fn set_universes(state: tauri::State<'_, AppState>, universes: Vec<u16>) -> Result<(), String> {
    state.input.set_universes(&universes).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_merge_mode(state: tauri::State<'_, AppState>, mode: String) {
    state.input.set_mode(match mode.as_str() {
        "ltp" => MergeMode::Ltp,
        "none" => MergeMode::None,
        _ => MergeMode::Htp,
    });
}

#[tauri::command]
fn list_serial_ports() -> Vec<String> {
    serial::list_ports()
}

#[tauri::command]
fn open_serial(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    port: String,
) -> Result<(), String> {
    let universe = *state.usb_universe.lock().unwrap();
    state.usb.start(&port, universe, move |universe, slots| {
        let _ = app.emit("simplevis://universe", UniverseFrame { universe, slots });
    })
}

#[tauri::command]
fn close_serial(state: tauri::State<'_, AppState>) {
    state.usb.stop();
}

#[tauri::command]
fn set_usb_universe(state: tauri::State<'_, AppState>, universe: u16) {
    *state.usb_universe.lock().unwrap() = universe;
}

/// Start the CITP peer: multicast discovery, then TCP to whatever answers.
///
/// Levels arrive on the same `simplevis://universe` channel as Art-Net and
/// sACN, so the front end needs to know nothing about which protocol delivered
/// a frame.
#[tauri::command]
fn start_citp(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    interface_address: String,
) -> Result<(), String> {
    let interface: Ipv4Addr = interface_address.parse().unwrap_or(Ipv4Addr::UNSPECIFIED);
    let frame_app = app.clone();
    let patch_app = app.clone();

    state
        .citp
        .start(
            interface,
            "simpleVIS".to_string(),
            move |universe, slots| {
                let _ = frame_app.emit("simplevis://universe", UniverseFrame { universe, slots });
            },
            move |fixtures: Vec<PatchedFixture>| {
                let _ = patch_app.emit("simplevis://citp-patch", fixtures);
            },
        )
        .map_err(|e| format!("could not start CITP: {e}"))
}

#[tauri::command]
fn stop_citp(state: tauri::State<'_, AppState>) {
    state.citp.stop();
}

#[tauri::command]
fn citp_peers(state: tauri::State<'_, AppState>) -> Vec<CitpPeerInfo> {
    state.citp.peers()
}

#[tauri::command]
fn citp_patch(state: tauri::State<'_, AppState>) -> Vec<PatchedFixture> {
    state.citp.patch()
}

#[tauri::command]
fn collect_diagnostics(app: tauri::AppHandle) -> Result<String, String> {
    diag::collect(&app).map_err(|e| e.to_string())
}

fn main() {
    diag::init();

    tauri::Builder::default()
        .setup(|app| {
            app.manage(AppState {
                input: InputEngine::new(),
                usb: SerialInput::new(),
                usb_universe: Mutex::new(1),
                citp: CitpPeer::new(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_interfaces,
            start_network,
            stop_network,
            set_universes,
            set_merge_mode,
            list_serial_ports,
            open_serial,
            close_serial,
            set_usb_universe,
            start_citp,
            stop_citp,
            citp_peers,
            citp_patch,
            collect_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running simpleVIS");
}
