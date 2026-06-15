import * as d3 from "d3";
import { tableFromIPC, Type } from "apache-arrow";
import { num_rows, num_cols, VALID_CONFIG_FIELDS, MAX_FACETS, MAX_CATEGORICAL_COLUMNS, RENDER_NODE_BUDGET, CHUNK_TARGET_COLS } from "./consts.js";

const MISSING_LABEL = "(missing)";

class JSModel{
    constructor(data, vars, feature_summary_stats, anywidget_model){
        // `data` can be either an Arrow IPC payload (the production path —
        // sent over the `_vis_data` Bytes traitlet) or a dict-of-dicts (the
        // legacy fixture shape used by tests). Detect and route accordingly.
        this.list_major_data = this._to_records(data);
        // The validator previously string-coerced numeric columns assigned to
        // `categorical`; now that the validator runs on summary_stats (not raw
        // rows) the coercion must live on the data side.
        this._coerce_categorical_to_string(this.list_major_data, vars['categorical']);
        this.data = this.facet(this.list_major_data, vars['facet_by']);
        this._compute_facets();
        this.vars = vars;
        // Snapshot of the vars currently reflected in faceted_bins / scales /
        // categorical_bins. apply_config diffs against this rather than
        // this.vars because ConfigurationInterface mutates this.vars in place
        // BEFORE firing change:_vis_configs — diffing against this.vars at
        // that point always reports zero changes.
        this._applied_vars = Object.assign({}, vars);
        this.anywidget_model = anywidget_model;
        // sort feature_summary_stats by key (alphabetical) so insertion order is predictable
        feature_summary_stats = Object.fromEntries(
            Object.entries(feature_summary_stats).sort((a, b) => a[0].localeCompare(b[0]))
        );
        this.feature_summary_stats = feature_summary_stats;
        // View registry (token -> View instance). Persists across reloads;
        // create_views overwrites entries by token on rebuild.
        this.views = {};
        this.log_values_floor = 1;
        // Heatmap interaction mode: 'column-pin' | 'cell-pin' | '2d-brush'.
        // Global (one mode across facets); works for every x-axis type. Unlike
        // the per-facet derived state, it is intentionally preserved on reload.
        this.interaction_mode = 'column-pin';
        this.valid_config_fields = VALID_CONFIG_FIELDS;

        this.x_axis_time_window_ticks = d3.utcWeek.every(1);
        this.x_axis_time_window = d3.utcDay.every(1);

        // Comm-channel plumbing. JS sends `{type, request_id, ...}` to Python
        // via anywidget_model.send and resolves promises keyed by request_id
        // when the Python side replies. If the model lacks `send`/`on` (test
        // fixtures), filter/brush automatically fall back to the JS-side
        // pipeline so behavior is preserved.
        this._pending_requests = new Map();
        this._next_request_id = 0;
        if(anywidget_model && typeof anywidget_model.on === 'function'){
            anywidget_model.on('msg:custom', (msg) => this._handle_python_message(msg));
        }

        // All per-facet derived data + memo caches. Shared with update_data and
        // apply_config so every (re)build starts from identical clean state.
        this._reset_derived_state();

        this.sanitize_and_intialize_data(this.data);
    }

    /**
     * (Re)initializes every per-facet derived map and memo cache to empty, then
     * re-seeds the per-facet selection/brush entries for the current facets.
     * Single source of truth shared by the constructor, update_data (full data
     * reload) and apply_config's facet_by rebuild, so a reload yields the same
     * clean state as a fresh construction — no stale entry (grouping model,
     * cell cache, filter, selection) survives when a facet name recurs in a new
     * dataset. Must run AFTER _compute_facets() so this.facets is current.
     * Excludes state that intentionally persists across reloads (interaction
     * mode, config vars, comm plumbing, the views registry).
     */
    _reset_derived_state(){
        // Faceted derived data — rebuilt by sanitize_and_intialize_data.
        this.faceted_sum_stats = {};
        this.faceted_bins = {};
        // Original (unfiltered) row arrays per x-bin per facet — row references
        // only (no deep copies). Pristine source for filter/category recomputes.
        this._original_column_values = {};
        this.scale_types = {};
        this.x_axis_thresholds = {};
        this.y_axis_thresholds = {};
        this.row_major_counts = {};
        this.total_row_major_counts = {};
        this.categorical_bins = {};
        this.total_categorical_bins = {};
        // Assigned ONLY on the categorical/list-x build path — cleared here so a
        // prior list-x grouping can't leak into a new continuous-x dataset of a
        // recurring facet (which would misroute current_columns to the grouped
        // detail path). col_order matches faceted_bins[fac].column order;
        // categorical_overflow drives the "showing top N of M" note;
        // faceted_has_sharing flags co-occurrence; faceted_groups/node_buckets
        // hold the list-x grouping model + leaf node rows.
        this.col_order = {};
        this.categorical_overflow = {};
        this.faceted_has_sharing = {};
        this.faceted_groups = {};
        this.faceted_node_buckets = {};
        // Per-facet detail-view node-index window [lo,hi]; null => whole fleet.
        this.detail_range = {};
        // Per-facet memo caches (keyed by facet name, and by level:lo:hi for
        // cells/ranges). Stale entries would return wrong nodes on a swap.
        this._co_occurrence_cache = {};
        this._cell_cache = {};
        this._overview_agg_cache = {};
        this._co_occurrence_fleet_cache = {};
        this._co_fleet_range_cache = {};
        this._node_name_idx_cache = {};
        // Per-facet monotonic filter-request generation (stale-reply guard).
        this._filter_seq = {};
        // Selection is the per-facet UNION of three independent streams:
        //   box   — the 2-d brush + the x/y histograms (one coordinated box)
        //   pin   — column-pin / cell-pin
        //   color — the color-legend brush
        // brushed_data[facet] is the deduped union (legend count + export read).
        this.brushed_ranges = {};
        this.brushed_data = {};
        this.sel = { box: {}, pin: {}, color: {} };
        this.faceted_states = {};
        this.color_scale_range = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
        for(const facet of this.facets){
            this.brushed_ranges[facet] = {
                x_range: [],
                y_range: [],
                col_range: [],     // band-x column restriction for the box (node/col index range)
                color_range: []
            };
            this.brushed_data[facet] = [];
            this.sel.box[facet] = new Int32Array(0);
            this.sel.pin[facet] = new Int32Array(0);
            this.sel.color[facet] = new Int32Array(0);
            this.faceted_states[facet] = { filter: [], pinned_category: {} };
        }
    }

    /**
     * True if the attached anywidget model can round-trip messages to Python.
     */
    _has_comm(){
        return !!(this.anywidget_model
            && typeof this.anywidget_model.send === 'function'
            && typeof this.anywidget_model.on === 'function');
    }

    /**
     * True when the current x variable is a categorical column (scalar OR
     * list). Drives the scaleBand render path, rotated labels and count strip.
     */
    x_is_categorical(){
        const s = this.feature_summary_stats && this.feature_summary_stats[this.vars.x];
        return !!(s && s.semantic_type === 'categorical');
    }

    /**
     * True when the current x variable is a list-valued column (one row → many
     * values). Additionally triggers the explode + per-y-bin dedup behavior.
     */
    x_is_list(){
        const s = this.feature_summary_stats && this.feature_summary_stats[this.vars.x];
        return !!(s && s.is_list);
    }

