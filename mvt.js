/* Cycle Hub — mvt.js
 * A minimal Mapbox Vector Tile (protobuf) decoder: just enough to pull line
 * features and their properties out of the layers we ask for. No dependencies.
 */
(() => {
  'use strict';
  const CH = window.CH;

  class Reader {
    constructor(u8, pos = 0, end = u8.length) { this.u8 = u8; this.pos = pos; this.end = end; }
    varint() {
      const u8 = this.u8;
      let b = u8[this.pos++], val = b & 0x7f;
      if (b < 0x80) return val;
      b = u8[this.pos++]; val |= (b & 0x7f) << 7; if (b < 0x80) return val;
      b = u8[this.pos++]; val |= (b & 0x7f) << 14; if (b < 0x80) return val;
      b = u8[this.pos++]; val |= (b & 0x7f) << 21; if (b < 0x80) return val;
      b = u8[this.pos++]; val = (val | (b & 0x0f) << 28) >>> 0; if (b < 0x80) return val;
      // beyond 32 bits: keep going with float maths (ids only; precision loss is fine)
      let mul = 4294967296 * 8; // 2^35 after the 4 low bits of byte 5
      val += (b & 0x70) / 16 * 4294967296;
      for (let i = 0; i < 5; i++) {
        b = u8[this.pos++]; val += (b & 0x7f) * mul; mul *= 128; if (b < 0x80) return val;
      }
      return val;
    }
    svarint() { const n = this.varint(); return n % 2 === 1 ? -(n + 1) / 2 : n / 2; }
    skip(wire) {
      if (wire === 0) this.varint();
      else if (wire === 2) this.pos += this.varint();
      else if (wire === 5) this.pos += 4;
      else if (wire === 1) this.pos += 8;
      else throw new Error('bad wire ' + wire);
    }
    string(len) {
      const s = this.u8.subarray(this.pos, this.pos + len); this.pos += len;
      return Reader.td.decode(s);
    }
  }
  Reader.td = new TextDecoder('utf-8');

  function readValue(r, end) {
    let v = null;
    while (r.pos < end) {
      const tag = r.varint(), f = tag >> 3, w = tag & 7;
      if (f === 1) v = r.string(r.varint());
      else if (f === 2) { v = new DataView(r.u8.buffer, r.u8.byteOffset + r.pos, 4).getFloat32(0, true); r.pos += 4; }
      else if (f === 3) { v = new DataView(r.u8.buffer, r.u8.byteOffset + r.pos, 8).getFloat64(0, true); r.pos += 8; }
      else if (f === 4 || f === 5) v = r.varint();
      else if (f === 6) v = r.svarint();
      else if (f === 7) v = r.varint() !== 0;
      else r.skip(w);
    }
    return v;
  }

  // Returns [{ type, props, lines: [Int32-ish arrays of x,y,...] }] for one layer.
  function readFeatures(r, spans, keys, values) {
    const out = [];
    for (const [start, end] of spans) {
      r.pos = start;
      let type = 0, tags = null, geom = null;
      while (r.pos < end) {
        const tag = r.varint(), f = tag >> 3, w = tag & 7;
        if (f === 3) type = r.varint();
        else if (f === 2) {
          if (w === 2) { const len = r.varint(), e = r.pos + len; tags = []; while (r.pos < e) tags.push(r.varint()); }
          else { (tags = tags || []).push(r.varint()); }
        } else if (f === 4) {
          if (w === 2) { const len = r.varint(), e = r.pos + len; geom = []; while (r.pos < e) geom.push(r.varint()); }
          else { (geom = geom || []).push(r.varint()); }
        } else r.skip(w);
      }
      if (type !== 2 || !geom) continue;        // lines only
      const props = {};
      if (tags) for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      const lines = [];
      let line = null, x = 0, y = 0;
      for (let i = 0; i < geom.length;) {
        const cmd = geom[i++], id = cmd & 7, count = cmd >> 3;
        if (id === 1) {          // MoveTo
          for (let k = 0; k < count; k++) {
            x += zz(geom[i++]); y += zz(geom[i++]);
            line = [x, y]; lines.push(line);
          }
        } else if (id === 2) {   // LineTo
          for (let k = 0; k < count; k++) {
            x += zz(geom[i++]); y += zz(geom[i++]);
            if (line) line.push(x, y);
          }
        } else if (id === 7) { /* ClosePath: not for lines */ }
        else break;
      }
      out.push({ type, props, lines: lines.filter((l) => l.length >= 4) });
    }
    return out;
  }
  const zz = (n) => (n & 1) ? -((n + 1) >>> 1) : (n >>> 1);

  function readLayer(r, end, want) {
    let name = '', extent = 4096;
    const keys = [], values = [], spans = [];
    while (r.pos < end) {
      const tag = r.varint(), f = tag >> 3, w = tag & 7;
      if (f === 1) name = r.string(r.varint());
      else if (f === 2) { const len = r.varint(); spans.push([r.pos, r.pos + len]); r.pos += len; }
      else if (f === 3) keys.push(r.string(r.varint()));
      else if (f === 4) { const len = r.varint(), e = r.pos + len; values.push(readValue(r, e)); r.pos = e; }
      else if (f === 5) extent = r.varint();
      else r.skip(w);
    }
    if (want && !want.has(name)) return null;
    return { name, extent, features: readFeatures(r, spans, keys, values) };
  }

  // decode(arrayBuffer, Set of layer names) → { layerName: { extent, features } }
  function decode(buf, want) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const r = new Reader(u8);
    const layers = {};
    while (r.pos < r.end) {
      const tag = r.varint(), f = tag >> 3, w = tag & 7;
      if (f === 3 && w === 2) {
        const len = r.varint(), e = r.pos + len;
        const layer = readLayer(r, e, want);
        if (layer) layers[layer.name] = layer;
        r.pos = e;
      } else r.skip(w);
    }
    return layers;
  }

  CH.MVT = { decode };
})();
