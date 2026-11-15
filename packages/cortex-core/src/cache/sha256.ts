/**
 * SHA-256 over a string, in the package, synchronously, with no platform in it.
 *
 * ## Why this is here rather than `node:crypto`
 *
 * Two of this repository's entry points have to load where `node:crypto` does not: the browser build of
 * `cortex-storage`, and anything that bundles `cortex-core` for a worker. `tools/entry-guard.mjs` enforces
 * that as an import-closure property, so a `node:crypto` import here would move the whole product entry
 * behind a Node built-in.
 *
 * The platform alternative is WebCrypto's `crypto.subtle.digest`, and it is **async**. Its one caller,
 * {@link defaultEmbeddingCacheKey}, is a *key function*: `EmbeddingMemo` calls it inside the loop that
 * decides hit or miss, and a promise there would turn a Map lookup into an await per text -- a cost the
 * memo exists to remove, and an ordering change inside a batch that the module's own contract ("order is
 * the contract") would then have to defend.
 *
 * So the digest is implemented rather than imported. That is a real cost -- a hash is exactly the kind of
 * code that should be borrowed -- and it is paid down by being checkable instead of trusted:
 * `sha256.test.ts` runs the published NIST vectors, and it also runs a **differential** test against
 * `node:crypto` and `TextEncoder` over a corpus of strings chosen to break an encoder (astral planes, a
 * lone surrogate, a NUL, the padding boundaries). If this file ever stops agreeing with the platform, the
 * platform's answer is the one that is right.
 *
 * ## Why a cache key is hashed at all, when `erasure.ts` refuses a digest
 *
 * `erasure.ts` decision 2 says an erasure record must not keep a digest of the erased sentence, because a
 * digest of a secret is an offline guessing oracle. That judgement is about a row that **outlives** the
 * text by design -- it is the deletion log, and the log is what an auditor reads a year later.
 *
 * A cache key has the opposite lifetime: it exists exactly as long as the vector it addresses, and
 * {@link EmbeddingMemo.forget} removes both in one call. Within that lifetime the plaintext key is
 * strictly *worse* than a digest -- it is a full copy of a sentence the store had no other reason to
 * hold, sitting in a table, a file or a page that the disclosure boundary does not know about -- and
 * after the lifetime both are deleted. So the trade is not "copy or oracle": it is "copy now, or oracle
 * while the vector is alive", and the second is the smaller thing to leave behind in a store whose
 * deletion path is a caller-supplied method rather than this repository's code.
 *
 * What this does **not** buy, stated where the next reader will look for it: a key list is still a
 * membership oracle for a guessable sentence. Salting would fix that and would also break the one
 * property that makes a store worth injecting -- that a second process can look up the same text -- so
 * the honest claim is "the cache holds no copy of the text", not "the cache proves nothing about it".
 */

/** The SHA-256 round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = /* @__PURE__ */ Uint32Array.from([
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b, 0x59_f1_11_f1,
  0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01, 0x24_31_85_be, 0x55_0c_7d_c3,
  0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7, 0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86,
  0x0f_c1_9d_c6, 0x24_0c_a1_cc, 0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da,
  0x98_3e_51_52, 0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
  0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc, 0x53_38_0d_13,
  0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85, 0xa2_bf_e8_a1, 0xa8_1a_66_4b,
  0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19, 0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70,
  0x19_a4_c1_16, 0x1e_37_6c_08, 0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a,
  0x5b_9c_ca_4f, 0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
  0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
]);

/** The initial hash state: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = /* @__PURE__ */ Uint32Array.from([
  0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f, 0x9b_05_68_8c,
  0x1f_83_d9_ab, 0x5b_e0_cd_19,
]);

/** The UTF-8 replacement character, as bytes. What a lone surrogate encodes to, as `TextEncoder` does. */
const REPLACEMENT = /* @__PURE__ */ Uint8Array.from([0xef, 0xbf, 0xbd]);