    /**
     * Sends a `{type, request_id, ...payload}` message to Python and returns
     * a Promise that resolves with the reply (or rejects with the error
     * payload). Errors include the comm channel being unavailable or the
     * reply not arriving within `timeout_ms` — a missing reply otherwise
     * silently hangs filter/brush forever.
     */
    _send_request(type, payload, timeout_ms = 5000){
        return new Promise((resolve, reject) => {
            if(!this._has_comm()){
                reject(new Error('comm channel unavailable'));
                return;
            }
            const request_id = `req_${++this._next_request_id}_${Date.now()}`;
            const timer = setTimeout(() => {
                if(this._pending_requests.has(request_id)){
                    this._pending_requests.delete(request_id);
                    reject(new Error(`Python reply for ${type} timed out after ${timeout_ms}ms`));
                }
            }, timeout_ms);
            this._pending_requests.set(request_id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject:  (e) => { clearTimeout(timer); reject(e); },
            });
            try {
                this.anywidget_model.send({ type, request_id, ...payload });
            } catch(e){
                clearTimeout(timer);
                this._pending_requests.delete(request_id);
                reject(e);
            }
        });
    }

    /**
     * Dispatches incoming Python messages by request_id. Messages whose type
     * ends in `_error` reject; everything else resolves.
     */
    _handle_python_message(msg){
        if(!msg || typeof msg !== 'object') return;
        const request_id = msg.request_id;
        if(!request_id) return;
        const pending = this._pending_requests.get(request_id);
        if(!pending) return;
        this._pending_requests.delete(request_id);
        if(typeof msg.type === 'string' && msg.type.endsWith('_error')){
            pending.reject(new Error(msg.error || 'Python error'));
        } else {
            pending.resolve(msg);
        }
    }

    /**
     * Serializes per-facet threshold dicts so JSON can carry them to Python.
     * Date thresholds become ISO strings; numerics pass through. Both sides
     * agree on the same wire shape — see AggregationEngine._sql_literal.
     */
    _serialize_thresholds(thresholds_by_facet){
        const out = {};
        for(const fac of Object.keys(thresholds_by_facet || {})){
            const arr = thresholds_by_facet[fac] || [];
            out[fac] = arr.map(v => {
                if(v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');
                return v;
            });
        }
        return out;
    }

    /**
     * Overlays Python's aggregation result onto an existing facet's bin
     * structure. Preserves the per-bin `threshold` and `indices` that JS
     * already computed at init — Python only ships stats. After Python's
     * grid lands, brush selection should be routed through Python too so
     * staleness in JS indices never affects user-visible selection.
     */
    _apply_python_grid(grid){
        // Returns true if the grid landed onto at least one facet, false if
        // it was empty or shaped wrong. Callers use the bool to decide
        // whether to fall back to the JS-side recompute.
        if(!grid || typeof grid !== 'object' || Object.keys(grid).length === 0) return false;
        let applied = false;
        for(const fac of Object.keys(grid)){
            const columns = grid[fac] && grid[fac].columns;
            if(!Array.isArray(columns)) continue;
            const target = this.faceted_bins[fac] && this.faceted_bins[fac].column;
            if(!Array.isArray(target)) continue;
            const min_len = Math.min(columns.length, target.length);
            for(let i = 0; i < min_len; i++){
                const src_col = columns[i];
                const dst_col = target[i];
                if(!src_col || !dst_col) continue;
                // Stats fields — preserve threshold + indices on dst_col.
                for(const k of Object.keys(src_col)){
                    if(k === 'bins') continue;
                    dst_col[k] = src_col[k];
                }
                if(Array.isArray(src_col.bins) && Array.isArray(dst_col.bins)){
                    const bin_len = Math.min(src_col.bins.length, dst_col.bins.length);
                    for(let j = 0; j < bin_len; j++){
                        const src_cell = src_col.bins[j];
                        const dst_cell = dst_col.bins[j];
                        if(!src_cell || !dst_cell) continue;
                        for(const k of Object.keys(src_cell)){
                            dst_cell[k] = src_cell[k];
                        }
                    }
                }
                // Track the global color-scale range from Python-supplied
                // aggregates so the heatmap legend stays correct.
                if(Array.isArray(src_col.bins)){
                    const agg_key = this.vars.color_agg;
                    for(const cell of src_col.bins){
                        const v = cell && cell[agg_key];
                        if(v != null && !Number.isNaN(v)){
                            this.color_scale_range[0] = Math.min(this.color_scale_range[0], v);
                            this.color_scale_range[1] = Math.max(this.color_scale_range[1], v);
                        }
                    }
                }
                applied = true;
            }
        }
        return applied;
    }

    set_config_options(config_name, options){
        for(let config in this.valid_config_fields){
            if(config_name == this.valid_config_fields[config]['name']){
                this.valid_config_fields[config]['options'] = options;
                break;
            }
        }

        // this.render_all();
    }

    /**
     * Adds a specified number of days to a date. (Copied from stackoverflow)
     * @param {Date} date - The original date.
     * @param {number} days - The number of days to add.
     * @returns {Date} - The new date with the added days.
     */
    addDays(date, days){
        const newDate = new Date(date);
        newDate.setDate(date.getDate()+days);
        return newDate;
    }

    /**
     * Routes `data` into the right decoder. Production passes an Arrow IPC
     * payload (the `_vis_data` Bytes trait); fixtures pass a plain dict.
     * Empty/missing data yields an empty record list so the constructor can
     * still run during early initialization races.
     */
    _to_records(data){
        if(data == null) return [];
        if(this._is_arrow_payload(data)) return this._records_from_arrow(data);
        if(typeof data === 'object' && !Array.isArray(data)){
            // Empty default dict before load_data has set anything.
            const keys = Object.keys(data);
            if(keys.length === 0) return [];
            return this.list_major(data);
        }
        return [];
    }

    /**
     * True if `data` is bytes/DataView/typed-array shape (the anywidget Bytes
     * trait surface) rather than the legacy dict-of-dicts.
     */
    _is_arrow_payload(data){
        return data instanceof DataView
            || data instanceof ArrayBuffer
            || (typeof Uint8Array !== 'undefined' && data instanceof Uint8Array)
            || (typeof data === 'string' && data.length > 0 && this._looks_base64(data));
    }

    _looks_base64(s){
        // Cheap heuristic: anywidget occasionally surfaces Bytes traits as
        // base64 strings depending on transport. Avoid false positives on the
        // empty default by also requiring length.
        return s.length > 4 && /^[A-Za-z0-9+/=\n\r]+$/.test(s.slice(0, 32));
    }

    /**
     * Decodes Arrow IPC bytes into list-major records that match the prior
     * `list_major()` output shape — one plain object per row, keyed by
     * column name, with an `index` field downstream consumers (D3 key fns)
     * already rely on.
     *
     * Materializes to plain JS objects rather than Arrow row proxies because
     * downstream code (`_coerce_facet_types`, `sanitize_data_for_log`) mutates
     * row cells in place, which row proxies don't permit.
     */
    _records_from_arrow(bytes){
        // Normalize to a Uint8Array so apache-arrow's `tableFromIPC` accepts it
        // regardless of how anywidget surfaced the Bytes trait.
        let buf;
        if(bytes instanceof Uint8Array) buf = bytes;
        else if(bytes instanceof ArrayBuffer) buf = new Uint8Array(bytes);
        else if(bytes instanceof DataView) buf = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        else if(typeof bytes === 'string'){
            const bin = atob(bytes);
            buf = new Uint8Array(bin.length);
            for(let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        } else {
            return [];
        }
        if(buf.byteLength === 0) return [];

        const table = tableFromIPC(buf);
        const fields = table.schema.fields;
        // Pre-resolve each column vector once so the hot loop is a single
        // typed-array (or generic-array) index lookup per cell instead of a
        // per-row schema walk.
        const vectors = fields.map(f => table.getChild(f.name));
        const names = fields.map(f => f.name);
        // Per-column converters normalize Arrow's `Vector.get` output:
        //   - Int64 columns surface as BigInt; downstream code stores
        //     gp_idx into Int32Arrays and does arithmetic with mixed numeric
        //     columns, so coerce to Number. Safe up to 2^53 — gp_idx tops
        //     out at row count, well below that.
        //   - Timestamp columns surface as Date or BigInt depending on unit
        //     and apache-arrow version; coerce to Date so _build_axis and
        //     convert_to_date hit their datetime branches.
        const converters = fields.map(f => this._arrow_converter(f));
        const n = table.numRows;
        const records = new Array(n);
        for(let i = 0; i < n; i++){
            const r = {};
            for(let c = 0; c < names.length; c++){
                r[names[c]] = converters[c](vectors[c].get(i));
            }
            r.index = i;
            records[i] = r;
        }
        return records;
    }

    /**
     * Returns a per-column normalizer that turns Arrow's native get() output
     * into JS values the rest of the JSModel pipeline already handles.
     */
    _arrow_converter(field){
        if(field.type.typeId === Type.Timestamp){
            const unit = field.type.unit;
            return (v) => {
                if(v == null) return null;
                if(v instanceof Date) return v;
                if(typeof v === 'number') return new Date(v);
                if(typeof v === 'bigint'){
                    // Divide while still BigInt to preserve precision for
                    // nanosecond/microsecond units before falling to Number.
                    if(unit === 3) return new Date(Number(v / 1_000_000n));
                    if(unit === 2) return new Date(Number(v / 1_000n));
                    if(unit === 1) return new Date(Number(v));
                    if(unit === 0) return new Date(Number(v) * 1000);
                    return new Date(Number(v));
                }
                return v;
            };
        }
        if(field.type.typeId === Type.List || field.type.typeId === Type.LargeList){
            // List columns surface as an Arrow sub-Vector per cell; materialize
            // to a plain JS array so the categorical-x build can iterate it.
            return (v) => {
                if(v == null) return null;
                if(Array.isArray(v)) return v;
                return Array.from(v);
            };
        }
        return (v) => (typeof v === 'bigint' ? Number(v) : v);
    }

    /**
     * Coerces a column's values to strings in place so the categorical bar
     * chart and category-filter paths can rely on string semantics even when
     * the user picks a numeric column. The pre-Phase-2 path did this inside
     * the Validator's variable-semantics check; moved here because the
     * validator no longer sees raw row data.
     */
    _coerce_categorical_to_string(records, cat_col){
        if(!cat_col || !records || records.length === 0) return;
        // Sample the first non-null value to decide if coercion is needed.
        let sample;
        for(const r of records){
            if(r[cat_col] != null){ sample = r[cat_col]; break; }
        }
        if(typeof sample === 'string' || sample === undefined) return;
        for(const r of records){
            const v = r[cat_col];
            if(v != null) r[cat_col] = String(v);
        }
    }

    /**
     * Converts a dictionary to a list-major format. Retained for test
     * fixtures (which still pass dict-of-dicts) and for any code that calls
     * it directly; the production path uses `_records_from_arrow`.
     * @param {Object} dict - The dictionary to convert.
     * @returns {Array} - The list-major formatted data.
     */
    list_major(dict){
        var list = [];

        let record_indexes = Object.keys(dict[Object.keys(dict)[0]])
        let records = record_indexes.length;
        for(let i of record_indexes){
            let list_major_record = {};
            for(let key of Object.keys(dict)){
                list_major_record[key] = dict[key][i];
            }
            list_major_record["index"] = i;
            list.push(list_major_record);
        }
        return list
    }

    /**
     * Facets the data based on a specified column.
     * @param {Array} data - The data to facet.
     * @param {string} col - The column to use for faceting.
     * @returns {Object} - The faceted data.
     */
    facet(data, col){
        // facets the data based on passed column
        var facets = Object.groupBy(data, function(e){return e[col]})
        return facets
    }

    // Orders facet keys by descending group size and caps the visible set at
    // MAX_FACETS. Records the full count + elided count so the view layer can
    // report how many groups were hidden. Sorting largest-first means the
    // capped set keeps the most-populated (most informative) groups. Assumes
    // this.data has already been (re)faceted by the caller.
    _compute_facets(){
        const all = Object.keys(this.data).sort(
            (a, b) => this.data[b].length - this.data[a].length
        );
        this.total_facet_count = all.length;
        this.facets = all.slice(0, MAX_FACETS);
        this.elided_facet_count = this.total_facet_count - this.facets.length;
    }

    /**
     * Converts a specified column in the data to date format.
     * @param {Array} data - The data to convert.
     * @param {string} col - The column to convert to date format.
     * @returns {Array} - The data with the column converted to date format.
     */
    convert_to_date(data, col){
        for(let r in data){
            if(data[r][col] == null) continue;
            data[r][col] = new Date(data[r][col]);
        }

        return data;
    }
    
    /**
     * Sanitizes data for log scale by replacing zero values with one.
     * @param {Array} data - The data to sanitize.
     * @param {string} col - The column to sanitize.
     * @returns {Array} - The sanitized data.
     */
    sanitize_data_for_log(data, col){
        data.forEach((element, i, arr) => {
            //setting to 1 in this context is ok at
            // the resolution of analysis we are doing
            // diff 1 sec vs. 0 sec is functionally
            // the same
            if (element[col] == 0){
                arr[i][col] = 1;
            }
        });
    
        return data; 
    }

    /**
     * Sets the x-axis variable for the model.
     * @param {string} x - The x variable to set.
     */
    set_x_var(x){
        this.vars.x = x;
    }

    /**
     * Sets the y-axis variable for the model.
     * @param {string} y - The y variable to set.
     */
    set_y_var(y){
        this.vars.y = y;
    }

    /**
     * Sets the color variable for the model.
     * @param {string} color - The color variable to set.
     */
    set_color_by_var(color){
        this.vars.color = color;
    }

    /**
     * Gets summary statistics for a specified column in the data.
     * @param {Array} data - The data to analyze.
     * @param {string} col - The column to get summary statistics for.
     * @returns {Object} - The summary statistics for the column.
     */
    get_summary_stats(data, col, index){
        let sum_stats;
        if(data.length === 0){
            sum_stats = this._empty_summary_stats();
        } else {
            // Find first non-null sample to detect type; nulls are skipped per-axis downstream.
            let sample;
            for(const row of data){
                if(row[col] != null){ sample = row[col]; break; }
            }
            if(sample === undefined){
                sum_stats = this._empty_summary_stats();
            } else if(typeof sample === 'string'){
                sum_stats = this._categorical_summary_stats(data, col);
            } else {
                sum_stats = this._numeric_summary_stats(data, col);
            }
        }
        sum_stats.index = index;
        return sum_stats;
    }

    /**
     * Returns a summary-stats object with every numeric field zeroed. Used for
     * empty input so downstream code never sees `undefined` from min/max/etc.
     */
    _empty_summary_stats(){
        const stats = {
            min: 0, max: 0,
            sum: 0,
            avg: 0, average: 0, mean: 0,
            variance: 0, var: 0, std: 0,
            q1: 0, q2: 0, q3: 0,
            median: 0, med: 0,
            count: 0
        };
        return stats;
    }

    /**
     * Stats for categorical (string) columns: min/max are the lexicographic
     * extremes; numeric aggregates are zeroed (kept on the object so the shape
     * matches the numeric branch).
     */
    _categorical_summary_stats(data, col){
        const stats = this._empty_summary_stats();
        const filtered = data.filter(d => d[col] != null);
        if(filtered.length === 0){
            return stats;
        }
        stats.min = filtered.reduce((prev, curr) => prev[col] < curr[col] ? prev : curr)[col];
        stats.max = filtered.reduce((prev, curr) => prev[col] > curr[col] ? prev : curr)[col];
        stats.count = filtered.length;
        return stats;
    }

    /**
     * Stats for numeric columns: min, max, sum, mean, variance, std, quartiles.
     * Aliases (avg/average/mean, var/variance, med/median) are kept for
     * backwards-compatible callers.
     */
    _numeric_summary_stats(data, col){
        const filtered = data.filter(d => d[col] != null && !(typeof d[col] === 'number' && isNaN(d[col])));
        if(filtered.length === 0){
            const empty = this._empty_summary_stats();
            empty.count_total = data.length;
            return empty;
        }
        const stats = {};
        stats.min = filtered.reduce((prev, curr) => prev[col] < curr[col] ? prev : curr)[col];
        stats.max = filtered.reduce((prev, curr) => prev[col] > curr[col] ? prev : curr)[col];

        stats.sum = filtered.reduce((acc, current) => acc + current[col], 0);
        stats.avg = stats.sum / filtered.length;

        const [variance, std] = this.calculateStandardDeviation(filtered, stats.avg, col);
        stats.variance = variance;
        stats.std = std;

        const sorted = filtered.map(item => item[col]).sort(d3.ascending);
        stats.q1 = d3.quantile(sorted, 0.25);
        stats.q2 = d3.quantile(sorted, 0.50);
        stats.q3 = d3.quantile(sorted, 0.75);

        // aliases
        stats.median = stats.q2;
        stats.med = stats.median;
        stats.var = stats.variance;
        stats.average = stats.avg;
        stats.mean = stats.avg;
        stats.count = filtered.length;
        stats.count_total = data.length;
        return stats;
    }

    /**
     * Generates an array of linear scale values between a minimum and maximum value.
     * @param {number} min - The minimum value.
     * @param {number} max - The maximum value.
     * @param {number} numValues - The number of values to generate.
     * @returns {Array<number>} - The generated array of values.
     */
    linearScale(min, max, numValues) {
        if (typeof min !== 'number' || typeof max !== 'number' || typeof numValues !== 'number') {
            throw new Error("All arguments must be numbers");
        }
        if (numValues < 1) {
            throw new Error("The number of intervals must be at least 1");
        }
        if (numValues === 1) {
            return [min];
        }

        const step = (max - min) / (numValues - 1);
        const values = [];

        for (let i = 0; i < numValues; i++) {
            values.push(min + i * step);
        }

        return values;
    }

    /**
     * Generates an array of log scale values between a minimum and maximum value.
     * @param {number} min - The minimum value.
     * @param {number} max - The maximum value.
     * @param {number} numValues - The number of values to generate.
     * @returns {Array} - The generated log scale values.
     */
    logScale(min, max, numValues) {
        const values = [];
        const logMin = Math.log10(min);
        const logMax = Math.log10(max);
        const step = (logMax - logMin) / (numValues - 1);
        
        for (let i = 0; i < numValues; i++) {
            const logValue = logMin + step * i;
            const value = Math.pow(10, logValue); // Convert back to linear scale
            values.push(value);
        }
    
        return values;
    }

    /**
     * Calculates the standard deviation for a specified column in the data.
     * @param {Array} data - The data to analyze.
     * @param {number} mean - The mean value of the column.
     * @param {string} key - The column to calculate standard deviation for.
     * @returns {Array} - The variance and standard deviation of the column.
     */
    calculateStandardDeviation(data, mean, key) {
        const n = data.length;
        if (n === 0) return [0, 0]; // Avoid division by zero
    
        const squaredDiffs = data.map(item => {
            const value = item[key];
            const diff = value - mean;
            return diff * diff;
        });
    
        const variance = squaredDiffs.reduce((sum, value) => sum + value, 0) / n;
        return [variance, Math.sqrt(variance)];
    }

    /**
     * Tests if two input variables, min and max, are different by more than two orders of magnitude.
     * @param {number} min - The minimum value.
     * @param {number} max - The maximum value.
     * @param {number} order - Order of mangintude to test difference against
     * @returns {boolean} - True if the difference is more than two orders of magnitude, false otherwise.
     */
    is_more_than_n_orders_of_magnitude(min, max, order) {
        if (typeof min !== 'number' || typeof max !== 'number') {
            throw new Error("Both min and max must be numbers");
        }
        return Math.log10(max) - Math.log10(min) > order;
    }

  
    //box bins for a column
    binValues(values, thresholds, accessor) {
        const bins = [];
        // Create an empty bin for each interval between consecutive thresholds
        for (let i = 0; i < thresholds.length - 1; i++) {
            bins.push([]);
        }
        // Place each value in the appropriate bin (skip null/NaN)
        values.forEach(d => {
            const val = accessor(d);
            if(val == null || (typeof val === 'number' && isNaN(val))) return;
            for (let i = 0; i < thresholds.length - 1; i++) {
                // For the last bin, include values equal to the upper bound
                if (val >= thresholds[i] && (i === thresholds.length - 2 || val < thresholds[i + 1])) {
                    bins[i].push(d);
                    break;
                }
            }
        });
        return bins;
    }


    /**
     * Calculates metrics for the rectangles of the summary view for a specified facet. Bins come into this function already oragnized 
     * into columns delinated by the x_axis_thresholds. It's a user specified datetime variable.
     * @param {string} fac - The facet to calculate metrics for.
     * @param {Array} x_axis_thresholds - The time values that delinate individual columns in the final visualization.
     * @param {Array} y_axis_thresholds - The thresholds that delinate individual rows in the final visualization
     */
    calculate_box_metrics(fac, x_axis_thresholds, y_axis_thresholds){
        // Box metrics are being recomputed (initial build, config or filter
        // change) — invalidate the column-cell + overview-aggregate memos so the
        // detail view and overview strip reflect it.
        this._cell_cache[fac] = {};
        if(this._overview_agg_cache) delete this._overview_agg_cache[fac];
        let current_bins = this.faceted_bins[fac].column;
        // Pristine row arrays per x-bin, captured once after _build_axis('x').
        // Read-only here — apply the category filter into a per-call working
        // array instead of mutating the source.
        let original = this._original_column_values[fac];

        let col_indx = 0;
        const has_filter = this.faceted_states[fac].filter.length > 0;
        const filter = this.faceted_states[fac].filter;
        const cat_var = this.vars.categorical;

        for(let bin in current_bins){
            const source = original[bin];
            const filtered_bin = has_filter
                // Coerce null to MISSING_LABEL so a "(missing)" filter token
                // matches null-category rows (the bar chart bins them under that
                // same label) instead of selecting nothing.
                ? source.filter(d => filter.includes(d[cat_var] == null ? MISSING_LABEL : d[cat_var]))
                : source;

            this.faceted_bins[fac].column[bin] = this._column_stats_from_rows(
                fac, filtered_bin, x_axis_thresholds[bin], y_axis_thresholds,
                { col_index: col_indx, update_color_range: true });
            col_indx += 1;
        }

    }

    /**
     * Builds one heatmap column's stats object from its (already category-
     * filtered) row array: per-column y summary + per-y-bin color aggregates
     * (count, the active color_agg, std_ratio) + the gp_idx Int32Arrays the
     * brush/pin selection round-trips on. Shared by the at-rest overview
     * (calculate_box_metrics) and the detail view so a node column and a group
     * column are computed identically. Set `update_color_range` only for the
     * canonical overview pass so the legend domain is stable across detail zooms.
     */
    _column_stats_from_rows(fac, rows, threshold, y_axis_thresholds, opts = {}){
        const { col_index, update_color_range = false } = opts;
        const stats = this.get_summary_stats(rows, this.vars.y, col_index);
        stats.threshold = threshold;
        stats.count = rows.length;

        // For a list x, the fraction of these jobs that also ran on ≥1 other
        // node (node list length > 1) — drives the heatmap sharedness strip.
        if(this.x_is_list()){
            let shared = 0;
            for(let i = 0; i < rows.length; i++){
                const v = rows[i][this.vars.x];
                if(Array.isArray(v) && v.length > 1) shared++;
            }
            stats.shared_fraction = rows.length > 0 ? shared / rows.length : 0;
        }

        const facColorStd = this.faceted_sum_stats[fac].color.std;
        const customBins = this.binValues(rows, y_axis_thresholds, d => d[this.vars.y]);
        stats.bins = customBins.map((bin, index) => {
            const cell = this.get_summary_stats(bin, this.vars.color);
            cell.count = bin.length;
            cell.indices = new Int32Array(bin.length);
            for(let i = 0; i < bin.length; i++){
                cell.indices[i] = bin[i].gp_idx;
            }
            // facColorStd is 0 when the facet's color is constant; guard the
            // divide so std_ratio is 0 (no deviation) rather than NaN.
            cell.std_ratio = facColorStd ? cell.std / facColorStd : 0;
            cell.threshold = y_axis_thresholds[index];
            if(update_color_range){
                const agg_val = cell[this.vars.color_agg];
                // NaN != null is true, and Math.max(x, NaN) poisons the range to
                // NaN — which the legend then renders as its bound. Skip non-finite.
                if(agg_val != null && !Number.isNaN(agg_val)){
                    this.color_scale_range[0] = Math.min(this.color_scale_range[0], agg_val);
                    this.color_scale_range[1] = Math.max(this.color_scale_range[1], agg_val);
                }
            }
            return cell;
        });

        stats.indices = new Int32Array(rows.length);
        for(let i = 0; i < rows.length; i++){
            stats.indices[i] = rows[i].gp_idx;
        }
        return stats;
    }

    /**
     * Sanitizes and initializes the data for the model. Acts as an orchestrator
     * over a small pipeline of per-facet helpers; each helper owns one concern
     * (type coercion, summary stats, scale/threshold detection, binning,
     * categorical counts) so that the heatmap-layout shape this function
     * produces is built up in clearly named steps.
     * @param {Object} data - Faceted data, keyed by facet name.
     * @returns {Object} - The sanitized and initialized data.
     */
    sanitize_and_intialize_data(data){
        this.global_sum_stats = this._init_global_stats_accumulator();

        for(let fac of this.facets){
            this.scale_types[fac] = this._empty_scale_types();
            this.faceted_bins[fac] = {};

            this._coerce_facet_types(data, fac);
            this._compute_facet_summary_stats(data, fac);
            this._accumulate_global_stats(fac);

            // Build the x axis (thresholds + d3 bins) and the y axis (thresholds only).
            // _build_axis is allowed to mutate data[fac] when it needs to sanitize zeros
            // for a log scale.
            this._build_axis(data, fac, 'x');
            this._build_axis(data, fac, 'y');

            // Snapshot the d3.bin row arrays as the pristine source for
            // calculate_box_metrics. Shallow references only — no copies.
            this._original_column_values[fac] = this.faceted_bins[fac].column.map(b => b);

            this._compute_column_count_stats(fac);
            this.global_sum_stats.num_cols = Math.max(
                this.faceted_bins[fac].column.length,
                this.global_sum_stats.num_cols
            );

            this.calculate_box_metrics(fac, this.x_axis_thresholds[fac], this.y_axis_thresholds[fac]);
            this.calc_row_major_counts(fac);
            this._build_categorical_bins(data, fac);
        }

        return data;
    }

    /**
     * Builds the {x, y, color, num_cols} skeleton used to track stats across all facets.
     */
    _init_global_stats_accumulator(){
        const empty = () => ({ max: Number.MIN_SAFE_INTEGER, min: Number.MAX_SAFE_INTEGER });
        return { x: empty(), y: empty(), color: empty(), num_cols: 0 };
    }

    /**
     * Returns a fresh per-facet scale_types object with all flags off.
     */
    _empty_scale_types(){
        return {
            x: { log: false, linear: false, datetime: false, categorical: false },
            y: { log: false, linear: false, datetime: false }
        };
    }

    /**
     * Coerces string x values into Date objects. Log-scale zero sanitization is
     * intentionally deferred to _build_axis so it only runs for axes that
     * actually use a log scale.
     */
    _coerce_facet_types(data, fac){
        // A categorical x (scalar string or list) must NOT be coerced to Date —
        // node/category names are not parseable dates and would become NaN.
        if(this.x_is_categorical()) return;
        let sample;
        for(const row of data[fac]){
            if(row[this.vars.x] != null){ sample = row[this.vars.x]; break; }
        }
        if(typeof sample === 'string'){
            data[fac] = this.convert_to_date(data[fac], this.vars.x);
        }
    }

    /**
     * Populates faceted_sum_stats[fac] with summary stats for x, y, and color.
     */
    _compute_facet_summary_stats(data, fac){
        this.faceted_sum_stats[fac] = {
            // Numeric min/max over a categorical/list x is meaningless (and the
            // reduce would choke on array cells), so use empty stats — the
            // categorical build derives its column order separately.
            x: this.x_is_categorical() ? this._empty_summary_stats() : this.get_summary_stats(data[fac], this.vars.x),
            y: this.get_summary_stats(data[fac], this.vars.y),
            color: this.get_summary_stats(data[fac], this.vars.color)
        };
    }

    /**
     * Folds this facet's summary stats into the running global_sum_stats accumulator.
     */
    _accumulate_global_stats(fac){
        const facet_stats = this.faceted_sum_stats[fac];
        for(const axis of ['x', 'y', 'color']){
            this.global_sum_stats[axis].max = Math.max(facet_stats[axis].max, this.global_sum_stats[axis].max);
            this.global_sum_stats[axis].min = Math.min(facet_stats[axis].min, this.global_sum_stats[axis].min);
        }
    }

    /**
     * Detects the scale type for a single axis on a single facet, computes its
     * thresholds, and (for the x axis) runs the d3.bin pass that produces the
     * column structure consumed by the heatmap. May mutate data[fac] when log
     * scaling requires zero values to be promoted to one.
     * @param {Object} data - Faceted data.
     * @param {string} fac - Facet name.
     * @param {'x'|'y'} axis - Which axis to build.
     */
    _build_axis(data, fac, axis){
        const stats = this.faceted_sum_stats[fac][axis];
        const var_name = this.vars[axis];
        const is_x = axis === 'x';
        const num_thresholds = is_x ? num_cols - 1 : num_rows;

        if(is_x && this.x_is_categorical()){
            this._build_categorical_x_column(data, fac);
            return;
        }

        if(is_x && stats.min instanceof Date){
            this.scale_types[fac].x.datetime = true;
            const ticks = d3.scaleUtc()
                .domain([new Date(stats.min), this.addDays(new Date(stats.max), 1)])
                .ticks(this.x_axis_time_window);
            // Ensure the first threshold is the true data min so column[0].threshold
            // maps to scale(min) == left edge of the chart.
            if(ticks.length === 0 || +ticks[0] !== +stats.min){
                ticks.unshift(new Date(stats.min));
            }
            this.x_axis_thresholds[fac] = ticks;
            this.faceted_bins[fac].column = this._bin_column(data[fac], var_name,
                [new Date(stats.min), new Date(stats.max)], this.x_axis_thresholds[fac]);
            return;
        }

        if(typeof stats.max !== 'number'){
            return;
        }

        // Numeric axis: pick log vs linear based on spread
        const use_log = this.is_more_than_n_orders_of_magnitude(stats.min, stats.max, 3);
        const thresholds_target = is_x ? this.x_axis_thresholds : this.y_axis_thresholds;

        if(use_log){
            this.scale_types[fac][axis].log = true;
            data[fac] = this.sanitize_data_for_log(data[fac], var_name);
            // logScale's max is bumped by 1 on x to mirror prior behavior
            thresholds_target[fac] = this.logScale(
                this.log_values_floor,
                is_x ? stats.max + 1 : stats.max,
                num_thresholds
            );
            if(is_x){
                this.faceted_bins[fac].column = this._bin_column(data[fac], var_name,
                    [this.log_values_floor, stats.max], thresholds_target[fac]);
            }
        } else {
            this.scale_types[fac][axis].linear = true;
            thresholds_target[fac] = this.linearScale(
                stats.min,
                is_x ? stats.max + 1 : stats.max,
                num_thresholds
            );
            if(is_x){
                this.faceted_bins[fac].column = this._bin_column(data[fac], var_name,
                    [stats.min, stats.max], thresholds_target[fac]);
            }
        }
    }

    /**
     * Builds the x-column structure for a categorical x axis. Produces the same
     * shape the continuous path hands to calculate_box_metrics — an array of
     * row arrays, one per column — so the existing snapshot / box-metrics /
     * row-count machinery runs unchanged. x_axis_thresholds[fac] is set to the
     * ordered category names; calculate_box_metrics copies each into the
     * column's `.threshold` and sets `.count` to the column's distinct-job count.
     *
     * Scalar categorical: each row lands in exactly one column.
     * List column: the row is exploded into every (deduped) value's column.
     */
    _build_categorical_x_column(data, fac){
        this.scale_types[fac].x = { log: false, linear: false, datetime: false, categorical: true };

        const x = this.vars.x;
        const is_list = this.x_is_list();
        const buckets = new Map();
        // Tracks whether any record spans >1 value — the precondition for any
        // co-occurrence (sharedness strip + hover ribbon). Stays false for a
        // scalar categorical x and for a list x with only single-valued cells.
        let any_multi = false;

        const push = (key, row) => {
            const k = String(key);
            let arr = buckets.get(k);
            if(!arr){ arr = []; buckets.set(k, arr); }
            arr.push(row);
        };

        for(const row of data[fac]){
            const v = row[x];
            if(v == null) continue;
            if(is_list){
                const values = Array.isArray(v) ? v : [v];
                // Dedupe within a row so one job can't double-count in a column.
                const seen = new Set();
                for(const item of values){
                    if(item == null) continue;
                    const k = String(item);
                    if(seen.has(k)) continue;
                    seen.add(k);
                    push(k, row);
                }
                if(seen.size > 1) any_multi = true;
            } else {
                push(v, row);
            }
        }

        // Co-occurrence precondition + cache reset for this facet's new columns.
        this.faceted_has_sharing[fac] = is_list && any_multi;
        this._co_occurrence_cache[fac] = {};
        if(this._co_occurrence_fleet_cache) delete this._co_occurrence_fleet_cache[fac];
        if(this._co_fleet_range_cache) delete this._co_fleet_range_cache[fac];

        // A list x retains EVERY node: order all nodes (structural layout when
        // available, else seriation), build a grouping model, and render an
        // adaptive grouped overview rather than dropping the tail. A scalar
        // categorical x has no groupable structure, so it keeps the legibility
        // cap (drop the least-frequent tail past MAX_CATEGORICAL_COLUMNS).
        if(is_list){
            this._build_grouped_categorical(fac, buckets);
            return;
        }

        // --- scalar categorical x: rank-and-cap (unchanged behavior) ---
        const score_of = this._selection_score_fn(buckets);
        const ranked = [...buckets.keys()].sort((a, b) => {
            const ds = score_of(b) - score_of(a);
            if(ds !== 0) return ds;
            const df = buckets.get(b).length - buckets.get(a).length; // freq tiebreak
            if(df !== 0) return df;
            return a < b ? -1 : a > b ? 1 : 0;
        });
        const total = ranked.length;
        const shown = total > MAX_CATEGORICAL_COLUMNS ? ranked.slice(0, MAX_CATEGORICAL_COLUMNS) : ranked;
        this.categorical_overflow[fac] = total > MAX_CATEGORICAL_COLUMNS ? { shown: shown.length, total } : null;

        this.col_order[fac] = shown;
        this.x_axis_thresholds[fac] = shown;
        this.faceted_bins[fac].column = shown.map(k => buckets.get(k));
        this.faceted_groups[fac] = null;
        this.faceted_node_buckets[fac] = null;
    }

    /**
     * Retains all nodes of a list x by building a grouping model and rendering
     * one column per group at an adaptive overview level. Member rows are
     * deduped by gp_idx when combined into a group so a multi-node job that
     * touched several members of the same group is counted once.
     */
    _build_grouped_categorical(fac, buckets){
        // Order every present node: structural layout (category_order) puts
        // hardware-adjacent nodes together; seriation order does the same for
        // co-occurrence when there's no naming convention.
        const node_order = this._ordered_nodes([...buckets.keys()], buckets);
        this.faceted_node_buckets[fac] = node_order.map(k => buckets.get(k));

        const groups = this._build_group_model(fac, node_order);
        this.faceted_groups[fac] = groups;
        if(this._node_name_idx_cache) delete this._node_name_idx_cache[fac];
        // New columns => any prior detail-zoom window is meaningless; reset to
        // the whole-fleet overview.
        if(this.detail_range) this.detail_range[fac] = null;
        if(this._overview_agg_cache) delete this._overview_agg_cache[fac];

        // Adaptive overview: deepest grouping level whose column count fits the
        // render budget (most detail that stays legible). The detail heatmap
        // zooms into ranges of this via the overview-strip brush.
        const level = this._overview_level(groups);
        const overview = level < 0
            ? node_order.map(k => ({ key: k, label: k, lo: node_order.indexOf(k), hi: node_order.indexOf(k) }))
            : groups.groups_by_level[level];

        const keys = overview.map(g => g.key);
        this.col_order[fac] = keys;
        this.x_axis_thresholds[fac] = keys;
        this.faceted_bins[fac].column = overview.map(g => this._group_rows(fac, g));
        // No data dropped — clear any prior overflow note for this facet.
        this.categorical_overflow[fac] = null;
        // Remember which level the whole-fleet overview shows (the detail view
        // collapses back to it when the zoom brush is cleared).
        groups.overview_level = level;
    }

    /**
     * Orders all present node keys. The Python-shipped category_order
     * (structural hardware layout for node names, else co-occurrence seriation)
     * leads; any keys absent from it (defensive — every node is normally in the
     * order) follow, ranked by the same selection metric the cap used to use
     * (category_score if shipped, else facet-local frequency) so the fallback
     * ordering matches the prior rank-and-keep behavior. `buckets` is the
     * per-key row arrays map.
     */
    _ordered_nodes(keys, buckets){
        const stats = this.feature_summary_stats && this.feature_summary_stats[this.vars.x];
        const order = stats && stats.category_order;
        const cat_score = stats && stats.category_score;
        const score_of = (k) => cat_score && cat_score[k] != null
            ? cat_score[k]
            : buckets.get(k).length;
        const by_rank = (a, b) => {
            const ds = score_of(b) - score_of(a);
            if(ds !== 0) return ds;
            const dfreq = buckets.get(b).length - buckets.get(a).length;
            if(dfreq !== 0) return dfreq;
            return a < b ? -1 : a > b ? 1 : 0;
        };
        if(!order || !order.length){
            return keys.slice().sort(by_rank);
        }
        const pos = new Map(order.map((k, i) => [String(k), i]));
        const present = new Set(keys.map(String));
        const in_order = order.filter(k => present.has(String(k)));
        const seen = new Set(in_order.map(String));
        const rest = keys.filter(k => !seen.has(String(k))).sort(by_rank);
        return in_order.concat(rest);
    }

    /**
     * Builds the per-facet grouping model over the ordered node list. Uses the
     * Python node-name hierarchy (cabinet > chassis > ...) when shipped; else
     * synthesizes a single level of fixed-size chunks over the seriation order.
     * Group member ranges are contiguous because node_order is the hierarchy's
     * depth-first order (or the chunk order).
     *
     * Shape: { levels:[label...], node_order:[name...],
     *          groups_by_level:[ [ {key,label,lo,hi} ], ... ] }
     * where lo/hi are inclusive indices into node_order. The leaf level
     * (individual nodes) is implicit in node_order.
     */
    _build_group_model(fac, node_order){
        const stats = this.feature_summary_stats && this.feature_summary_stats[this.vars.x];
        const hierarchy = stats && stats.category_hierarchy;
        const levels = (stats && stats.category_levels) || [];

        if(hierarchy && levels.length){
            const groups_by_level = levels.map((label, L) => {
                const runs = [];
                let cur = null;
                for(let i = 0; i < node_order.length; i++){
                    const keys = hierarchy[node_order[i]];
                    // keys is [g0,...,gL-1, leaf]; level L's key is keys[L].
                    const gkey = (keys && keys[L] != null) ? keys[L] : node_order[i];
                    if(cur && cur.key === gkey){
                        cur.hi = i;
                    } else {
                        cur = { key: gkey, label: gkey, lo: i, hi: i };
                        runs.push(cur);
                    }
                }
                return runs;
            });
            return { levels, node_order, groups_by_level };
        }

        // Fallback: chunk the ordered nodes into ~CHUNK_TARGET_COLS groups so
        // every node is retained even without a naming convention.
        const n = node_order.length;
        const chunk = Math.max(1, Math.ceil(n / CHUNK_TARGET_COLS));
        const runs = [];
        for(let lo = 0; lo < n; lo += chunk){
            const hi = Math.min(lo + chunk - 1, n - 1);
            const key = lo === hi
                ? node_order[lo]
                : `${node_order[lo]}…${node_order[hi]}`;
            runs.push({ key, label: key, lo, hi });
        }
        return { levels: ['group'], node_order, groups_by_level: [runs] };
    }

    /**
     * Deepest grouping level whose column count is within RENDER_NODE_BUDGET, so
     * the at-rest overview shows the finest grouping that stays legible. Returns
     * the level index, or -1 to mean "render individual nodes" (when even node
     * granularity is within budget — small fleets need no grouping).
     */
    _overview_level(groups){
        if(groups.node_order.length <= RENDER_NODE_BUDGET) return -1;
        const lv = groups.groups_by_level;
        for(let L = lv.length - 1; L >= 0; L--){
            if(lv[L].length <= RENDER_NODE_BUDGET) return L;
        }
        return 0; // even the coarsest level overflows; the render budget bounds the work
    }

    /**
     * The deduped (by gp_idx) union of a group's member-node row arrays. Dedup
     * matters because a multi-node job appears in every member node's bucket;
     * the group should count it once.
     */
    _group_rows(fac, group){
        const node_buckets = this.faceted_node_buckets[fac];
        if(group.lo === group.hi) return node_buckets[group.lo];
        const seen = new Set();
        const out = [];
        for(let i = group.lo; i <= group.hi; i++){
            const rows = node_buckets[i];
            for(let r = 0; r < rows.length; r++){
                // Identity is the production gp_idx; fall back to list_major's
                // per-row `index` so dict-major test fixtures (which lack gp_idx)
                // still dedupe a multi-node job touching two members correctly.
                const row = rows[r];
                const gid = row.gp_idx != null ? row.gp_idx : row.index;
                if(seen.has(gid)) continue;
                seen.add(gid);
                out.push(row);
            }
        }
        return out;
    }

    /**
     * Exact, lazily-memoized column stats for a node/group descriptor
     * {key, lo, hi, level}. Cells depend only on the descriptor (not the zoom),
     * so each is computed once (via the shared _column_stats_from_rows path over
     * deduped member rows) and cached by level:lo:hi — changing the detail window
     * only re-selects precomputed columns.
     */
    _frontier_cells(fac, frontier_col){
        const cache = this._cell_cache[fac] || (this._cell_cache[fac] = {});
        const ck = `${frontier_col.level}:${frontier_col.lo}:${frontier_col.hi}`;
        if(cache[ck]) return cache[ck];
        const rows = (frontier_col.lo === frontier_col.hi
            ? this.faceted_node_buckets[fac][frontier_col.lo]
            : this._group_rows(fac, frontier_col)) || [];
        // Honor an active category filter so the detail matches the overview.
        const has_filter = this.faceted_states[fac].filter.length > 0;
        const cat_var = this.vars.categorical;
        // Coerce null to MISSING_LABEL so a "(missing)" filter matches null-category rows (see calculate_box_metrics).
        const filtered = has_filter ? rows.filter(d => this.faceted_states[fac].filter.includes(d[cat_var] == null ? MISSING_LABEL : d[cat_var])) : rows;
        cache[ck] = this._column_stats_from_rows(
            fac, filtered, frontier_col.key, this.y_axis_thresholds[fac], { update_color_range: false });
        return cache[ck];
    }

    /**
     * The deepest grouping level whose groups intersecting the node-index range
     * [lo,hi] number <= RENDER_NODE_BUDGET, i.e. the finest detail that stays
     * legible for that window. Returns the level index, or -1 to mean "render
     * individual nodes" (the range is small enough). Mirrors _overview_level but
     * scoped to a sub-range.
     */
    _detail_level(groups, lo, hi){
        if((hi - lo + 1) <= RENDER_NODE_BUDGET) return -1;
        const lv = groups.groups_by_level;
        for(let L = lv.length - 1; L >= 0; L--){
            let n = 0;
            for(const g of lv[L]) if(g.lo <= hi && g.hi >= lo) n++;
            if(n <= RENDER_NODE_BUDGET) return L;
        }
        return 0; // even the coarsest level overflows the window; budget bounds render work
    }

    /**
     * Render-ready columns for the detail heatmap zoomed to the node-index range
     * [lo,hi]. Picks the deepest level fitting the budget within the range and
     * emits one column per group/node, each CLIPPED to the range (a group
     * straddling the range edge is trimmed). Stats come from the shared, exact,
     * memoized _frontier_cells path. Columns carry {lo,hi,level,label} so pins
     * and co-occurrence projection resolve against them; the band scale owns
     * x/width (uniform, no distortion).
     */
    compute_detail_columns(fac, lo, hi){
        const groups = this.faceted_groups[fac];
        if(!groups) return this.faceted_bins[fac].column;
        const N = groups.node_order.length;
        if(N === 0) return [];   // a facet whose x is entirely empty/null — no columns
        lo = Math.max(0, Math.min(lo, N - 1));
        hi = Math.max(lo, Math.min(hi, N - 1));

        const level = this._detail_level(groups, lo, hi);
        let descriptors;
        if(level < 0){
            descriptors = [];
            for(let i = lo; i <= hi; i++){
                descriptors.push({ key: groups.node_order[i], label: groups.node_order[i],
                                   lo: i, hi: i, level: groups.groups_by_level.length });
            }
        } else {
            descriptors = groups.groups_by_level[level]
                .filter(g => g.lo <= hi && g.hi >= lo)
                .map(g => {
                    const clo = Math.max(g.lo, lo), chi = Math.min(g.hi, hi);
                    return { key: g.key, label: g.label, lo: clo, hi: chi, level };
                });
        }
        return descriptors.map(d => Object.assign({}, this._frontier_cells(fac, d),
            { label: d.label, lo: d.lo, hi: d.hi, level: d.level }));
    }

    /**
     * The columns currently displayed for a facet: the detail window when a
     * grouped list x is zoomed (a brush range is set), else the static per-facet
     * columns (whole-fleet overview / scalar categorical / continuous). Single
     * source of truth shared by the heatmap render and selection resolution.
     * Cheap to call repeatedly — _frontier_cells memoizes the per-column stats.
     */
    current_detail_columns(facet){
        const groups = this.faceted_groups && this.faceted_groups[facet];
        if(!groups) return this.faceted_bins[facet] ? this.faceted_bins[facet].column : [];
        // Always build via compute_detail_columns so columns carry lo/hi/level
        // (needed by co-occurrence projection + range-based pins) at every zoom —
        // the full range yields exactly the at-rest overview, with those fields.
        const N = groups.node_order.length;
        const range = (this.detail_range && this.detail_range[facet]) || [0, N - 1];
        return this.compute_detail_columns(facet, range[0], range[1]);
    }

    /**
     * Per-group aggregate for the overview strip (the persistent full-fleet
     * "distribution map"). One entry per whole-fleet overview-level group:
     * {key, lo, hi, shared_fraction, count}. Memoized; invalidated alongside the
     * cell cache when box metrics are recomputed.
     */
    overview_aggregate(fac){
        if(this._overview_agg_cache[fac]) return this._overview_agg_cache[fac];
        const groups = this.faceted_groups[fac];
        if(!groups){ this._overview_agg_cache[fac] = []; return []; }
        const level = groups.overview_level;
        const descriptors = level < 0
            ? groups.node_order.map((n, i) => ({ key: n, lo: i, hi: i, level: groups.groups_by_level.length }))
            : groups.groups_by_level[level].map(g => ({ key: g.key, lo: g.lo, hi: g.hi, level }));
        const agg = descriptors.map(d => {
            const cells = this._frontier_cells(fac, d);
            return { key: d.key, lo: d.lo, hi: d.hi,
                     shared_fraction: cells.shared_fraction || 0, count: cells.count };
        });
        this._overview_agg_cache[fac] = agg;
        return agg;
    }

    /**
     * Union of gp_idx for every node spanned by a node/group column,
     * deduped — used when a group column is pinned/brushed so selecting a
     * collapsed group selects all its jobs. Returns an Int32Array.
     */
    frontier_indices(fac, frontier_col){
        return this._frontier_cells(fac, frontier_col).indices;
    }

    /** Map of node name -> node-order index for a facet (memoized), so a job's
     *  node names can be projected onto the current detail/overview columns. */
    _node_name_index(fac){
        this._node_name_idx_cache = this._node_name_idx_cache || {};
        if(this._node_name_idx_cache[fac]) return this._node_name_idx_cache[fac];
        const order = (this.faceted_groups[fac] && this.faceted_groups[fac].node_order) || [];
        const map = new Map(order.map((n, i) => [String(n), i]));
        this._node_name_idx_cache[fac] = map;
        return map;
    }

    /**
     * Co-occurrence partners for a hovered node/group column, aggregated
     * onto the CURRENT frontier columns (so a collapsed partner contributes to
     * the group column it currently sits in). `hovered` and `frontier` are
     * frontier column descriptors ({key, lo, hi}). Returns [{key, strength}]
     * where strength = fraction of the hovered column's distinct jobs that also
     * touched a node now represented by that partner column. [] when there's no
     * sharing. This is the grouped-world analogue of co_occurrence_for.
     */
    co_occurrence_for_frontier(fac, hovered, frontier){
        if(!this.x_has_co_occurrence(fac)) return [];
        const node_buckets = this.faceted_node_buckets[fac];
        if(!node_buckets) return [];

        // Columns may be keyed by `key` (synthetic descriptors) or `threshold`
        // (rendered detail/overview columns) — accept either.
        const keyOf = (c) => c.key != null ? c.key : c.threshold;
        const node_to_col = new Array(node_buckets.length);
        for(const col of frontier){
            for(let i = col.lo; i <= col.hi; i++) node_to_col[i] = keyOf(col);
        }
        const name_to_idx = this._node_name_index(fac);
        const x = this.vars.x;
        const hoveredKey = String(keyOf(hovered));
        const hasRange = hovered.lo != null && hovered.hi != null;
        const rows = hovered.lo === hovered.hi
            ? node_buckets[hovered.lo]
            : this._group_rows(fac, hovered);

        const tally = new Map();
        const seenJob = new Set();
        let total = 0;
        for(const row of rows){
            const gid = row.gp_idx != null ? row.gp_idx : row.index;
            if(seenJob.has(gid)) continue;
            seenJob.add(gid);
            total++;
            const v = row[x];
            if(!Array.isArray(v)) continue;
            const partnerCols = new Set();
            for(const item of v){
                const idx = name_to_idx.get(String(item));
                if(idx == null) continue;
                // Exclude the source itself — every node within the hovered
                // range, so a pinned region zoomed to sub-columns doesn't arc to
                // its own members (fall back to the key match when no range).
                if(hasRange ? (idx >= hovered.lo && idx <= hovered.hi)
                            : String(node_to_col[idx]) === hoveredKey) continue;
                const colKey = node_to_col[idx];
                if(colKey == null) continue;
                partnerCols.add(colKey);
            }
            for(const ck of partnerCols) tally.set(ck, (tally.get(ck) || 0) + 1);
        }
        if(total === 0) return [];
        return [...tally.entries()]
            .map(([key, c]) => ({ node: key, key, strength: c / total }))
            .filter(d => d.strength > 1e-9)
            .sort((a, b) => b.strength - a.strength || (a.key < b.key ? -1 : 1));
    }

    /** True when a list x has ≥1 multi-valued record in this facet — the
     *  precondition for the sharedness strip and the hover ribbon. */
    x_has_co_occurrence(fac){
        return !!(this.faceted_has_sharing && this.faceted_has_sharing[fac]);
    }

    /**
     * Co-occurring nodes for a hovered node, as [{node, strength}] sorted desc,
     * where strength = P(other | node) = fraction of `node`'s records that also
     * used `other`. Restricted to nodes that are currently shown columns.
     * Returns [] (never throws) for a non-list x, an unknown node, an empty
     * column, or when there's no sharing. Memoized per facet.
     */
    co_occurrence_for(fac, node){
        if(!this.x_has_co_occurrence(fac)) return [];
        const cache = this._co_occurrence_cache[fac] || (this._co_occurrence_cache[fac] = {});
        const key = String(node);
        if(cache[key]) return cache[key];

        const thresholds = this.x_axis_thresholds[fac] || [];
        const shown = new Set(thresholds.map(String));
        const bin = thresholds.indexOf(node);
        const rows = bin >= 0 && this._original_column_values[fac]
            ? this._original_column_values[fac][bin]
            : null;
        if(!rows || rows.length === 0){ cache[key] = []; return cache[key]; }

        const x = this.vars.x;
        const tally = new Map();
        for(const row of rows){
            const v = row[x];
            if(!Array.isArray(v)) continue;
            const seen = new Set();
            for(const item of v){
                if(item == null) continue;
                const k = String(item);
                if(k === key || seen.has(k)) continue;   // skip self + per-row dupes
                seen.add(k);
                if(!shown.has(k)) continue;              // only positionable columns
                tally.set(k, (tally.get(k) || 0) + 1);
            }
        }

        const total = rows.length;
        const eps = 1e-9;
        const result = [...tally.entries()]
            .map(([n, c]) => ({ node: n, strength: c / total }))
            .filter(d => d.strength > eps)
            .sort((a, b) => b.strength - a.strength || (a.node < b.node ? -1 : 1));
        cache[key] = result;
        return result;
    }

    /**
     * Like co_occurrence_for but window-INDEPENDENT and unrestricted: source
     * rows come from the node's own bucket (always available, regardless of the
     * detail zoom), and partners are NOT filtered to currently-shown columns.
     * Returns every fleet partner [{node, strength}] so the overview strip can
     * tick a node's co-occurring partners at their true full-fleet positions —
     * including partners outside the brushed detail window (the "how distributed"
     * signal). Memoized in a separate cache.
     */
    co_occurrence_fleet(fac, node){
        if(!this.x_has_co_occurrence(fac)) return [];
        this._co_occurrence_fleet_cache = this._co_occurrence_fleet_cache || {};
        const cache = this._co_occurrence_fleet_cache[fac] || (this._co_occurrence_fleet_cache[fac] = {});
        const key = String(node);
        if(cache[key]) return cache[key];

        const idx = this._node_name_index(fac).get(key);
        const rows = idx != null && this.faceted_node_buckets[fac]
            ? this.faceted_node_buckets[fac][idx]
            : null;
        if(!rows || rows.length === 0){ cache[key] = []; return cache[key]; }

        const x = this.vars.x;
        const present = this._node_name_index(fac);
        const tally = new Map();
        for(const row of rows){
            const v = row[x];
            if(!Array.isArray(v)) continue;
            const seen = new Set();
            for(const item of v){
                if(item == null) continue;
                const k = String(item);
                if(k === key || seen.has(k)) continue;   // skip self + per-row dupes
                seen.add(k);
                if(!present.has(k)) continue;            // must map to a node index
                tally.set(k, (tally.get(k) || 0) + 1);
            }
        }
        const total = rows.length;
        const eps = 1e-9;
        const result = [...tally.entries()]
            .map(([n, c]) => ({ node: n, strength: c / total }))
            .filter(d => d.strength > eps)
            .sort((a, b) => b.strength - a.strength || (a.node < b.node ? -1 : 1));
        cache[key] = result;
        return result;
    }

    /**
     * Fleet co-occurrence for a node-index RANGE [lo,hi] (a single node when
     * lo==hi, or a group's members) — partners [{node, strength}] over the whole
     * fleet, window-independent, where strength = fraction of the range's
     * distinct jobs that also touched that partner. Lets a pinned/hovered group
     * OR node project its reach onto the overview strip even after it scrolls out
     * of the detail window. Memoized by lo:hi.
     */
    co_occurrence_fleet_range(fac, lo, hi){
        if(!this.x_has_co_occurrence(fac)) return [];
        this._co_fleet_range_cache = this._co_fleet_range_cache || {};
        const cache = this._co_fleet_range_cache[fac] || (this._co_fleet_range_cache[fac] = {});
        const ck = `${lo}:${hi}`;
        if(cache[ck]) return cache[ck];

        const nb = this.faceted_node_buckets[fac];
        const order = this.faceted_groups[fac] && this.faceted_groups[fac].node_order;
        if(!nb || !order){ cache[ck] = []; return cache[ck]; }
        const present = this._node_name_index(fac);
        const members = new Set();
        for(let i = lo; i <= hi; i++) members.add(String(order[i]));

        const x = this.vars.x;
        const tally = new Map();
        const seenJob = new Set();
        let total = 0;
        for(let i = lo; i <= hi; i++){
            const rows = nb[i];
            if(!rows) continue;
            for(const row of rows){
                const gid = row.gp_idx != null ? row.gp_idx : row.index;
                if(seenJob.has(gid)) continue;           // dedupe jobs across member nodes
                seenJob.add(gid);
                total++;
                const v = row[x];
                if(!Array.isArray(v)) continue;
                const seen = new Set();
                for(const item of v){
                    const k = String(item);
                    if(seen.has(k) || members.has(k)) continue;   // skip per-row dupes + within-range
                    seen.add(k);
                    if(!present.has(k)) continue;
                    tally.set(k, (tally.get(k) || 0) + 1);
                }
            }
        }
        const eps = 1e-9;
        const res = total === 0 ? [] : [...tally.entries()]
            .map(([n, c]) => ({ node: n, strength: c / total }))
            .filter(d => d.strength > eps)
            .sort((a, b) => b.strength - a.strength || (a.node < b.node ? -1 : 1));
        cache[ck] = res;
        return res;
    }

    /**
     * Returns key -> selection score. For a list x with a Python-shipped
     * category_score, uses it (frequency + association); otherwise ranks by the
     * facet-local distinct-job count. `buckets` is the per-key row arrays map.
     */
    _selection_score_fn(buckets){
        const stats = this.feature_summary_stats && this.feature_summary_stats[this.vars.x];
        const cat_score = this.x_is_list() && stats ? stats.category_score : null;
        if(cat_score){
            return (key) => cat_score[key] != null ? cat_score[key] : 0;
        }
        return (key) => buckets.get(key).length;
    }

    /**
     * Orders the kept category set by the Python seriation sequence (list x
     * only), so co-occurring nodes sit adjacent. category_order is global, so
     * filter it to this facet's keys; any keys absent from it are appended in
     * their incoming (selection) order. Falls back to `shown` unchanged when no
     * order is shipped or x isn't a list.
     */
    _seriated_order(shown){
        if(!this.x_is_list()) return shown;
        const stats = this.feature_summary_stats && this.feature_summary_stats[this.vars.x];
        const order = stats && stats.category_order;
        if(!order || !order.length) return shown;
        const pos = new Map(order.map((k, i) => [String(k), i]));
        const in_order = shown.filter(k => pos.has(String(k)))
                              .sort((a, b) => pos.get(String(a)) - pos.get(String(b)));
        const rest = shown.filter(k => !pos.has(String(k)));
        return in_order.concat(rest);
    }

    /**
     * Thin wrapper around d3.bin so the three call sites in _build_axis read uniformly.
     */
    _bin_column(records, var_name, domain, thresholds){
        // Records with null/NaN x are excluded from x-binning only; they remain
        // in the dataset and still contribute to non-x views.
        const filtered = records.filter(d => {
            const v = d[var_name];
            return v != null && !(typeof v === 'number' && isNaN(v));
        });
        return d3.bin()
            .value(d => d[var_name])
            .domain(domain)
            .thresholds(thresholds)(filtered);
    }

    /**
     * Records the min/max number of records per column on the facet's summary stats.
     */
    _compute_column_count_stats(fac){
        const sum_stats = this.faceted_sum_stats[fac];
        sum_stats.col_counts = { min: Number.MAX_SAFE_INTEGER, max: Number.MIN_SAFE_INTEGER };
        for(const bin of this.faceted_bins[fac].column){
            sum_stats.col_counts.max = Math.max(sum_stats.col_counts.max, bin.length);
            sum_stats.col_counts.min = Math.min(sum_stats.col_counts.min, bin.length);
        }
    }

    /**
     * Builds the {key, val}[] categorical-count list used by the bar chart, sorted descending.
     * Empty when there is no real categorical variable — either none configured,
     * or the role is bound to the backend's synthetic "no grouping" column (the
     * no-categorical-dataset fallback) — so the bar chart renders its empty state.
     */
    _build_categorical_bins(data, fac){
        const cat = this.vars.categorical;
        const stats = cat && this.feature_summary_stats[cat];
        if(!cat || (stats && stats.is_synthetic)){
            this.categorical_bins[fac] = [];
            return;
        }
        const cat_counts = {};
        for(const record of data[fac]){
            let key = record[cat];
            if(key == null) key = MISSING_LABEL;
            cat_counts[key] = (cat_counts[key] || 0) + 1;
        }
        this.categorical_bins[fac] = Object.keys(cat_counts)
            .map(key => ({ key, val: cat_counts[key] }))
            .sort((a, b) => b.val - a.val);
    }

    /**
     * Calculates row major counts for a specified facet.
     * @param {string} fac - The facet to calculate row major counts for.
     */
    calc_row_major_counts(fac){
        const columns = this.faceted_bins[fac].column;
        // A facet can have no columns when its x is categorical/list and every
        // row's x value is null/empty (e.g. a list column that's empty for all
        // rows in this facet). Emit empty counts so the views fall through to
        // their "too few datapoints" guards instead of reading columns[0].
        if(!columns || columns.length === 0){
            this.row_major_counts[fac] = [];
            this.total_row_major_counts[fac] = [];
            return;
        }
        const n_rows = columns[0].bins.length;

        if(this.x_is_list()){
            // A job touching N nodes appears in N columns; a plain sum would
            // count it N times. Dedupe per y-bin by unioning the per-cell
            // gp_idx sets across columns, then take the cardinality.
            const row_counts = new Array(n_rows);
            for(let row = 0; row < n_rows; row++){
                const seen = new Set();
                for(const column of columns){
                    const idx = column.bins[row].indices;
                    for(let i = 0; i < idx.length; i++) seen.add(idx[i]);
                }
                row_counts[row] = seen.size;
            }
            this.row_major_counts[fac] = row_counts;
            this.total_row_major_counts[fac] = row_counts;
            return;
        }

        // Scalar categorical and continuous x: each row is in exactly one
        // column, so summing cell counts per y-bin is already correct.
        let row_counts = Array(n_rows).fill(0);
        for(let column of columns){
            for(let row in column.bins){
                row_counts[row] += column.bins[row].count;
            }
        }

        this.row_major_counts[fac] = row_counts;
        this.total_row_major_counts[fac] = row_counts;
    }

    /**
     * Filters data by a specified category.
     * @param {Array} filter - The filter to apply.
     * @param {string} facet - The facet to filter.
     * @param {string} source - The source of the filter.
     * @param {Array} targets - The targets to update.
     */
    async filter_data_by_category(filter, facet, source, targets){

        this.faceted_states[facet].filter = filter;

        // is anything pinned
        // if so iterate through all pinned items
        // and if they are pinned push them on
        // if they are not already in this list
        if(this.is_any_category_pinned(facet)){
            for(let cat of Object.keys(this.faceted_states[facet].pinned_category)){
                if(this.faceted_states[facet].pinned_category[cat]){
                    filter.indexOf(cat) === -1 ? filter.push(cat) : null
                }
            }
        }

        // Tag this call with a monotonically-increasing generation so that
        // when the user rapidly hovers/leaves bars, only the latest reply
        // is applied — older in-flight replies would otherwise land last
        // and leave the heatmap stuck in a stale filter state.
        const my_gen = (this._filter_seq[facet] = (this._filter_seq[facet] || 0) + 1);

        // Try DuckDB-backed aggregation first; it is ~3–5× faster than the
        // JS recompute at 1M rows. Fall back to the JS path on any comm
        // error so behavior is preserved when the channel is unavailable
        // (e.g., test fixtures with no `send`/`on`).
        let used_python = false;
        // The DuckDB aggregation query bins x via threshold-CASE, which is
        // meaningless for a categorical x. Recompute categorical-x grids in JS
        // (calculate_box_metrics re-filters each column's rows by category).
        if(this._has_comm() && !this.x_is_categorical()){
            try {
                const reply = await this._send_request('request_aggregation', {
                    facet_by: this.vars.facet_by,
                    x: this.vars.x,
                    y: this.vars.y,
                    color: this.vars.color,
                    color_agg: this.vars.color_agg,
                    x_thresholds_by_facet: this._serialize_thresholds(this.x_axis_thresholds),
                    y_thresholds_by_facet: this._serialize_thresholds(this.y_axis_thresholds),
                    category_col: this.vars.categorical,
                    category_filter: filter.length > 0 ? filter : null,
                });
                // Discard stale replies: another filter dispatched after us
                // already owns the latest state.
                if(my_gen !== this._filter_seq[facet]) return;
                // `_apply_python_grid` returns true only if at least one
                // facet's bins were updated. An empty/missing grid (e.g.,
                // the engine wasn't initialized) drops to the JS fallback.
                used_python = this._apply_python_grid(reply && reply.grid);
                if(!used_python){
                    console.warn('Python aggregation returned empty grid; falling back to JS');
                }
            } catch(e){
                if(my_gen !== this._filter_seq[facet]) return;
                if(e && e.message && !/comm channel unavailable/i.test(e.message)){
                    console.warn('Python aggregation failed, using JS fallback:', e);
                }
            }
        }
        if(!used_python){
            // Re-aggregate from the pristine row arrays preserved by
            // sanitize_and_intialize_data. The prior JSON.parse(JSON.stringify(...))
            // deep-clone here scaled with N and dominated category-click latency
            // above ~100k rows.
            this.calculate_box_metrics(facet, this.x_axis_thresholds[facet], this.y_axis_thresholds[facet]);
        }

        // Same generation check applies for downstream renders — if another
        // filter superseded us during the brush round-trip, drop our render.
        if(my_gen !== this._filter_seq[facet]) return;

        await this.update_subselected_data(facet, targets, [], "", true);
        if(my_gen !== this._filter_seq[facet]) return;
        this.calc_row_major_counts(facet);

        for(let target of targets){
            this.manage_render(target);
        }
    }

    /**
     * Updates the subselection data based on brush selection. Most of the code is to catch edge cases where one histogram is not
     * brushed.
     * @param {string} facet - The facet to update.
     * @param {Array} targets - The targets to update.
     * @param {Array} selection - The selection range.
     * @param {string} range - The range type ("x" or "y").
     * @param {Boolean} no_render - prevent double renders when called from a function which will also render
     */
    async update_subselected_data(facet, targets, selection, range, no_render){
        // NOTE: y_range is stored in DESCENDING order ([upper, lower]) because the y axis
        // is screen-inverted. Row comparisons below read as `row >= y_range[1] && row < y_range[0]`
        // for that reason — do not "fix" the comparison without also normalizing the range.
        // brushed_data is a flat array of gp_idx integers (no longer raw row
        // refs) — legend.js still reads .length, which now matches selection size.
        // Normalize falsy selections to [] so downstream `.length` checks
        // don't crash. The histogram brush handler has paths (e.g. when the
        // x-scale flags aren't yet set) where `selection` reaches us as
        // undefined; the prior behavior threw on the next `.length` read.
        const safe_selection = Array.isArray(selection) ? selection : [];
        if(range == "x"){
            this.brushed_ranges[facet].x_range = safe_selection;
        }
        else if(range == "y"){
            this.brushed_ranges[facet].y_range = safe_selection;
        }
        else{

        }

        await this._apply_brush_selection(facet, targets, no_render);
    }

    /**
     * Recomputes brushed_data[facet] from the current brushed_ranges (x/y) —
     * the Python brush query when available, else the JS fallback — then
     * finalizes the selection. Shared by the histogram brushes and the
     * continuous 2D box brush (which sets both ranges before calling this).
     */
    async _apply_brush_selection(facet, targets, no_render){
        const ranges = this.brushed_ranges[facet];
        const has_x_brush = ranges.x_range.length === 2;
        const has_y_brush = ranges.y_range.length === 2;
        const has_col_brush = ranges.col_range.length === 2;
        const cat_filter = this.faceted_states[facet] && this.faceted_states[facet].filter;
        const has_cat_filter = cat_filter && cat_filter.length > 0;

        let box_ids = new Int32Array(0);

        if(this.x_is_categorical()){
            // Band x (categorical / list): the box is (columns in col_range) ∩
            // (rows in y_range), computed over the DISPLAYED cells so it stays
            // correct when zoomed. col_range comes from the 2-d brush; a y-only
            // brush (empty col_range) = all columns ∩ y rows — this is what links
            // the right histogram and the 2-d brush via the shared y_range.
            if(has_col_brush || has_y_brush){
                box_ids = this._band_box_indices(facet);
            }
        }
        else if(has_x_brush || has_y_brush){
            // Continuous x: a single DuckDB query (or JS fallback) over the x/y
            // data box (+ active category filter).
            let used_python = false;
            if(this._has_comm()){
                try {
                    const x_extended = this._extend_brush_range_edges(facet, 'x', ranges.x_range);
                    const y_data = this._y_row_range_to_data(facet, ranges.y_range);
                    const y_extended = this._extend_brush_range_edges(facet, 'y', y_data);
                    const reply = await this._send_request('request_brush_indices', {
                        facet_by: this.vars.facet_by,
                        x: this.vars.x,
                        y: this.vars.y,
                        facet,
                        x_range: this._serialize_range(x_extended),
                        y_range: y_extended,
                        category_col: this.vars.categorical,
                        category_filter: has_cat_filter ? cat_filter : null,
                    });
                    const indices = reply && reply.indices;
                    box_ids = Array.isArray(indices) ? Int32Array.from(indices) : new Int32Array(0);
                    used_python = true;
                } catch(e){
                    if(e && e.message && !/comm channel unavailable/i.test(e.message)){
                        console.warn('Python brush failed, using JS fallback:', e);
                    }
                }
            }
            if(!used_python){
                box_ids = this._compute_brushed_data_js(facet);
            }
        }

        // The brush feeds the BOX stream; pin + color streams are untouched.
        this.sel.box[facet] = box_ids;
        this._recompute_facet_selection(facet);
        this._finalize_selection(targets, no_render);
    }

    /**
     * Box selection for a band (categorical/list) x: the deduped gp_idx of
     * displayed cells whose column is in col_range (empty = all columns) and
     * whose row is in y_range (empty = all rows). Grouped columns carry
     * lo/hi (node-index overlap); scalar columns are matched by array index.
     */
    _band_box_indices(facet){
        const cols = this.current_detail_columns(facet) || [];
        const cr = this.brushed_ranges[facet].col_range;
        const yr = this.brushed_ranges[facet].y_range;
        const has_col = cr.length === 2;
        const has_y = yr.length === 2;
        const ids = new Set();
        for(let ci = 0; ci < cols.length; ci++){
            const col = cols[ci];
            if(!col || !col.bins) continue;
            let in_col = !has_col;
            if(has_col){
                in_col = (col.lo != null)
                    ? (col.lo <= cr[1] && col.hi >= cr[0])   // grouped: node-index overlap
                    : (ci >= cr[0] && ci <= cr[1]);          // scalar: column-index range
            }
            if(!in_col) continue;
            for(let row = 0; row < col.bins.length; row++){
                if(has_y && !(row >= yr[1] && row < yr[0])) continue;   // y_range is [hi, lo] descending
                const idx = col.bins[row].indices;
                if(!idx) continue;
                for(let i = 0; i < idx.length; i++) ids.add(idx[i]);
            }
        }
        return Int32Array.from(ids);
    }

    /**
     * Flattens brushed_data across all facets into the selected_records trait
     * (the widget.selection round-trip) and re-renders the given targets.
     * Shared by the brush path and the categorical pin path.
     */
    _finalize_selection(targets, no_render){
        let total_ids = 0;
        for(let fac of this.facets){
            const arr = this.brushed_data[fac];
            if(arr && arr.length) total_ids += arr.length;
        }
        let return_ids = new Array(total_ids);
        let cursor = 0;
        for(let fac of this.facets){
            const arr = this.brushed_data[fac];
            if(!arr || !arr.length) continue;
            for(let i = 0; i < arr.length; i++){
                return_ids[cursor++] = arr[i];
            }
        }

        this.anywidget_model.set("selected_records", JSON.stringify(return_ids));
        this.anywidget_model.save_changes();

        if(!no_render){
            for(let target of (targets || [])){
                this.manage_render(target);
            }
        }
    }

    /** Recomputes brushed_data[facet] as the deduped UNION of the box, pin and
     *  color streams. Called whenever any one stream changes. */
    _recompute_facet_selection(facet){
        const ids = new Set();
        for(const name of ['box', 'pin', 'color']){
            const arr = this.sel[name][facet];
            if(arr) for(let i = 0; i < arr.length; i++) ids.add(arr[i]);
        }
        this.brushed_data[facet] = Int32Array.from(ids);
    }

    /** Sets one selection stream (box|pin|color) for a facet, re-unions into
     *  brushed_data, and syncs the export + renders targets. The other streams
     *  are untouched (so clearing one stream leaves the others). */
    _set_stream(facet, name, ids, targets){
        this.sel[name][facet] = ids instanceof Int32Array ? ids : Int32Array.from(ids || []);
        this._recompute_facet_selection(facet);
        this._finalize_selection(targets || [], false);
    }

    /** Pin-stream selection (column-pin / cell-pin) from an explicit gp_idx set. */
    set_pin_indices(facet, ids, targets){ this._set_stream(facet, 'pin', ids, targets); }
    /** Color-stream selection (color-legend brush) from an explicit gp_idx set. */
    set_color_indices(facet, ids, targets){ this._set_stream(facet, 'color', ids, targets); }
    /** Box-stream selection (2-d brush + histograms) from an explicit gp_idx set. */
    set_box_indices(facet, ids, targets){ this._set_stream(facet, 'box', ids, targets); }

    /**
     * Selection driven by pinned categorical columns (no x/y brush). Sets the
     * facet's brushed_data to the DEDUPED union of the pinned columns' gp_idx
     * (each column box-stat carries an `indices` Int32Array) and syncs
     * selected_records + the given render targets.
     */
    set_pinned_selection(facet, pinned_nodes, targets){
        const cols = this.faceted_bins[facet] ? this.faceted_bins[facet].column : [];
        const wanted = new Set((pinned_nodes || []).map(String));
        const ids = new Set();
        for(const col of cols){
            if(!wanted.has(String(col.threshold))) continue;
            const idx = col.indices;
            if(!idx) continue;
            for(let i = 0; i < idx.length; i++) ids.add(idx[i]);
        }
        this.set_pin_indices(facet, ids, targets);
    }

    /**
     * Sets a facet's selection to an explicit gp_idx set (already deduped by the
     * caller). Used by cell-pin and the 2D box brush, which capture their
     * record indices at action time so the selection persists across zoom even
     * as the underlying columns change. `ids` is any iterable of gp_idx.
     */
    set_selection_indices(facet, ids, targets){
        // Now routes to the PIN stream — its remaining caller is the grouped
        // cell-pin path (the 2-d box brush goes through the box stream).
        this.set_pin_indices(facet, ids, targets);
    }

    /**
     * Color-legend brush: selects every CURRENTLY-DISPLAYED cell whose color-agg
     * value falls in [v_lo, v_hi] (inclusive), unioning their gp_idx (deduped)
     * into the facet's selection for export, and stores the band on
     * brushed_ranges[facet].color_range so the heatmap highlights matching cells
     * and the legend can reflect the brush. A null range clears both. Independent
     * of the interaction mode and the x/y histogram brushes (own range slot).
     */
    select_by_color_range(facet, v_lo, v_hi, targets){
        if(v_lo == null || v_hi == null){
            this.brushed_ranges[facet].color_range = [];
            this.set_color_indices(facet, new Int32Array(0), targets);   // clear color stream only
            return;
        }
        const lo = Math.min(v_lo, v_hi), hi = Math.max(v_lo, v_hi);
        // Set the range BEFORE the re-render so manage_highlight sees it.
        this.brushed_ranges[facet].color_range = [lo, hi];
        const agg = this.vars.color_agg;
        const ids = new Set();
        for(const col of (this.current_detail_columns(facet) || [])){
            const bins = col && col.bins;
            if(!bins) continue;
            for(const cell of bins){
                if(!cell || !cell.count) continue;            // skip empty cells
                const v = cell[agg];
                if(v == null || Number.isNaN(v)) continue;
                if(v >= lo && v <= hi){
                    const idx = cell.indices;
                    if(!idx) continue;
                    for(let i = 0; i < idx.length; i++) ids.add(idx[i]);
                }
            }
        }
        this.set_color_indices(facet, ids, targets);
    }

    /**
     * Pin selection for a grouped list x: each pin is a node-index range
     * {lo, hi} (captured when the column was clicked) rather than a key, so the
     * selection is stable even after the pinned column collapses into a group or
     * explodes into nodes. Selects the deduped union of every job touching a
     * node in any pinned range.
     */
    set_pinned_ranges(facet, ranges, targets){
        const node_buckets = this.faceted_node_buckets[facet] || [];
        const ids = new Set();
        for(const { lo, hi } of (ranges || [])){
            for(let i = lo; i <= hi; i++){
                const rows = node_buckets[i];
                if(!rows) continue;
                for(let r = 0; r < rows.length; r++){
                    const row = rows[r];
                    ids.add(row.gp_idx != null ? row.gp_idx : row.index);
                }
            }
        }
        this.set_pin_indices(facet, ids, targets);
    }

    /**
     * Switches the heatmap interaction mode. Clears ONLY the pin stream (the
     * mode-specific column/cell pins) — the box (2-d brush + histograms) and the
     * color brush persist across mode switches, so changing how you interact with
     * the heatmap doesn't wipe an existing spatial or color selection. Re-renders
     * all views (each heatmap's apply_interaction_mode reconciles its overlays).
     */
    set_interaction_mode(mode){
        if(this.interaction_mode === mode) return;
        this.interaction_mode = mode;
        for(const fac of this.facets){
            this.sel.pin[fac] = new Int32Array(0);
            this._recompute_facet_selection(fac);
        }
        this._finalize_selection([], true);   // re-sync selected_records (box+color kept)
        this.render_all();
    }

    /**
     * Selection driven by pinned cells (cell-pin mode) or a categorical box
     * brush. cellKeys are "threshold|rowIndex" strings; sets brushed_data to the
     * DEDUPED union of those cells' gp_idx (column.bins[row].indices) and syncs
     * selected_records + targets. Works for any x type.
     */
    set_pinned_cell_selection(facet, cellKeys, targets){
        // Resolve against the columns currently RENDERED (detail window when
        // zoomed, else the overview), since the cell keys carry those columns'
        // thresholds — reading faceted_bins would miss a zoomed-in node/group.
        const cols = this.current_detail_columns(facet);
        const by_threshold = new Map(cols.map(c => [String(c.threshold), c]));
        const wanted = new Set(cellKeys || []);
        const ids = new Set();
        for(const k of wanted){
            const sep = k.lastIndexOf('|');
            if(sep < 0) continue;
            const col = by_threshold.get(k.slice(0, sep));
            const row = parseInt(k.slice(sep + 1), 10);
            const cell = col && col.bins ? col.bins[row] : null;
            const idx = cell && cell.indices;
            if(!idx) continue;
            for(let i = 0; i < idx.length; i++) ids.add(idx[i]);
        }
        this.set_pin_indices(facet, ids, targets);
    }

    /**
     * Date thresholds → ISO-like strings so SQL receives a value DuckDB
     * can coerce against TIMESTAMP columns. Numerics pass through.
     */
    _serialize_range(range){
        if(!Array.isArray(range)) return [];
        return range.map(v => {
            if(v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');
            return v;
        });
    }

    /**
     * Extends a brush range to capture the underflow/overflow rows that
     * Python's `_threshold_case` puts in bin 0 / the last bin (mirroring
     * d3.bin and JS's log-sanitized binning). Without this, brushing the
     * leftmost column or bottommost row excludes data points with value 0
     * — they sit below `thresholds[0]` (which is `log_values_floor = 1`
     * for log axes) but JS would have sanitized them into bin 0. Same
     * idea for the high edge.
     *
     * Returns the range with extended bounds (MIN/MAX_SAFE_INTEGER
     * sentinels) when the brush touches the threshold edges; otherwise
     * returns the input unchanged.
     */
    _extend_brush_range_edges(facet, axis, range){
        if(!Array.isArray(range) || range.length !== 2) return range;
        // Don't touch datetime ranges; the log-sanitization edge case
        // doesn't apply for datetime axes.
        if(range[0] instanceof Date || range[1] instanceof Date) return range;
        if(typeof range[0] !== 'number' || typeof range[1] !== 'number') return range;
        const thresholds = (axis === 'x' ? this.x_axis_thresholds : this.y_axis_thresholds)[facet];
        if(!Array.isArray(thresholds) || thresholds.length < 2) return range;
        let [lo, hi] = range;
        const t_lo = Math.min(thresholds[0], thresholds[thresholds.length - 1]);
        const t_hi = Math.max(thresholds[0], thresholds[thresholds.length - 1]);
        // SAFE_INTEGER sentinels stay within DuckDB's INT64/DOUBLE range
        // so the SQL parameter binds without precision concerns.
        if(lo <= t_lo) lo = Number.MIN_SAFE_INTEGER;
        if(hi >= t_hi) hi = Number.MAX_SAFE_INTEGER;
        return [lo, hi];
    }

    /**
     * Translates the Y histogram's brush range from row-index space (what
     * d3.brushY produces via the screen-inverted scale_y) into Y data values
     * the Python brush query can compare against the raw y column.
     *
     * Stored range is [high_row_idx, low_row_idx] (descending — see the
     * comment in update_subselected_data). Returns [lo_y, hi_y] in ascending
     * order, ready for the SQL `BETWEEN`.
     */
    _y_row_range_to_data(facet, row_range){
        if(!Array.isArray(row_range) || row_range.length !== 2) return [];
        const thresholds = this.y_axis_thresholds[facet];
        if(!Array.isArray(thresholds) || thresholds.length === 0) return [];
        const max_idx = thresholds.length - 1;
        const clamp = (i) => Math.max(0, Math.min(max_idx, i));
        // row_range[0] is the high row index, row_range[1] the low.
        const low_idx  = clamp(Math.floor(row_range[1]));
        const high_idx = clamp(Math.ceil(row_range[0]));
        const lo = thresholds[low_idx];
        const hi = thresholds[high_idx];
        // Thresholds may be ascending or descending depending on axis
        // orientation; normalize so the SQL gets [lo, hi].
        return lo <= hi ? [lo, hi] : [hi, lo];
    }

    /**
     * Legacy JS brush computation, retained for the no-comm path (tests,
     * environments where the kernel isn't yet attached). Reads bin.indices
     * populated by calculate_box_metrics.
     */
    _compute_brushed_data_js(facet){
        const chunks = [];

        if(this.brushed_ranges[facet].x_range.length != 0){
            for(let bin of this.faceted_bins[facet].column){
                let test_threshold = bin.threshold;
                if(this.scale_types[facet].x.datetime){
                    test_threshold = new Date(test_threshold);
                }
                if(test_threshold >= this.brushed_ranges[facet].x_range[0] &&
                    test_threshold <= this.brushed_ranges[facet].x_range[1]){
                        if (this.brushed_ranges[facet].y_range.length == 0){
                            chunks.push(bin.indices);
                        }
                        else{
                            for(let row in bin.bins){
                                if(row >= this.brushed_ranges[facet].y_range[1] &&
                                    row < this.brushed_ranges[facet].y_range[0]
                                ){
                                    chunks.push(bin.bins[row].indices);
                                }
                            }
                        }
                    }
            }
        }
        else if(this.brushed_ranges[facet].y_range.length != 0){
            for(let bin of this.faceted_bins[facet].column){
                for(let row in bin.bins){
                    if(row >= this.brushed_ranges[facet].y_range[1] &&
                        row < this.brushed_ranges[facet].y_range[0]
                    ){
                        chunks.push(bin.bins[row].indices);
                    }
                }
            }
        }

        let total = 0;
        for(const c of chunks) total += c.length;
        const flat = new Int32Array(total);
        let off = 0;
        for(const c of chunks){
            flat.set(c, off);
            off += c.length;
        }
        // For a list x a job spans multiple columns, so the same gp_idx can be
        // collected more than once; dedupe so the selection count is honest
        // (the Python brush path already applies DISTINCT). Returns the box gp_idx
        // (the caller assigns it to the box stream) rather than setting brushed_data.
        if(this.x_is_list() && flat.length > 0){
            return Int32Array.from(new Set(flat));
        }
        return flat;
    }

    /**
     * Updates the data for the model.
     * @param {Array} data - The new data to update.
     */
    update_data(data, feature_summary_stats){
        // A dataset swap can change the columns entirely, so refresh the
        // per-column summary stats that drive x-axis type detection (is_list,
        // category_order, etc.). Sorted by key to match the constructor's
        // predictable insertion order. Omitted (undefined) when the same frame
        // is reloaded with new rows but identical columns.
        if(feature_summary_stats){
            this.feature_summary_stats = Object.fromEntries(
                Object.entries(feature_summary_stats).sort((a, b) => a[0].localeCompare(b[0]))
            );
        }
        this.list_major_data = this._to_records(data);
        this._coerce_categorical_to_string(this.list_major_data, this.vars['categorical']);
        this.data = this.facet(this.list_major_data, this.vars['facet_by']);
        this._compute_facets();
        // Reset ALL per-facet state + memo caches for the new dataset (shared
        // with the constructor and apply_config so nothing stale survives a
        // swap — e.g. a prior list-x grouping leaking into a new continuous x).
        this._reset_derived_state();
        this.sanitize_and_intialize_data(this.data);
    }

    /**
     * Adopt a new config without any rebuild. Used on a dataset swap whose new
     * columns invalidate the old config: the caller assigns the regenerated
     * smart-default vars here, then calls update_data() which rebuilds against
     * the new frame using these vars. Going through apply_config instead would
     * rebuild against the still-loaded old frame (which lacks the new columns)
     * and throw. Keeping _applied_vars in sync means the subsequent
     * change:_vis_configs (fired when the caller persists the trait) diffs to
     * zero changes and stays a no-op.
     * @param {Object} new_vars - The regenerated config object.
     */
    reset_config(new_vars){
        this.vars = Object.assign({}, new_vars);
        this._applied_vars = Object.assign({}, new_vars);
    }

    /**
     * Incrementally apply a config change without rebuilding from scratch.
     * Called from the change:_vis_configs handler instead of constructing a
     * new JSModel — the prior behavior re-ran list_major + the full
     * sanitize_and_intialize_data pipeline for every dropdown selection, which
     * scales with N.
     *
     * Returns true if the render orchestration should proceed (always true
     * today; reserved for future short-circuit cases).
     * @param {Object} new_vars - The new config object from _vis_configs.
     */
    apply_config(new_vars){
        // Diff against _applied_vars, not this.vars — see constructor comment.
        const old_vars = this._applied_vars;
        // Partial inputs are valid: missing keys carry over from old_vars,
        // they are not treated as removals. Otherwise a caller passing a
        // single-field patch (`{color_agg: 'max'}`) would trigger a full
        // facet_by rebuild because facet_by appears "missing".
        const changed = new Set();
        for(const k of Object.keys(new_vars)){
            if(new_vars[k] !== old_vars[k]) changed.add(k);
        }

        this.vars = Object.assign({}, old_vars, new_vars);
        this._applied_vars = Object.assign({}, this.vars);

        if(changed.size === 0) return true;

        // facet_by changes the partitioning of the source data — no way to
        // avoid re-faceting, but we can re-use the existing list_major_data
        // (no decode/re-decode) and just reset derived per-facet state.
        if(changed.has('facet_by')){
            this.data = this.facet(this.list_major_data, this.vars['facet_by']);
            this._compute_facets();
            // New facet partitioning => every per-facet map + memo cache keyed by
            // the old facet names is stale; reset them all (shared with the
            // constructor / update_data) before rebuilding.
            this._reset_derived_state();
            this.sanitize_and_intialize_data(this.data);
            return true;
        }

        const recompute_x_axis = changed.has('x');
        const recompute_y_axis = changed.has('y');
        const recompute_metrics = recompute_x_axis || recompute_y_axis ||
                                  changed.has('color') || changed.has('color_agg');
        const recompute_categorical = changed.has('categorical');

        if(recompute_x_axis || recompute_y_axis){
            this.color_scale_range = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
            this.global_sum_stats = this._init_global_stats_accumulator();
            for(const fac of this.facets){
                // _empty_scale_types() clears the x flags (categorical/datetime/
                // log/linear), but _build_axis('x') — the only code that rebuilds
                // them — runs solely when x changed. On a y-only change we must
                // carry the existing x scale-type forward; otherwise a categorical
                // x silently drops off its scaleBand path in the heatmap and every
                // column's x position collapses to NaN.
                const preserved_x = recompute_x_axis ? null : this.scale_types[fac].x;
                this.scale_types[fac] = this._empty_scale_types();
                if(preserved_x) this.scale_types[fac].x = preserved_x;
                this.faceted_bins[fac] = {};
                this._coerce_facet_types(this.data, fac);
                this._compute_facet_summary_stats(this.data, fac);
                this._accumulate_global_stats(fac);
                if(recompute_x_axis) this._build_axis(this.data, fac, 'x');
                else {
                    // y change alone: x bins haven't been invalidated, restore
                    // the d3.bin row arrays we stashed previously so
                    // _compute_column_count_stats reads from arrays not stats.
                    this.faceted_bins[fac].column = this._original_column_values[fac].map(b => b);
                }
                this._build_axis(this.data, fac, 'y');
                if(recompute_x_axis){
                    this._original_column_values[fac] = this.faceted_bins[fac].column.map(b => b);
                }
                this._compute_column_count_stats(fac);
                this.global_sum_stats.num_cols = Math.max(
                    this.faceted_bins[fac].column.length,
                    this.global_sum_stats.num_cols
                );
                this.calculate_box_metrics(fac, this.x_axis_thresholds[fac], this.y_axis_thresholds[fac]);
                this.calc_row_major_counts(fac);
            }
        }
        else if(recompute_metrics){
            this.color_scale_range = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
            for(const fac of this.facets){
                this._compute_facet_summary_stats(this.data, fac);
                // Rebuild the working `column` array of row-bins from the
                // pristine snapshot so calculate_box_metrics has the right
                // shape (its earlier pass overwrote each slot with a stats
                // object).
                this.faceted_bins[fac].column = this._original_column_values[fac].map(b => b);
                this._compute_column_count_stats(fac);
                this.calculate_box_metrics(fac, this.x_axis_thresholds[fac], this.y_axis_thresholds[fac]);
                this.calc_row_major_counts(fac);
            }
        }

        if(recompute_categorical){
            // Coerce the new categorical column's values to strings before
            // rebuilding the bar-chart bins; otherwise a numeric column
            // selected as `categorical` would key the bar chart by number.
            this._coerce_categorical_to_string(this.list_major_data, this.vars['categorical']);
            for(const fac of this.facets){
                this._build_categorical_bins(this.data, fac);
            }
        }

        return true;
    }


    /**
     * Adds a view to the model.
     * @param {string} token - The token for the view.
     * @param {Object} view - The view to add.
     */
    add_view(token, view){
        this.views[token] = view;
    }

    /**
     * Updates row counts for a specified facet for the purposes of drawing the rows of the
     * summary view of the histogram 
     * @param {string} source_token - The source token.
     * @param {string} target_token - The target token.
     * @param {string} facet - The facet to update.
     * @param {Array} new_bins - The new bins to update.
     */
    update_row_counts(source_token, target_token, facet, new_bins){
        if(Object.keys(new_bins).length != 0){
            let bin_counts = new Array(new_bins[Object.keys(new_bins)[0]].length).fill(0);
            for(let column in new_bins){
                for(let bin in new_bins[column]){
                    bin_counts[bin] += new_bins[column][bin].count;
                }
            }
            this.row_major_counts[facet] = bin_counts;
        }
        else{
            this.row_major_counts[facet] = this.total_row_major_counts[facet];
        }

        this.manage_render(target_token);
    }

    /**
     * Manages rendering of a specified view based on the views associated "token".
     * This is functionally a MVVM architecture that cuts out the controller compared to a traditional
     * MVC approach
     * @param {string} token - The token for the view to render.
     */
    manage_render(token){
        // A view may be intentionally absent (e.g. the bottom histogram is not
        // built when x is categorical), yet still appear in another view's
        // render-target list. Skip silently rather than crashing.
        const view = this.views[token];
        if(view) view.render();
    }

    render_all(){
        for(let view in this.views){
            this.views[view].render();
        }
    }

    /**
     * Pins or unpins a clicked category.
     * @param {string} source_token - The source token.
     * @param {string} facet - The facet to update.
     * @param {string} category - The category to pin or unpin.
     */
    pin_unpin_clicked_category(source_token, facet, category){
        if(!Object.keys(this.faceted_states[facet].pinned_category).includes(category)){
            this.faceted_states[facet].pinned_category[category] = false;
        }
        this.faceted_states[facet].pinned_category[category] = !this.faceted_states[facet].pinned_category[category];
    }

    /**
     * Checks if a category is pinned.
     * @param {string} facet - The facet to check.
     * @param {string} category - The category to check.
     * @returns {boolean} - True if the category is pinned, false otherwise.
     */
    is_category_pinned(facet, category){
        if(!(Object.keys(this.faceted_states[facet].pinned_category).includes(category))){
            return false
        }
        return this.faceted_states[facet].pinned_category[category];
    }

    /**
     * Checks if any category is pinned.
     * @param {string} facet - The facet to check.
     * @returns {boolean} - True if any category is pinned, false otherwise.
     */
    is_any_category_pinned(facet){
        if(Object.keys(this.faceted_states[facet].pinned_category).length == 0){
            return false;
        }

        for(let cat in this.faceted_states[facet].pinned_category){
            if(this.faceted_states[facet].pinned_category[cat] == true){
                return true
            }
        }

        return false;
    }

}

export {JSModel, MISSING_LABEL}