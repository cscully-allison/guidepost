import { as_bytes } from "./binary.js";

/**
 * Parses the `_vis_transfer` trait. Returns the transfer descriptor
 * `{id, size, chunks}` when Python is serving the data in chunks, or null when
 * the data is inline in `_vis_data`.
 */
export function parse_transfer(model){
    try{
        const t = JSON.parse(model.get("_vis_transfer") || "{}");
        return t && t.chunks > 0 ? t : null;
    } catch(e){
        return null;
    }
}

/**
 * Resolves with the Arrow payload bytes for the current dataset.
 *
 * Small datasets arrive inline in `_vis_data`. Large ones are too big for a
 * single comm message in some frontends (VS Code delivers an empty buffer), so
 * Python announces them via `_vis_transfer` and the frontend pulls them: we
 * send `request_vis_data` and reassemble the `vis_data_chunk` replies. Custom
 * messages are not replayed to late-created views, which is why this is a pull.
 *
 * `on_progress({received_bytes, total_bytes, received_chunks, total_chunks})` is
 * called before the request and after each new chunk (never for inline data);
 * errors thrown by it are ignored.
 *
 * Rejects on a Python error reply (e.g. a stale transfer), a malformed chunk, a
 * size mismatch, or `idle_timeout_ms` passing without a chunk arriving.
 */
export function load_vis_data(model, { idle_timeout_ms = 60000, on_progress = null } = {}){
    const transfer = parse_transfer(model);
    if(!transfer) return Promise.resolve(model.get("_vis_data"));

    return new Promise((resolve, reject) => {
        const request_id = `vis_${transfer.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const parts = new Array(transfer.chunks);
        let received = 0;
        let received_bytes = 0;
        let timer = null;

        const report = () => {
            if(!on_progress) return;
            try {
                on_progress({ received_bytes, total_bytes: transfer.size,
                              received_chunks: received, total_chunks: transfer.chunks });
            } catch(e){ /* a broken indicator must not break loading */ }
        };

        const finish = (settle, value) => {
            clearTimeout(timer);
            model.off('msg:custom', on_message);
            settle(value);
        };
        const arm_timer = () => {
            clearTimeout(timer);
            timer = setTimeout(() => finish(reject, new Error(
                `timed out waiting for data from Python (${received}/${transfer.chunks} chunks received)`
            )), idle_timeout_ms);
        };

        function on_message(msg, buffers){
            if(!msg || msg.request_id !== request_id) return;
            if(typeof msg.type === 'string' && msg.type.endsWith('_error')){
                return finish(reject, new Error(msg.error || 'Python error'));
            }
            if(msg.type !== 'vis_data_chunk') return;

            const bytes = buffers && buffers.length ? as_bytes(buffers[0]) : null;
            const index = msg.index;
            if(!bytes || !Number.isInteger(index) || index < 0 || index >= transfer.chunks){
                return finish(reject, new Error('malformed data chunk from Python'));
            }
            if(parts[index] === undefined){
                parts[index] = bytes;
                received++;
                received_bytes += bytes.byteLength;
                report();
            }
            arm_timer();
            if(received < transfer.chunks) return;

            if(received_bytes !== transfer.size){
                return finish(reject, new Error(
                    `data size mismatch: expected ${transfer.size} bytes, received ${received_bytes}`));
            }
            const out = new Uint8Array(transfer.size);
            let offset = 0;
            for(const part of parts){
                out.set(part, offset);
                offset += part.byteLength;
            }
            finish(resolve, out);
        }

        model.on('msg:custom', on_message);
        arm_timer();
        report();
        try{
            model.send({ type: 'request_vis_data', request_id, transfer_id: transfer.id });
        } catch(e){
            finish(reject, e);
        }
    });
}
