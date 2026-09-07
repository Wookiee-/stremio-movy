"""Movy.bz decryption, ported 1:1 from addon.js.

JS relies on 32-bit unsigned semantics (>>>0, Math.imul). Every helper
below masks to 32 bits to match.
"""
import base64

MOVY_CRYPTO_ROUNDS = [
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
    0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
    0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
]
MOVY_MAGIC = (109, 118, 109, 49)  # "mvm1"
_MASK = 0xFFFFFFFF


def _u32(x: int) -> int:
    return x & _MASK


def _imul(a: int, b: int) -> int:
    """Emulate JS Math.imul (low 32 bits), returned unsigned."""
    return ((a & _MASK) * (b & _MASK)) & _MASK


def _rotl(e: int, t: int) -> int:
    e = _u32(e)
    t &= 31
    if t == 0:
        return e
    return _u32((e << t) | (e >> (32 - t)))


def _is_lucky(e: int) -> bool:
    return ((e * (e + 1)) & 1) == 0


def _m3(e: int) -> int:
    e = _u32(e)
    e = _u32(e ^ (e >> 16))
    e = _imul(e, 0x85EBCA6B)
    e = _u32(e ^ (e >> 13))
    e = _imul(e, 0xC2B2AE35)
    e = _u32(e ^ (e >> 16))
    return e


def _fnv_like(key: str) -> int:
    t = 0x811C9DC5
    for ch in key:
        t = _imul(t ^ ord(ch), 0x1000193)
    return _m3(t)


class _CipherState:
    __slots__ = ("s", "acc")

    def __init__(self, s, acc: int):
        self.s = s  # list of Optional[int], len 256 or 61
        self.acc = _u32(acc)


def init_cipher_state(key: str, mix: int) -> _CipherState:
    a = len(key)
    if (((a * (a + 1)) & 1) == 1):
        s: list = [None] * 256
        for i in range(256):
            s[i] = i
        j = 0
        for i in range(256):
            j = (j + s[i] + ord(key[i % len(key)])) & 255
            s[i], s[j] = s[j], s[i]
        acc = 0x67452301
        for i in range(len(key)):
            acc = _rotl(_u32(acc ^ _imul(ord(key[i]), MOVY_CRYPTO_ROUNDS[i & 15])), 5)
        acc = _m3(acc)
        return _CipherState(s, acc)
    s = [None] * 61
    r = _m3(_u32(_fnv_like(key) ^ _m3(_u32(mix) ^ 0x9E3779B9)))
    for e in range(8):
        if _is_lucky(e):
            t = r % 61
            r = _rotl(_u32(r + 0x9E3779B9), 7 + (e & 7))
            s[t] = _u32(r ^ _m3(r))
            r = _m3(_u32(r + t))
        else:
            s[e] = MOVY_CRYPTO_ROUNDS[e & 15]
    return _CipherState(s, _m3(_u32(0xA5A5A5A5 ^ r)))


def cipher_step(state: _CipherState, counter: int) -> int:
    s = state.s
    n = _u32(state.acc)
    i = n % 61
    present = s[i] is not None
    o = 0 - int(present)  # JS: 0 - Number(i in S)
    lo = _u32(s[i]) if present else 0
    c = _imul(0x9E3779B9, counter + 1)
    l_xor_c = _u32(lo ^ c)
    combined = _u32((n ^ l_xor_c) | _u32(n & l_xor_c & _u32(o)))
    n = _m3(_u32(_u32(_rotl(_u32(combined + n), i & 31) ^ _rotl(n, _u32(_imul(i, 7)) & 31)) + 0x9E3779B9))
    s[i] = n
    state.acc = n
    return n


def movy_decrypt(encrypted_b64: str, seed: str, media_id: int) -> str:
    b64 = encrypted_b64.replace("-", "+").replace("_", "/")
    b64 += "=" * (-len(b64) % 4)
    raw = bytearray(base64.b64decode(b64))
    state = init_cipher_state(seed, _u32(media_id))
    ks = bytearray(len(raw))
    counter = 0
    e = 0
    while e < len(raw):
        kw = cipher_step(state, counter)
        counter += 1
        ks[e] = kw & 0xFF
        e += 1
        if e < len(raw):
            ks[e] = (kw >> 8) & 0xFF
            e += 1
        if e < len(raw):
            ks[e] = (kw >> 16) & 0xFF
            e += 1
        if e < len(raw):
            ks[e] = (kw >> 24) & 0xFF
            e += 1
    for i in range(len(raw)):
        raw[i] ^= ks[i]
    for i, m in enumerate(MOVY_MAGIC):
        if raw[i] != m:
            raise ValueError("Movy decrypt failed")
    return bytes(raw[len(MOVY_MAGIC):]).decode("utf-8")
