import * as d3 from "d3";
import { tableFromIPC, Type } from "apache-arrow";
import { num_rows, num_cols, VALID_CONFIG_FIELDS, MAX_FACETS, MAX_CATEGORICAL_COLUMNS } from "./consts.js";

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
        this.views = {};
        this.color_scale_range = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
        this.log_values_floor = 1;
        this.y_axis_thresholds = {};
        this.x_axis_thresholds = {};
        // Per-facet ordered list of categorical x values (node/category names),
        // matching faceted_bins[fac].column order. For a list x this is the
        // Python seriation sequence (co-occurring nodes adjacent); otherwise
        // selection/frequency order.
        this.col_order = {};
        // Per-facet {shown, total} when a categorical x has more categories than
        // MAX_CATEGORICAL_COLUMNS and the tail was dropped; null otherwise. The
        // heatmap reads this to render a "showing top N of M" note.
        this.categorical_overflow = {};
        this.scale_types = {};

        this.faceted_states = {};
        this.brushed_ranges = {};
        this.brushed_data = {};
        for(let facet of this.facets){
            this.brushed_ranges[facet] = {
                x_range: [],
                y_range: []
            }
            this.brushed_data[facet] = [];
            this.faceted_states[facet] = {
                filter: [],
                pinned_category: {}
            };
        }

        this.valid_config_fields = VALID_CONFIG_FIELDS;

        //faceted derived data
        this.faceted_sum_stats = {};
        this.faceted_bins = {};

        // Original (unfiltered) row arrays per x-bin per facet. Holds row
        // references only (no deep copies). Used as the pristine source when
        // filter_data_by_category or other downstream recomputes need to
        // rebuild bin stats — replaces the old JSON-stringify snapshot.
        this._original_column_values = {};

        this.row_major_counts = {};
        this.total_row_major_counts = {};

        this.categorical_bins = {};
        this.total_categorical_bins = {};

        this.x_axis_time_window_ticks = d3.utcWeek.every(1);
        this.x_axis_time_window = d3.utcDay.every(1);

        // Comm-channel plumbing. JS sends `{type, request_id, ...}` to Python
        // via anywidget_model.send and resolves promises keyed by request_id
        // when the Python side replies. If the model lacks `send`/`on` (test
        // fixtures), filter/brush automatically fall back to the JS-side
        // pipeline so behavior is preserved.
        this._pending_requests = new Map();
        this._next_request_id = 0;
        // Per-facet monotonic counter for filter requests. A reply is only
        // applied if its generation matches the latest dispatched on that
        // facet — otherwise out-of-order async replies (e.g., mouseover
        // followed by mouseleave) can leave the heatmap stuck in a stale
        // filter state.
        this._filter_seq = {};
        if(anywidget_model && typeof anywidget_model.on === 'function'){
            anywidget_model.on('msg:custom', (msg) => this._handle_python_message(msg));
        }

        this.sanitize_and_intialize_data(this.data);
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
                ? source.filter(d => filter.includes(d[cat_var]))
                : source;

            // Get summary statistics for the entire column of data before it is split into rows
            let temp_box_stats = this.get_summary_stats(filtered_bin, this.vars.y, col_indx);
            temp_box_stats.threshold = x_axis_thresholds[bin];

            // count of rows in this column after filter; replaces the prior
            // column_values.length access pattern used by histogram.js so we no
            // longer have to hand a row-array out the door.
            temp_box_stats.count = filtered_bin.length;

            const customBins = this.binValues(filtered_bin, y_axis_thresholds, d => d[this.vars.y]);

            // Process each bin's summary statistics and update color scale range
            temp_box_stats.bins = customBins.map((bin, index) => {
                const stats = this.get_summary_stats(bin, this.vars.color);
                // Drop the raw-row array (`stats.values = bin`) — at 1M rows
                // it pinned ~133 row refs per cell × 7,500 cells ≈ all rows in
                // nested form, defeating aggregation. Keep only what consumers
                // actually need: count for emptiness/heights, indices for the
                // brush-selection gp_idx round-trip.
                stats.count = bin.length;
                stats.indices = new Int32Array(bin.length);
                for(let i = 0; i < bin.length; i++){
                    stats.indices[i] = bin[i].gp_idx;
                }
                stats.std_ratio = stats.std / this.faceted_sum_stats[fac].color.std;
                stats.threshold = y_axis_thresholds[index];
                const agg_val = stats[this.vars.color_agg];
                if (agg_val != null) {
                    this.color_scale_range[0] = Math.min(this.color_scale_range[0], agg_val);
                    this.color_scale_range[1] = Math.max(this.color_scale_range[1], agg_val);
                }
                return stats;
            });

            // Column-level Int32Array of gp_idx for the brush's x-only path —
            // matches the per-cell indices arrays so update_subselected_data
            // never touches raw row objects.
            temp_box_stats.indices = new Int32Array(filtered_bin.length);
            for(let i = 0; i < filtered_bin.length; i++){
                temp_box_stats.indices[i] = filtered_bin[i].gp_idx;
            }

            this.faceted_bins[fac].column[bin] = temp_box_stats;
            col_indx += 1;
        }

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
            } else {
                push(v, row);
            }
        }

        // Selection metric: which categories earn a column. For a list x with a
        // Python-computed category_score (frequency + peak association to a
        // common node), select by that so a rare-but-strongly-coupled node is
        // kept, not dropped for being infrequent. Otherwise rank by frequency.
        const score_of = this._selection_score_fn(buckets);
        const ranked = [...buckets.keys()].sort((a, b) => {
            const ds = score_of(b) - score_of(a);
            if(ds !== 0) return ds;
            const df = buckets.get(b).length - buckets.get(a).length; // freq tiebreak
            if(df !== 0) return df;
            return a < b ? -1 : a > b ? 1 : 0;
        });

        // Guard against high-cardinality columns (e.g. JOB_NAME) producing
        // thousands of unreadable columns: keep the top MAX_CATEGORICAL_COLUMNS
        // and drop the tail. Rows whose only x value is a dropped category fall
        // out of x-binning, same as null-x rows.
        const total = ranked.length;
        const shown = total > MAX_CATEGORICAL_COLUMNS ? ranked.slice(0, MAX_CATEGORICAL_COLUMNS) : ranked;
        this.categorical_overflow[fac] = total > MAX_CATEGORICAL_COLUMNS ? { shown: shown.length, total } : null;

        // Order the kept set: by the Python seriation sequence for a list x
        // (co-occurring nodes adjacent), else keep the selection order.
        const ordered = this._seriated_order(shown);
        this.col_order[fac] = ordered;
        this.x_axis_thresholds[fac] = ordered;
        this.faceted_bins[fac].column = ordered.map(k => buckets.get(k));
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
     */
    _build_categorical_bins(data, fac){
        const cat_counts = {};
        for(const record of data[fac]){
            let key = record[this.vars.categorical];
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

        const has_x_brush = this.brushed_ranges[facet].x_range.length === 2;
        const has_y_brush = this.brushed_ranges[facet].y_range.length === 2;
        const cat_filter = this.faceted_states[facet] && this.faceted_states[facet].filter;
        const has_cat_filter = cat_filter && cat_filter.length > 0;

        // Brush selection is gated by an ACTIVE brush range, not by the
        // category filter alone. Filter narrows what's *inside* the brush
        // window, but a filter without a brush yields zero selection — the
        // legacy JS behavior the legend tooltip and `widget.selection`
        // round-trip both depend on.
        if(!has_x_brush && !has_y_brush){
            this.brushed_data[facet] = new Int32Array(0);
        }
        else {
            // Python-backed brush: a single DuckDB query returns the gp_idx
            // values for rows within the current x/y range AND active category
            // filter. This avoids any reliance on JS-side bin.indices being
            // up-to-date with the filter state.
            let used_python = false;
            if(this._has_comm()){
                try {
                    // X is already in data space (numeric or Date). Y has to
                    // be converted from row-index space first. Both get the
                    // edge extension so brushes at the leftmost/bottommost
                    // bin capture underflow rows (data points that JS's
                    // log-sanitize put into bin 0 but Python's SQL would
                    // otherwise exclude with `x >= threshold[0]`).
                    // A categorical x has no numeric x-range to brush; send an
                    // empty x_range so the SQL falls back to y (+ category) only.
                    const x_extended = this.x_is_categorical()
                        ? []
                        : this._extend_brush_range_edges(
                            facet, 'x', this.brushed_ranges[facet].x_range);
                    const y_data = this._y_row_range_to_data(
                        facet, this.brushed_ranges[facet].y_range);
                    const y_extended = this._extend_brush_range_edges(
                        facet, 'y', y_data);
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
                    this.brushed_data[facet] = Array.isArray(indices)
                        ? Int32Array.from(indices)
                        : new Int32Array(0);
                    used_python = true;
                } catch(e){
                    if(e && e.message && !/comm channel unavailable/i.test(e.message)){
                        console.warn('Python brush failed, using JS fallback:', e);
                    }
                }
            }
            if(!used_python){
                this._compute_brushed_data_js(facet);
            }
        }

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
            for(let target of targets){
                this.manage_render(target);
            }
        }
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
        // (the Python brush path already applies DISTINCT).
        if(this.x_is_list() && flat.length > 0){
            this.brushed_data[facet] = Int32Array.from(new Set(flat));
        } else {
            this.brushed_data[facet] = flat;
        }
    }

    /**
     * Updates the data for the model.
     * @param {Array} data - The new data to update.
     */
    update_data(data){
        this.list_major_data = this._to_records(data);
        this._coerce_categorical_to_string(this.list_major_data, this.vars['categorical']);
        this.data = this.facet(this.list_major_data, this.vars['facet_by']);
        this._compute_facets();
        // Reset per-facet state for the new dataset.
        this._original_column_values = {};
        this.faceted_bins = {};
        this.faceted_sum_stats = {};
        this.scale_types = {};
        this.x_axis_thresholds = {};
        this.y_axis_thresholds = {};
        this.row_major_counts = {};
        this.total_row_major_counts = {};
        this.categorical_bins = {};
        this.brushed_ranges = {};
        this.brushed_data = {};
        this.faceted_states = {};
        for(let facet of this.facets){
            this.brushed_ranges[facet] = { x_range: [], y_range: [] };
            this.brushed_data[facet] = [];
            this.faceted_states[facet] = { filter: [], pinned_category: {} };
        }
        this.color_scale_range = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
        this.sanitize_and_intialize_data(this.data);
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
            this._original_column_values = {};
            this.faceted_bins = {};
            this.faceted_sum_stats = {};
            this.scale_types = {};
            this.x_axis_thresholds = {};
            this.y_axis_thresholds = {};
            this.row_major_counts = {};
            this.total_row_major_counts = {};
            this.categorical_bins = {};
            this.brushed_ranges = {};
            this.brushed_data = {};
            this.faceted_states = {};
            for(const facet of this.facets){
                this.brushed_ranges[facet] = { x_range: [], y_range: [] };
                this.brushed_data[facet] = [];
                this.faceted_states[facet] = { filter: [], pinned_category: {} };
            }
            this.color_scale_range = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
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