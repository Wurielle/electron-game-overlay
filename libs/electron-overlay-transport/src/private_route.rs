use std::io;
use std::net::{SocketAddr, SocketAddrV4, TcpStream};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::Duration;

use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, HANDLE, WAIT_TIMEOUT};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP_STATE_ESTAB, TCP_TABLE_OWNER_PID_CONNECTIONS,
};
use windows::Win32::Networking::WinSock::AF_INET;
use windows::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};

use crate::electron_frame::creation_time_for_process;

#[derive(Clone, Copy)]
pub(crate) struct ProducerIdentity {
    pub pid: u32,
    pub creation_time: u64,
}

impl ProducerIdentity {
    pub fn open_live(self) -> io::Result<OwnedHandle> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                self.pid,
            )
        }
        .map_err(io::Error::other)?;
        let owned = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        if creation_time_for_process(handle)? != self.creation_time || !is_live(&owned) {
            return Err(invalid_producer());
        }
        Ok(owned)
    }

    pub fn connect(self, address: SocketAddrV4, timeout: Duration) -> io::Result<TcpStream> {
        let producer = self.open_live()?;
        let stream = TcpStream::connect_timeout(&address.into(), timeout)?;
        let SocketAddr::V4(client) = stream.local_addr()? else {
            return Err(invalid_producer());
        };
        // The server end reverses the client tuple. Recheck the same process
        // handle after the snapshot so a reused PID cannot authorize a socket.
        if !owns_connection(self.pid, address, client)? || !is_live(&producer) {
            return Err(invalid_producer());
        }
        Ok(stream)
    }
}

fn is_live(process: &OwnedHandle) -> bool {
    unsafe { WaitForSingleObject(HANDLE(process.as_raw_handle()), 0) == WAIT_TIMEOUT }
}

fn invalid_producer() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "private route producer identity mismatch",
    )
}

fn owns_connection(pid: u32, server: SocketAddrV4, client: SocketAddrV4) -> io::Result<bool> {
    // MIB_TCPTABLE_OWNER_PID is a DWORD count followed by IPv4 rows of six
    // DWORDs. The aligned allocation also bounds what we read from the API.
    const MAX_TABLE_BYTES: u32 = 32 * 1024 * 1024;
    let mut table = Vec::<u32>::new();
    let mut bytes = 0;
    for _ in 0..4 {
        let status = unsafe {
            GetExtendedTcpTable(
                (!table.is_empty()).then_some(table.as_mut_ptr().cast()),
                &mut bytes,
                false,
                u32::from(AF_INET.0),
                TCP_TABLE_OWNER_PID_CONNECTIONS,
                0,
            )
        };
        if status == ERROR_INSUFFICIENT_BUFFER.0 && (4..=MAX_TABLE_BYTES).contains(&bytes) {
            table.resize(bytes.div_ceil(4) as usize, 0);
            bytes = (table.len() * 4) as u32;
            continue;
        }
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let words = table
            .get(..(bytes / 4) as usize)
            .ok_or_else(invalid_producer)?;
        let (&count, rows) = words.split_first().ok_or_else(invalid_producer)?;
        if count as usize > rows.len() / 6 {
            return Err(invalid_producer());
        }
        return Ok(rows.chunks_exact(6).take(count as usize).any(|row| {
            row[0] == MIB_TCP_STATE_ESTAB.0 as u32
                && row[1] == u32::from_ne_bytes(server.ip().octets())
                && u16::from_be(row[2] as u16) == server.port()
                && row[3] == u32::from_ne_bytes(client.ip().octets())
                && u16::from_be(row[4] as u16) == client.port()
                && row[5] == pid
        }));
    }
    Err(invalid_producer())
}
