#!/usr/bin/env python3
"""Independent ERC-5564 Scheme 1 reference-vector generator.

This script intentionally does not import the TypeScript implementation. It uses
a small textbook secp256k1 implementation plus PyCryptodome's Keccak-256 to
produce deterministic vectors consumed by test/crypto.test.ts.

Fixed private keys in this file are test vectors only and must never be used on
any real network.
"""

from __future__ import annotations

import json
from pathlib import Path

from Crypto.Hash import keccak

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8


def inv(value: int) -> int:
    return pow(value, P - 2, P)


def point_add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    ax, ay = a
    bx, by = b
    if ax == bx and (ay + by) % P == 0:
        return None
    if a == b:
        slope = (3 * ax * ax) * inv(2 * ay % P) % P
    else:
        slope = (by - ay) * inv((bx - ax) % P) % P
    x = (slope * slope - ax - bx) % P
    y = (slope * (ax - x) - ay) % P
    return (x, y)


def point_mul(k: int, point):
    result = None
    addend = point
    while k:
        if k & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        k >>= 1
    return result


G = (GX, GY)


def compress(point) -> bytes:
    x, y = point
    return (b"\x02" if y % 2 == 0 else b"\x03") + x.to_bytes(32, "big")


def uncompress(data: bytes):
    if len(data) != 33 or data[0] not in (2, 3):
        raise ValueError("invalid compressed point")
    x = int.from_bytes(data[1:], "big")
    alpha = (pow(x, 3, P) + 7) % P
    y = pow(alpha, (P + 1) // 4, P)
    if pow(y, 2, P) != alpha:
        raise ValueError("point is not on curve")
    if (y & 1) != (data[0] & 1):
        y = P - y
    return (x, y)


def keccak256(data: bytes) -> bytes:
    digest = keccak.new(digest_bits=256)
    digest.update(data)
    return digest.digest()


def address(point) -> str:
    x, y = point
    raw = x.to_bytes(32, "big") + y.to_bytes(32, "big")
    return "0x" + keccak256(raw)[-20:].hex()


def hex32(value: int) -> str:
    return f"0x{value:064x}"


def bytes_hex(value: bytes) -> str:
    return "0x" + value.hex()


def make_vector(spending_private: int, viewing_private: int, ephemeral_private: int):
    spending_public = point_mul(spending_private, G)
    viewing_public = point_mul(viewing_private, G)
    ephemeral_public = point_mul(ephemeral_private, G)
    shared = point_mul(ephemeral_private, viewing_public)
    shared_compressed = compress(shared)
    shared_hash = keccak256(shared_compressed)
    hashed_scalar = int.from_bytes(shared_hash, "big") % N
    delta_point = point_mul(hashed_scalar, G)
    stealth_public = point_add(spending_public, delta_point)
    stealth_private = (spending_private + hashed_scalar) % N
    recovered_public = point_mul(stealth_private, G)

    if recovered_public != stealth_public:
        raise AssertionError("recovered public key does not match stealth public key")

    return {
        "inputs": {
            "spendingPrivateKey": hex32(spending_private),
            "viewingPrivateKey": hex32(viewing_private),
            "ephemeralPrivateKey": hex32(ephemeral_private),
        },
        "expected": {
            "spendingPublicKey": bytes_hex(compress(spending_public)),
            "viewingPublicKey": bytes_hex(compress(viewing_public)),
            "metaAddress": "st:eth:0x"
            + bytes_hex(compress(spending_public))[2:]
            + bytes_hex(compress(viewing_public))[2:],
            "ephemeralPublicKey": bytes_hex(compress(ephemeral_public)),
            "sharedSecretCompressed": bytes_hex(shared_compressed),
            "hashedSharedSecret": bytes_hex(shared_hash),
            "hashedScalarModN": hex32(hashed_scalar),
            "stealthPublicKey": bytes_hex(compress(stealth_public)),
            "stealthAddress": address(stealth_public),
            "stealthPrivateKey": hex32(stealth_private),
            "viewTag": bytes_hex(shared_hash[:1]),
            "sumExceedsN": spending_private + hashed_scalar > N,
        },
    }


def main() -> None:
    vectors = {
        "schemeId": 1,
        "description": "Independent secp256k1 + Keccak-256 ERC-5564 Scheme 1 vectors",
        "vectors": [
            make_vector(
                0x1111111111111111111111111111111111111111111111111111111111111111,
                0x2222222222222222222222222222222222222222222222222222222222222222,
                0x3333333333333333333333333333333333333333333333333333333333333333,
            ),
            make_vector(
                N - 2,
                0x4444444444444444444444444444444444444444444444444444444444444444,
                0x5555555555555555555555555555555555555555555555555555555555555555,
            ),
        ],
    }
    output = Path(__file__).with_name("reference-vectors.json")
    output.write_text(json.dumps(vectors, indent=2) + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
