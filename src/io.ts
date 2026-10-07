import type { World, WorldParams, WorldSnapshot } from './world/world';

const FORMAT = 'worldbuilder';
const VERSION = 1;

function toBase64(arr: ArrayBufferView): string {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): ArrayBuffer {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

export function serializeWorld(world: World): string {
  const s = world.snapshot();
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    params: world.params,
    plates: s.plates,
    plateOf: toBase64(s.plateOf),
    crust: toBase64(s.crust),
    sculpt: toBase64(s.sculpt),
  });
}

export function deserializeWorld(json: string): { params: WorldParams; snapshot: WorldSnapshot } {
  const d = JSON.parse(json);
  if (d.format !== FORMAT) throw new Error('Not a WorldBuilder save file');
  if (d.version > VERSION) throw new Error(`Save file version ${d.version} is newer than this app supports`);
  return {
    params: d.params,
    snapshot: {
      plates: d.plates,
      plateOf: new Uint16Array(fromBase64(d.plateOf)),
      crust: new Uint8Array(fromBase64(d.crust)),
      sculpt: new Float32Array(fromBase64(d.sculpt)),
    },
  };
}

export function download(data: Blob, filename: string): void {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
