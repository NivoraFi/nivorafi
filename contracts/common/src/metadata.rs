use crate::interfaces::StandardizedYieldClient;
use soroban_sdk::{token, Address, Env, String};

fn append_bytes(dst: &mut [u8; 64], pos: &mut usize, src: &[u8]) {
    let avail = dst.len().saturating_sub(*pos);
    let n = src.len().min(avail);
    if n > 0 {
        dst[*pos..*pos + n].copy_from_slice(&src[..n]);
        *pos += n;
    }
}

pub fn join3(env: &Env, p1: &[u8], p2: &[u8], p3: &[u8]) -> String {
    let mut buf = [0u8; 64];
    let mut pos = 0usize;
    append_bytes(&mut buf, &mut pos, p1);
    append_bytes(&mut buf, &mut pos, p2);
    append_bytes(&mut buf, &mut pos, p3);
    String::from_bytes(env, &buf[..pos])
}

pub fn join4(env: &Env, p1: &[u8], p2: &[u8], p3: &[u8], p4: &[u8]) -> String {
    let mut buf = [0u8; 64];
    let mut pos = 0usize;
    append_bytes(&mut buf, &mut pos, p1);
    append_bytes(&mut buf, &mut pos, p2);
    append_bytes(&mut buf, &mut pos, p3);
    append_bytes(&mut buf, &mut pos, p4);
    String::from_bytes(env, &buf[..pos])
}

pub fn format_days_suffix(now: u64, maturity: u64, buf: &mut [u8; 16]) -> usize {
    let diff = maturity.saturating_sub(now);
    let mut days = if diff == 0 {
        0u64
    } else {
        (diff / 86_400).max(1)
    };
    let mut tmp = [0u8; 20];
    let mut idx = tmp.len();
    if days == 0 {
        idx -= 1;
        tmp[idx] = b'0';
    } else {
        while days > 0 {
            idx -= 1;
            tmp[idx] = b'0' + (days % 10) as u8;
            days /= 10;
        }
    }
    let digits = &tmp[idx..];
    let n = digits.len().min(buf.len().saturating_sub(1));
    buf[..n].copy_from_slice(&digits[..n]);
    buf[n] = b'D';
    n + 1
}

pub fn resolve_token_metadata(env: &Env, asset: &Address) -> (u32, [u8; 16], usize) {
    let tc = token::Client::new(env, asset);
    let decimals = tc
        .try_decimals()
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(7u32);
    let mut buf = [0u8; 16];
    let mut len = 0usize;

    if let Some(sym) = tc.try_symbol().ok().and_then(|r| r.ok()) {
        let bytes = sym.to_bytes();
        let total = bytes.len() as usize;
        let mut n = total.min(buf.len());
        if n > 0 {
            bytes.slice(0..n as u32).copy_into_slice(&mut buf[..n]);
            if total > n {
                if let Some(next_byte) = bytes.get(n as u32) {
                    if (next_byte & 0xC0) == 0x80 {
                        while n > 0 && (buf[n - 1] & 0xC0) == 0x80 {
                            n -= 1;
                        }
                        n = n.saturating_sub(1);
                    }
                }
            }
            len = n;
        }
    }

    if len == 6 && &buf[..6] == b"native" {
        buf[..3].copy_from_slice(b"XLM");
        len = 3;
    } else if len == 0 {
        buf[..5].copy_from_slice(b"ASSET");
        len = 5;
    }

    (decimals, buf, len)
}

pub fn resolve_sy_metadata(env: &Env, sy: &Address) -> (u32, [u8; 16], usize) {
    let sc = StandardizedYieldClient::new(env, sy);
    let decimals = sc
        .try_decimals()
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(7u32);

    if let Some(asset) = sc.try_asset().ok().and_then(|r| r.ok()) {
        let (_asset_dec, sym_buf, sym_len) = resolve_token_metadata(env, &asset);
        return (decimals, sym_buf, sym_len);
    }

    let mut buf = [0u8; 16];
    buf[..2].copy_from_slice(b"SY");
    (decimals, buf, 2)
}