/**
 * UTF-8, written out rather than delegated.
 *
 * `TextEncoder` would be one line and is available everywhere this package runs; it is not used so that
 * this module has **no** platform surface at all, and so that the digest can be unit-tested against the
 * encoder rather than with it. The two agree by test, not by assumption: `sha256.test.ts` compares this
 * function's bytes with `TextEncoder`'s on the strings that distinguish encoders.
 *
 * A lone surrogate encodes to U+FFFD, which is what `TextEncoder` does and what the Unicode standard
 * recommends. Two different lone surrogates therefore hash alike -- a collision of 2 bytes' worth of
 * information, and the alternative (throwing) would make a cache key fail on a string a caller had
 * already accepted everywhere else.
 */
function utf8Bytes(text: string): Uint8Array {
  // Three bytes per UTF-16 unit is the worst case for a BMP character, and a surrogate pair spends four
  // bytes on two units -- so `3 * length` always holds.
  const out = new Uint8Array(text.length * 3);
  let at = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      out[at] = code;
      at += 1;
    } else if (code < 0x800) {
      out[at] = 0xc0 | (code >> 6);
      out[at + 1] = 0x80 | (code & 0x3f);
      at += 2;
    } else if (code >= 0xd8_00 && code <= 0xdb_ff) {
      const following = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (following >= 0xdc_00 && following <= 0xdf_ff) {
        const point = 0x1_00_00 + ((code - 0xd8_00) << 10) + (following - 0xdc_00);
        out[at] = 0xf0 | (point >> 18);
        out[at + 1] = 0x80 | ((point >> 12) & 0x3f);
        out[at + 2] = 0x80 | ((point >> 6) & 0x3f);
        out[at + 3] = 0x80 | (point & 0x3f);
        at += 4;
        index += 1;
      } else {
        out.set(REPLACEMENT, at);
        at += 3;
      }
    } else if (code >= 0xdc_00 && code <= 0xdf_ff) {
      out.set(REPLACEMENT, at);
      at += 3;
    } else {
      out[at] = 0xe0 | (code >> 12);
      out[at + 1] = 0x80 | ((code >> 6) & 0x3f);
      out[at + 2] = 0x80 | (code & 0x3f);
      at += 3;
    }
  }
  return out.subarray(0, at);
}

/** Rotate right, on the 32-bit unsigned words the algorithm is defined over. */
function rotr(word: number, by: number): number {
  return ((word >>> by) | (word << (32 - by))) >>> 0;
}

/** The compression function, over one already-padded message. */
function compress(message: Uint8Array): Uint32Array {
  const state = Uint32Array.from(H0);
  const words = new Uint32Array(64);
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const before = words[index - 15] as number;
      const before2 = words[index - 2] as number;
      const s0 = (rotr(before, 7) ^ rotr(before, 18) ^ (before >>> 3)) >>> 0;
      const s1 = (rotr(before2, 17) ^ rotr(before2, 19) ^ (before2 >>> 10)) >>> 0;
      words[index] = ((words[index - 16] as number) + s0 + (words[index - 7] as number) + s1) >>> 0;
    }

    let a = state[0] as number;
    let b = state[1] as number;
    let c = state[2] as number;
    let d = state[3] as number;
    let e = state[4] as number;
    let f = state[5] as number;
    let g = state[6] as number;
    let h = state[7] as number;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const choice = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + sum1 + choice + (K[index] as number) + (words[index] as number)) >>> 0;
      const sum0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = ((state[0] as number) + a) >>> 0;
    state[1] = ((state[1] as number) + b) >>> 0;
    state[2] = ((state[2] as number) + c) >>> 0;
    state[3] = ((state[3] as number) + d) >>> 0;
    state[4] = ((state[4] as number) + e) >>> 0;
    state[5] = ((state[5] as number) + f) >>> 0;
    state[6] = ((state[6] as number) + g) >>> 0;
    state[7] = ((state[7] as number) + h) >>> 0;
  }
  return state;
}

/**
 * SHA-256 of a string's UTF-8 bytes, lowercase hex.
 *
 * Not a general-purpose API: the only caller in this repository is the embedding cache's key function.
 * It is exported because a test that had to reach into a private function to check NIST vectors would be
 * a test of a copy of this code rather than of this code.
 */
export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  // 0x80, then zeros, then the 64-bit big-endian length: the padded length is the next multiple of 64 at
  // or above `length + 9`.
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_00_00_00_00));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const state = compress(padded);
  let hex = '';
  for (const word of state) hex += word.toString(16).padStart(8, '0');
  return hex;
}
