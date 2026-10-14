const assert = require('assert');
const vm = require('vm');

let load_vis_data;
let parse_transfer;
let format_progress;

before(async () => {
    ({ load_vis_data, parse_transfer } = await import('../guidepost/src/guidepost/vis_data_loader.js'));
    ({ format_progress } = await import('../guidepost/src/guidepost/loading.js'));
});

/**
 * Minimal anywidget model: a trait store plus on/off/send. `send` hands the
 * request to `responder`, which plays Python's role by emitting `msg:custom`.
 */
function makeModel(traits, responder){
    const handlers = { 'msg:custom': new Set() };
    const model = {
        get: (k) => traits[k],
        on: (ev, fn) => { (handlers[ev] ||= new Set()).add(fn); },
        off: (ev, fn) => { handlers[ev] && handlers[ev].delete(fn); },
        send: (msg) => { sent.push(msg); if(responder) setImmediate(() => responder(msg, emit)); },
        handlers,
    };
    const sent = [];
    const emit = (msg, buffers) => { for(const fn of [...handlers['msg:custom']]) fn(msg, buffers); };
    model.sent = sent;
    return model;
}

function makePayload(n = 1000){
    const out = new Uint8Array(n);
    for(let i = 0; i < n; i++) out[i] = (i * 7) % 251;
    return out;
}

function chunkTraits(payload, chunk){
    return {
        _vis_data: new Uint8Array(0),
        _vis_transfer: JSON.stringify({ id: 4, size: payload.length, chunks: Math.ceil(payload.length / chunk) }),
    };
}

// Foreign-realm DataView over a slice, like the buffers VS Code can deliver.
function foreignView(bytes){
    const Foreign = vm.runInNewContext('DataView');
    const copy = new Uint8Array(bytes).buffer;
    return new Foreign(vm.runInNewContext('(b) => b')(copy));
}

describe('vis_data_loader', () => {
    it('returns the inline _vis_data when no transfer is announced', async () => {
        const inline = makePayload(10);
        const model = makeModel({ _vis_data: inline, _vis_transfer: '{}' });
        assert.strictEqual(parse_transfer(model), null);
        assert.strictEqual(await load_vis_data(model), inline);
        assert.strictEqual(model.sent.length, 0);
    });

    it('requests and reassembles chunks (cross-realm buffers, out of order)', async () => {
        const payload = makePayload(1000);
        const chunk = 300;
        const model = makeModel(chunkTraits(payload, chunk), (req, emit) => {
            assert.strictEqual(req.type, 'request_vis_data');
            assert.strictEqual(req.transfer_id, 4);
            const total = Math.ceil(payload.length / chunk);
            // Unrelated request id must be ignored.
            emit({ type: 'vis_data_chunk', request_id: 'someone_else', index: 0, total },
                 [foreignView(new Uint8Array(5))]);
            for(const index of [2, 0, 3, 1]){
                emit({ type: 'vis_data_chunk', request_id: req.request_id, transfer_id: 4, index, total },
                     [foreignView(payload.slice(index * chunk, (index + 1) * chunk))]);
            }
        });
        const out = await load_vis_data(model);
        assert.deepStrictEqual(Array.from(out), Array.from(payload));
        assert.strictEqual(model.handlers['msg:custom'].size, 0, 'listener detached');
    });

    it('rejects when Python replies with an error (e.g. stale transfer)', async () => {
        const payload = makePayload(100);
        const model = makeModel(chunkTraits(payload, 50), (req, emit) => {
            emit({ type: 'request_vis_data_error', request_id: req.request_id, error: 'RuntimeError: stale' });
        });
        await assert.rejects(load_vis_data(model), /stale/);
        assert.strictEqual(model.handlers['msg:custom'].size, 0);
    });

    it('rejects on a size mismatch', async () => {
        const payload = makePayload(100);
        const model = makeModel(chunkTraits(payload, 50), (req, emit) => {
            for(let index = 0; index < 2; index++){
                emit({ type: 'vis_data_chunk', request_id: req.request_id, index, total: 2 },
                     [new Uint8Array(10)]);
            }
        });
        await assert.rejects(load_vis_data(model), /size mismatch/);
    });

    it('rejects a chunk with no usable buffer', async () => {
        const payload = makePayload(100);
        const model = makeModel(chunkTraits(payload, 50), (req, emit) => {
            emit({ type: 'vis_data_chunk', request_id: req.request_id, index: 0, total: 2 }, []);
        });
        await assert.rejects(load_vis_data(model), /malformed/);
    });

    it('times out when chunks stop arriving', async () => {
        const payload = makePayload(100);
        const model = makeModel(chunkTraits(payload, 50), (req, emit) => {
            emit({ type: 'vis_data_chunk', request_id: req.request_id, index: 0, total: 2 },
                 [payload.slice(0, 50)]);
        });
        await assert.rejects(load_vis_data(model, { idle_timeout_ms: 30 }), /timed out.*1\/2/);
        assert.strictEqual(model.handlers['msg:custom'].size, 0);
    });
    describe('on_progress', () => {
        const emitAll = (payload, chunk) => (req, emit) => {
            const total = Math.ceil(payload.length / chunk);
            for(let index = 0; index < total; index++){
                emit({ type: 'vis_data_chunk', request_id: req.request_id, index, total },
                     [payload.slice(index * chunk, (index + 1) * chunk)]);
            }
        };

        it('reports an initial zero state, then each new chunk, ending complete', async () => {
            const payload = makePayload(1000);
            const calls = [];
            const model = makeModel(chunkTraits(payload, 300), emitAll(payload, 300));
            await load_vis_data(model, { on_progress: (p) => calls.push({ ...p }) });
            assert.deepStrictEqual(calls[0],
                { received_bytes: 0, total_bytes: 1000, received_chunks: 0, total_chunks: 4 });
            assert.deepStrictEqual(calls.map(c => c.received_chunks), [0, 1, 2, 3, 4]);
            assert.deepStrictEqual(calls.at(-1),
                { received_bytes: 1000, total_bytes: 1000, received_chunks: 4, total_chunks: 4 });
        });

        it('is not called for inline data', async () => {
            let called = false;
            const model = makeModel({ _vis_data: makePayload(10), _vis_transfer: '{}' });
            await load_vis_data(model, { on_progress: () => { called = true; } });
            assert.strictEqual(called, false);
        });

        it('a throwing on_progress does not break loading', async () => {
            const payload = makePayload(100);
            const model = makeModel(chunkTraits(payload, 50), emitAll(payload, 50));
            const out = await load_vis_data(model, { on_progress: () => { throw new Error('boom'); } });
            assert.strictEqual(out.length, 100);
        });
    });

    describe('format_progress', () => {
        it('is indeterminate before totals are known', () => {
            assert.deepStrictEqual(format_progress(null), { detail: 'Waiting for Python…', fraction: null });
        });
        it('formats chunk and MB counts with a 0-1 fraction', () => {
            const MB = 1024 * 1024;
            const r = format_progress({ received_bytes: 50 * MB, total_bytes: 200 * MB,
                                        received_chunks: 12, total_chunks: 49 });
            assert.strictEqual(r.detail, '12 / 49 chunks (50 of 200 MB)');
            assert.strictEqual(r.fraction, 0.25);
        });
    });
});
