//! Framing shared by the injected hudhook payload and the Node loopback host.

use std::fmt;

pub const JSON_KIND: u8 = 1;
pub const FRAME_KIND: u8 = 2;
pub const MAX_JSON_BODY: usize = 1024 * 1024;
pub const MAX_FRAME_BODY: usize = 256 * 1024 * 1024;
const HEADER_SIZE: usize = 5;
const FRAME_METADATA_SIZE: usize = 12;
const BYTES_PER_PIXEL: usize = 4;

#[derive(Debug, PartialEq, Eq)]
pub enum WirePacket {
    Json(String),
    Frame(WireFrame),
}

#[derive(Debug, PartialEq, Eq)]
pub struct WireFrame {
    pub window_id: u32,
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

#[derive(Default)]
pub struct WireDecoder {
    buffer: Vec<u8>,
}

impl WireDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<WirePacket>, WireError> {
        self.buffer.extend_from_slice(bytes);
        let mut packets = Vec::new();

        loop {
            if self.buffer.len() < HEADER_SIZE {
                break;
            }

            let body_length = u32::from_le_bytes(
                self.buffer[0..4]
                    .try_into()
                    .expect("fixed wire length field"),
            ) as usize;
            let kind = self.buffer[4];
            let maximum = match kind {
                JSON_KIND => MAX_JSON_BODY,
                FRAME_KIND => MAX_FRAME_BODY,
                _ => return Err(WireError::UnknownKind(kind)),
            };
            if body_length > maximum {
                return Err(WireError::BodyTooLarge {
                    kind,
                    length: body_length,
                    maximum,
                });
            }

            let packet_length = HEADER_SIZE
                .checked_add(body_length)
                .ok_or(WireError::LengthOverflow)?;
            if self.buffer.len() < packet_length {
                break;
            }

            let packet = decode_body(kind, &self.buffer[HEADER_SIZE..packet_length])?;
            self.buffer.drain(..packet_length);
            packets.push(packet);
        }

        Ok(packets)
    }
}

pub fn encode_json(json: &str) -> Result<Vec<u8>, WireError> {
    encode_packet(JSON_KIND, json.as_bytes(), MAX_JSON_BODY)
}

#[cfg(test)]
fn encode_frame(frame: &WireFrame) -> Result<Vec<u8>, WireError> {
    validate_frame_dimensions(frame.width, frame.height, frame.bgra.len())?;
    let body_length = FRAME_METADATA_SIZE
        .checked_add(frame.bgra.len())
        .ok_or(WireError::LengthOverflow)?;
    let mut body = Vec::with_capacity(body_length);
    body.extend_from_slice(&frame.window_id.to_le_bytes());
    body.extend_from_slice(&frame.width.to_le_bytes());
    body.extend_from_slice(&frame.height.to_le_bytes());
    body.extend_from_slice(&frame.bgra);
    encode_packet(FRAME_KIND, &body, MAX_FRAME_BODY)
}

fn encode_packet(kind: u8, body: &[u8], maximum: usize) -> Result<Vec<u8>, WireError> {
    if body.len() > maximum {
        return Err(WireError::BodyTooLarge {
            kind,
            length: body.len(),
            maximum,
        });
    }
    let body_length: u32 = body
        .len()
        .try_into()
        .map_err(|_| WireError::LengthOverflow)?;
    let mut packet = Vec::with_capacity(HEADER_SIZE + body.len());
    packet.extend_from_slice(&body_length.to_le_bytes());
    packet.push(kind);
    packet.extend_from_slice(body);
    Ok(packet)
}

fn decode_body(kind: u8, body: &[u8]) -> Result<WirePacket, WireError> {
    match kind {
        JSON_KIND => std::str::from_utf8(body)
            .map(str::to_owned)
            .map(WirePacket::Json)
            .map_err(WireError::InvalidUtf8),
        FRAME_KIND => decode_frame(body).map(WirePacket::Frame),
        _ => Err(WireError::UnknownKind(kind)),
    }
}

fn decode_frame(body: &[u8]) -> Result<WireFrame, WireError> {
    if body.len() < FRAME_METADATA_SIZE {
        return Err(WireError::TruncatedFrameMetadata(body.len()));
    }
    let window_id = u32::from_le_bytes(body[0..4].try_into().expect("fixed window id"));
    let width = u32::from_le_bytes(body[4..8].try_into().expect("fixed frame width"));
    let height = u32::from_le_bytes(body[8..12].try_into().expect("fixed frame height"));
    let pixels = &body[FRAME_METADATA_SIZE..];
    validate_frame_dimensions(width, height, pixels.len())?;
    Ok(WireFrame {
        window_id,
        width,
        height,
        bgra: pixels.to_vec(),
    })
}

