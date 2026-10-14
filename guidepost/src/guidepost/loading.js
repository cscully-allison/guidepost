const MB = 1024 * 1024;

/**
 * Text for the loading box. `progress` is the object passed to
 * `load_vis_data`'s `on_progress`, or null before any totals are known.
 * Returns `{ detail, fraction }`; `fraction` is null when indeterminate.
 */
export function format_progress(progress){
    if(!progress || !(progress.total_chunks > 0)){
        return { detail: 'Waiting for Python…', fraction: null };
    }
    const fraction = Math.min(1, progress.received_bytes / progress.total_bytes);
    return {
        detail: `${progress.received_chunks} / ${progress.total_chunks} chunks `
            + `(${(progress.received_bytes / MB).toFixed(0)} of ${(progress.total_bytes / MB).toFixed(0)} MB)`,
        fraction,
    };
}

/**
 * Shows a loading box inside `host` and returns `{ update, fail, remove }`.
 *
 * Colors are explicit rather than inherited: the widget container is white in
 * every theme, so inheriting a dark theme's near-white foreground made the old
 * plain-text indicator invisible. Plain DOM (no d3) so it works before the svg
 * exists.
 */
export function show_loading(host, message = 'Loading data from Python…'){
    const box = document.createElement('div');
    box.className = 'gp-loading';
    Object.assign(box.style, {
        boxSizing: 'border-box', width: '420px', maxWidth: '100%', margin: '12px',
        padding: '12px 16px', background: '#f5f5f5', color: '#222',
        border: '1px solid #ccc', borderRadius: '4px', fontFamily: 'sans-serif',
        fontSize: '13px',
    });
    const title = document.createElement('div');
    title.textContent = message;
    title.style.fontWeight = 'bold';
    const track = document.createElement('div');
    Object.assign(track.style, {
        height: '6px', margin: '8px 0', background: '#ddd', borderRadius: '3px',
        overflow: 'hidden',
    });
    const bar = document.createElement('div');
    Object.assign(bar.style, { height: '100%', width: '0%', background: '#4a7fb5',
        transition: 'width 0.15s' });
    track.appendChild(bar);
    const detail = document.createElement('div');
    detail.textContent = format_progress(null).detail;
    box.append(title, track, detail);
    host.appendChild(box);

    return {
        update(progress){
            const { detail: text, fraction } = format_progress(progress);
            detail.textContent = text;
            bar.style.width = fraction === null ? '0%' : `${Math.round(fraction * 100)}%`;
        },
        fail(text){
            title.textContent = text;
            title.style.color = '#a04040';
            track.style.display = 'none';
            detail.style.display = 'none';
        },
        remove(){ box.remove(); },
    };
}
