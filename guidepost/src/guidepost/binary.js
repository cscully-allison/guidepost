/**
 * Returns a Uint8Array view over a binary payload, or null if `data` is not
 * binary. Identifies buffers by ArrayBuffer.isView / the object tag rather than
 * `instanceof`: notebook frontends (e.g. VS Code) can deliver buffers created in
 * a different JS realm, for which `instanceof ArrayBuffer/DataView/Uint8Array`
 * is false.
 */
export function as_bytes(data){
    if(data == null || typeof data !== 'object') return null;
    if(ArrayBuffer.isView(data)){
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    const tag = Object.prototype.toString.call(data);
    if(tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]'){
        return new Uint8Array(data);
    }
    return null;
}