fn validate_frame_dimensions(width: u32, height: u32, actual: usize) -> Result<(), WireError> {
    if width == 0 || height == 0 {
        return Err(WireError::InvalidFrameDimensions { width, height });
    }
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(BYTES_PER_PIXEL))
        .ok_or(WireError::FrameDimensionsOverflow { width, height })?;
    if actual != expected {
        return Err(WireError::FrameLengthMismatch {
            width,
            height,
            expected,
            actual,
        });
    }
    Ok(())
}

#[derive(Debug)]
pub enum WireError {
    UnknownKind(u8),
    BodyTooLarge {
        kind: u8,
        length: usize,
        maximum: usize,
    },
    LengthOverflow,
    InvalidUtf8(std::str::Utf8Error),
    TruncatedFrameMetadata(usize),
    InvalidFrameDimensions {
        width: u32,
        height: u32,
    },
    FrameDimensionsOverflow {
        width: u32,
        height: u32,
    },
    FrameLengthMismatch {
        width: u32,
        height: u32,
        expected: usize,
        actual: usize,
    },
}

impl fmt::Display for WireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownKind(kind) => write!(formatter, "unknown packet kind: {kind}"),
            Self::BodyTooLarge {
                kind,
                length,
                maximum,
            } => write!(
                formatter,
                "packet kind {kind} body is {length} bytes, maximum is {maximum}"
            ),
            Self::LengthOverflow => formatter.write_str("packet length overflow"),
            Self::InvalidUtf8(error) => write!(formatter, "invalid packet UTF-8: {error}"),
            Self::TruncatedFrameMetadata(length) => {
                write!(formatter, "frame metadata is truncated: {length} bytes")
            }
            Self::InvalidFrameDimensions { width, height } => {
                write!(formatter, "invalid frame dimensions: {width}x{height}")
            }
            Self::FrameDimensionsOverflow { width, height } => {
                write!(formatter, "frame dimensions overflow: {width}x{height}")
            }
            Self::FrameLengthMismatch {
                width,
                height,
                expected,
                actual,
            } => write!(
                formatter,
                "frame {width}x{height} needs {expected} BGRA bytes, received {actual}"
            ),
        }
    }
}

impl std::error::Error for WireError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_and_frame_round_trip_through_arbitrary_fragmentation() {
        let json = encode_json(r#"{"type":"overlay.init","windows":[]}"#).unwrap();
        let frame = encode_frame(&WireFrame {
            window_id: 7,
            width: 2,
            height: 1,
            bgra: vec![1, 2, 3, 4, 5, 6, 7, 8],
        })
        .unwrap();
        let bytes = [json, frame].concat();

        for chunk_size in 1..=bytes.len() {
            let mut decoder = WireDecoder::default();
            let mut decoded = Vec::new();
            for chunk in bytes.chunks(chunk_size) {
                decoded.extend(decoder.push(chunk).unwrap());
            }
            assert_eq!(
                decoded,
                vec![
                    WirePacket::Json(r#"{"type":"overlay.init","windows":[]}"#.to_owned()),
                    WirePacket::Frame(WireFrame {
                        window_id: 7,
                        width: 2,
                        height: 1,
                        bgra: vec![1, 2, 3, 4, 5, 6, 7, 8],
                    }),
                ]
            );
        }
    }

    #[test]
    fn rejects_oversized_body_from_header_before_body_arrives() {
        let mut decoder = WireDecoder::default();
        let header = [
            ((MAX_JSON_BODY as u32) + 1).to_le_bytes().as_slice(),
            &[JSON_KIND],
        ]
        .concat();
        assert!(matches!(
            decoder.push(&header),
            Err(WireError::BodyTooLarge {
                kind: JSON_KIND,
                ..
            })
        ));
    }

    #[test]
    fn rejects_frame_with_inconsistent_dimensions() {
        let mut body = Vec::new();
        body.extend_from_slice(&9_u32.to_le_bytes());
        body.extend_from_slice(&2_u32.to_le_bytes());
        body.extend_from_slice(&2_u32.to_le_bytes());
        body.extend_from_slice(&[0; 4]);
        let packet = encode_packet(FRAME_KIND, &body, MAX_FRAME_BODY).unwrap();
        let mut decoder = WireDecoder::default();
        assert!(matches!(
            decoder.push(&packet),
            Err(WireError::FrameLengthMismatch {
                expected: 16,
                actual: 4,
                ..
            })
        ));
    }
}
