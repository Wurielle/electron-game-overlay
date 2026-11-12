//! Test process for the SDK's exact-target, file-free transport boundary.
use std::io::{self, BufRead, Write};
use std::ptr;

use electron_overlay_transport::ffi::{
    ego_transport_create_for_private_route_v2, ego_transport_destroy, ego_transport_publish_fps,
    EgoPrivateRouteV2, EgoTransport, EGO_ABI_VERSION, EGO_PRIVATE_ROUTE_VERSION, EGO_STATUS_OK,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Route {
    producer_pid: u32,
    producer_creation_time_100ns: String,
    target_pid: u32,
    creation_time_100ns: String,
    port: u16,
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Command {
    Start { slot: usize, route: Route },
    Stop { slot: usize },
    PublishFps { slot: usize, fps_milli: u32 },
}

struct Slot(*mut EgoTransport);

impl Drop for Slot {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { ego_transport_destroy(self.0) };
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut slots = [Slot(ptr::null_mut()), Slot(ptr::null_mut())];
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "ready")?;
    stdout.flush()?;
    for line in io::stdin().lock().lines() {
        let status = match serde_json::from_str::<Command>(&line?)? {
            Command::Start { slot, route } => {
                let target = slots.get_mut(slot).ok_or("invalid slot")?;
                if !target.0.is_null() {
                    return Err("slot already started".into());
                }
                let route = EgoPrivateRouteV2 {
                    struct_size: std::mem::size_of::<EgoPrivateRouteV2>() as u32,
                    version: EGO_PRIVATE_ROUTE_VERSION,
                    target_creation_time_100ns: route.creation_time_100ns.parse()?,
                    producer_creation_time_100ns: route.producer_creation_time_100ns.parse()?,
                    input_capabilities: 0,
                    producer_pid: route.producer_pid,
                    target_pid: route.target_pid,
                    port: route.port,
                    reserved: 0,
                    reserved2: 0,
                    token_ascii: route
                        .token
                        .into_bytes()
                        .try_into()
                        .map_err(|_| "invalid token length")?,
                };
                unsafe {
                    ego_transport_create_for_private_route_v2(
                        EGO_ABI_VERSION,
                        &route,
                        &mut target.0,
                    )
                }
            }
            Command::Stop { slot } => {
                let target = slots.get_mut(slot).ok_or("invalid slot")?;
                if target.0.is_null() {
                    return Err("slot was not started".into());
                }
                let transport = std::mem::replace(&mut target.0, ptr::null_mut());
                unsafe { ego_transport_destroy(transport) }
            }
            Command::PublishFps { slot, fps_milli } => {
                let target = slots.get(slot).ok_or("invalid slot")?;
                if target.0.is_null() {
                    return Err("slot was not started".into());
                }
                unsafe { ego_transport_publish_fps(target.0, fps_milli) }
            }
        };
        writeln!(stdout, "{status}")?;
        stdout.flush()?;
        if status != EGO_STATUS_OK {
            return Err("native private route failed".into());
        }
    }
    Ok(())
}
