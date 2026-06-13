const assert = require('assert');

// JSModel is an ES module that pulls in d3; load it dynamically once for the suite.
let JSModel;
let MAX_CATEGORICAL_COLUMNS;

before(async () => {
    ({ JSModel } = await import('../guidepost/src/guidepost/js_model.js'));
    ({ MAX_CATEGORICAL_COLUMNS } = await import('../guidepost/src/guidepost/consts.js'));
});

/**
 * Builds a minimal anywidget model stub. Captures .set() calls so tests can
 * inspect what the model pushed back to Python.
 */
function makeAnywidgetStub(){
    const stub = {
        _state: {},
        _save_count: 0,
        set(key, value){ this._state[key] = value; },
        save_changes(){ this._save_count += 1; }
    };
    return stub;
}

/**
 * Builds a small dict-major dataset with two facets, a numeric x, a numeric y,
 * a numeric color, and a categorical column. n records per facet.
 */
function makeFixture(n = 10){
    const x = {}, y = {}, color = {}, cat = {}, fac = {};
    let idx = 0;
    for(const facet of ['A', 'B']){
        for(let i = 0; i < n; i++){
            x[idx] = i + 1;             // 1..n, no zeros (linear-friendly)
            y[idx] = (i + 1) * 2;
            color[idx] = i;
            cat[idx] = i % 3 === 0 ? 'red' : (i % 3 === 1 ? 'green' : 'blue');
            fac[idx] = facet;
            idx += 1;
        }
    }
    return { x, y, color, cat, fac };
}

const VARS = {
    facet_by: 'fac',
    x: 'x',
    y: 'y',
    color: 'color',
    color_agg: 'avg',
    categorical: 'cat'
};

function buildModel(fixture = makeFixture(), vars = VARS){
    return new JSModel(fixture, vars, {}, makeAnywidgetStub());
}

/**
 * Builds an Arrow IPC payload that mirrors what Python's pyarrow ships over
 * the `_vis_data` Bytes trait. Used to exercise the production transport
 * path end-to-end in the JS test suite.
 */
async function makeArrowPayload(fixture = makeFixture()){
    const arrow = await import('apache-arrow');
    const rows = Object.keys(fixture[Object.keys(fixture)[0]]).length;
    const cols = {};
    for(const name of Object.keys(fixture)){
        const arr = new Array(rows);
        for(let i = 0; i < rows; i++) arr[i] = fixture[name][i];
        // tableFromArrays infers types per column; strings become Utf8,
        // numbers become Float64 — both match what pyarrow produces from a
        // pandas frame of equivalent shape.
        cols[name] = arr;
    }
    const table = arrow.tableFromArrays(cols);
    return arrow.tableToIPC(table, 'stream');
}


describe('JSModel — pure helpers', () => {
    let model;
    before(() => { model = buildModel(); });

    describe('list_major', () => {
        it('converts dict-major to list-major and stamps an index', () => {
            const out = model.list_major({
                a: { 0: 1, 1: 2, 2: 3 },
                b: { 0: 'x', 1: 'y', 2: 'z' }
            });
            assert.strictEqual(out.length, 3);
            assert.deepStrictEqual(out[0], { a: 1, b: 'x', index: '0' });
            assert.deepStrictEqual(out[2], { a: 3, b: 'z', index: '2' });
        });
    });

    describe('facet', () => {
        it('groups records by the named column', () => {
            const facets = model.facet(
                [{ g: 'A', v: 1 }, { g: 'B', v: 2 }, { g: 'A', v: 3 }],
                'g'
            );
            assert.strictEqual(facets.A.length, 2);
            assert.strictEqual(facets.B.length, 1);
            assert.strictEqual(facets.A[0].v, 1);
        });
    });

    describe('addDays', () => {
        it('adds whole days without mutating the original date', () => {
            const original = new Date('2026-01-01T00:00:00Z');
            const plus3 = model.addDays(original, 3);
            assert.strictEqual(plus3.getUTCDate(), 4);
            assert.strictEqual(original.getUTCDate(), 1);
        });
    });

    describe('linearScale', () => {
        it('produces evenly spaced values inclusive of min and max', () => {
            const out = model.linearScale(0, 100, 5);
            assert.deepStrictEqual(out, [0, 25, 50, 75, 100]);
        });

        it('returns a single-element array when numValues is 1 (bug #10 guard)', () => {
            assert.deepStrictEqual(model.linearScale(7, 99, 1), [7]);
        });

        it('throws for numValues < 1', () => {
            assert.throws(() => model.linearScale(0, 1, 0));
        });

        it('throws for non-numeric inputs', () => {
            assert.throws(() => model.linearScale('a', 1, 5));
        });
    });

    describe('logScale', () => {
        it('returns numValues entries spanning min..max in log space', () => {
            const out = model.logScale(1, 1000, 4);
            assert.strictEqual(out.length, 4);
            assert.ok(Math.abs(out[0] - 1) < 1e-9);
            assert.ok(Math.abs(out[3] - 1000) < 1e-9);
            // Each step in log space should be ~equal
            const r1 = out[1] / out[0];
            const r2 = out[2] / out[1];
            assert.ok(Math.abs(r1 - r2) < 1e-9);
        });
    });

    describe('calculateStandardDeviation', () => {
        it('returns [variance, std] for a known distribution', () => {
            const data = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }];
            const [variance, std] = model.calculateStandardDeviation(data, 3, 'v');
            assert.strictEqual(variance, 2);
            assert.ok(Math.abs(std - Math.sqrt(2)) < 1e-9);
        });

        it('returns [0, 0] on empty input (bug #4)', () => {
            const result = model.calculateStandardDeviation([], 0, 'v');
            assert.deepStrictEqual(result, [0, 0]);
        });
    });

    describe('is_more_than_n_orders_of_magnitude', () => {
        it('detects spans larger than n orders', () => {
            assert.strictEqual(model.is_more_than_n_orders_of_magnitude(1, 100000, 3), true);
            assert.strictEqual(model.is_more_than_n_orders_of_magnitude(1, 100, 3), false);
        });
        it('throws on non-numeric inputs', () => {
            assert.throws(() => model.is_more_than_n_orders_of_magnitude('a', 1, 3));
        });
    });

    describe('binValues', () => {
        it('places values in the right interval and includes the upper edge in the last bin', () => {
            const data = [0, 1, 2, 3, 4, 5].map(v => ({ v }));
            const bins = model.binValues(data, [0, 2, 4, 5], d => d.v);
            assert.strictEqual(bins.length, 3);
            assert.deepStrictEqual(bins[0].map(d => d.v), [0, 1]);
            assert.deepStrictEqual(bins[1].map(d => d.v), [2, 3]);
            // Last bin is inclusive on the right
            assert.deepStrictEqual(bins[2].map(d => d.v), [4, 5]);
        });
    });

    describe('sanitize_data_for_log', () => {
        it('promotes zeros to one in place', () => {
            const data = [{ v: 0 }, { v: 1 }, { v: 5 }, { v: 0 }];
            model.sanitize_data_for_log(data, 'v');
            assert.deepStrictEqual(data.map(d => d.v), [1, 1, 5, 1]);
        });
    });

    describe('convert_to_date', () => {
        it('converts string column to Date instances', () => {
            const data = [{ d: '2026-01-01' }, { d: '2026-02-01' }];
            model.convert_to_date(data, 'd');
            assert.ok(data[0].d instanceof Date);
            assert.strictEqual(data[0].d.getUTCFullYear(), 2026);
        });
    });
});


describe('JSModel — get_summary_stats', () => {
    let model;
    before(() => { model = buildModel(); });

    it('numeric branch produces min/max/sum/avg/std/quartiles and aliases', () => {
        const data = [1, 2, 3, 4, 5].map(v => ({ v }));
        const s = model.get_summary_stats(data, 'v', 0);
        assert.strictEqual(s.min, 1);
        assert.strictEqual(s.max, 5);
        assert.strictEqual(s.sum, 15);
        assert.strictEqual(s.avg, 3);
        assert.strictEqual(s.mean, 3);
        assert.strictEqual(s.average, 3);
        assert.strictEqual(s.median, 3);
        assert.strictEqual(s.med, 3);
        assert.strictEqual(s.var, s.variance);
        assert.strictEqual(s.count, 5);
        assert.strictEqual(s.q2, 3);
        assert.strictEqual(s.index, 0);
    });

    it('numeric sum skips NaN entries instead of zeroing the accumulator', () => {
        const data = [{ v: 1 }, { v: NaN }, { v: 2 }];
        const s = model.get_summary_stats(data, 'v', 0);
        assert.strictEqual(s.sum, 3);
    });

    it('categorical branch returns lex extremes and zeroed numerics', () => {
        const data = [{ c: 'banana' }, { c: 'apple' }, { c: 'cherry' }];
        const s = model.get_summary_stats(data, 'c', 1);
        assert.strictEqual(s.min, 'apple');
        assert.strictEqual(s.max, 'cherry');
        assert.strictEqual(s.count, 3);
        assert.strictEqual(s.sum, 0);
        assert.strictEqual(s.avg, 0);
        assert.strictEqual(s.q1, 0);
        assert.strictEqual(s.index, 1);
    });

    it('empty branch returns the canonical zeroed shape (bug #6)', () => {
        const s = model.get_summary_stats([], 'v', 2);
        for(const key of ['min','max','sum','avg','average','mean','variance','var','std','q1','q2','q3','median','med','count']){
            assert.strictEqual(s[key], 0, `expected ${key} to be 0`);
        }
        assert.strictEqual(s.index, 2);
    });
});


describe('JSModel — constructor / sanitize pipeline', () => {
    let model;
    before(() => { model = buildModel(makeFixture(12)); });

    it('exposes the expected facets', () => {
        assert.deepStrictEqual(model.facets.sort(), ['A', 'B']);
    });

    it('builds faceted_sum_stats with x/y/color summaries per facet', () => {
        for(const fac of model.facets){
            const fs = model.faceted_sum_stats[fac];
            assert.ok(fs.x && fs.y && fs.color);
            assert.strictEqual(fs.x.count, 12);
            assert.strictEqual(fs.x.min, 1);
            assert.strictEqual(fs.x.max, 12);
            assert.strictEqual(fs.y.min, 2);
            assert.strictEqual(fs.y.max, 24);
        }
    });

    it('detects linear scale on a small numeric range', () => {
        for(const fac of model.facets){
            assert.strictEqual(model.scale_types[fac].x.linear, true);
            assert.strictEqual(model.scale_types[fac].x.log, false);
            assert.strictEqual(model.scale_types[fac].y.linear, true);
        }
    });

    it('builds column bins via d3.bin', () => {
        for(const fac of model.facets){
            assert.ok(Array.isArray(model.faceted_bins[fac].column));
            assert.ok(model.faceted_bins[fac].column.length > 0);
            // Each column should have a bins[] populated by calculate_box_metrics
            const col = model.faceted_bins[fac].column[0];
            assert.ok(Array.isArray(col.bins));
        }
    });

    it('records col_counts for each facet', () => {
        for(const fac of model.facets){
            const cc = model.faceted_sum_stats[fac].col_counts;
            assert.ok(typeof cc.min === 'number' && typeof cc.max === 'number');
            assert.ok(cc.max >= cc.min);
        }
    });

    it('builds categorical_bins sorted descending by count', () => {
        for(const fac of model.facets){
            const cats = model.categorical_bins[fac];
            assert.ok(cats.length > 0);
            for(let i = 1; i < cats.length; i++){
                assert.ok(cats[i - 1].val >= cats[i].val);
            }
        }
    });

    it('initializes row_major_counts with the right number of rows', () => {
        for(const fac of model.facets){
            // First column's bins length is what calc_row_major_counts uses
            const expected = model.faceted_bins[fac].column[0].bins.length;
            assert.strictEqual(model.row_major_counts[fac].length, expected);
        }
    });

    it('global_sum_stats accumulates across facets (bug #1 — color min uses .min)', () => {
        // Both facets share the same value range so global min must equal facet min,
        // not be pulled toward the running max.
        assert.strictEqual(model.global_sum_stats.color.min, model.faceted_sum_stats.A.color.min);
        assert.strictEqual(model.global_sum_stats.color.max, model.faceted_sum_stats.A.color.max);
        assert.ok(model.global_sum_stats.color.min < model.global_sum_stats.color.max);
    });

    it('detects log scale when the y range spans > 3 orders of magnitude', () => {
        const fixture = makeFixture(5);
        // override y values for facet A to span 1..10000
        const ids = Object.keys(fixture.fac).filter(k => fixture.fac[k] === 'A');
        ids.forEach((id, i) => { fixture.y[id] = Math.pow(10, i); });
        const m = buildModel(fixture);
        assert.strictEqual(m.scale_types.A.y.log, true);
        assert.strictEqual(m.scale_types.A.y.linear, false);
    });

    it('detects datetime x scale when x is a date string', () => {
        const fixture = makeFixture(5);
        const newX = {};
        Object.keys(fixture.x).forEach((id, i) => {
            newX[id] = `2026-01-${String((i % 5) + 1).padStart(2, '0')}`;
        });
        fixture.x = newX;
        const m = buildModel(fixture);
        for(const fac of m.facets){
            assert.strictEqual(m.scale_types[fac].x.datetime, true);
        }
    });

    it('captures pristine column-bin row arrays per facet', () => {
        for(const fac of model.facets){
            assert.ok(Array.isArray(model._original_column_values[fac]));
            assert.strictEqual(
                model._original_column_values[fac].length,
                model.faceted_bins[fac].column.length
            );
        }
    });
});


describe('JSModel — interaction state', () => {
    let model;
    beforeEach(() => { model = buildModel(); });

    describe('pin / unpin categories', () => {
        it('pin_unpin toggles a category state', () => {
            model.pin_unpin_clicked_category('tok', 'A', 'red');
            assert.strictEqual(model.is_category_pinned('A', 'red'), true);
            model.pin_unpin_clicked_category('tok', 'A', 'red');
            assert.strictEqual(model.is_category_pinned('A', 'red'), false);
        });

        it('is_any_category_pinned reports true only when something is pinned', () => {
            assert.strictEqual(model.is_any_category_pinned('A'), false);
            model.pin_unpin_clicked_category('tok', 'A', 'green');
            assert.strictEqual(model.is_any_category_pinned('A'), true);
        });

        it('is_category_pinned returns false for never-touched categories', () => {
            assert.strictEqual(model.is_category_pinned('A', 'unknown'), false);
        });
    });

    describe('update_subselected_data', () => {
        it('serializes selected ids back through anywidget_model', () => {
            const stub = makeAnywidgetStub();
            const m = new JSModel(makeFixture(), VARS, {}, stub);
            // Stub a view so manage_render is a no-op
            m.add_view('view', { render(){} });
            m.update_subselected_data('A', ['view'], [-Infinity, Infinity], 'x', false);
            assert.ok('selected_records' in stub._state);
            const ids = JSON.parse(stub._state.selected_records);
            assert.ok(Array.isArray(ids));
            assert.ok(stub._save_count >= 1);
        });

        it('clears brushed_data when no range is set', () => {
            model.add_view('v', { render(){} });
            model.update_subselected_data('A', ['v'], [], '', true);
            assert.strictEqual(model.brushed_data.A.length, 0);
        });
    });

    describe('filter_data_by_category', () => {
        it('records the filter and updates row_major_counts', () => {
            model.add_view('v', { render(){} });
            const before_total = model.row_major_counts.A.reduce((a, b) => a + b, 0);
            model.filter_data_by_category(['red'], 'A', 'src', ['v']);
            assert.deepStrictEqual(model.faceted_states.A.filter, ['red']);
            const after_total = model.row_major_counts.A.reduce((a, b) => a + b, 0);
            assert.ok(after_total <= before_total);
        });

        it('pinned categories are folded into the active filter (bug #2 — indexOf arg)', () => {
            model.add_view('v', { render(){} });
            model.pin_unpin_clicked_category('tok', 'A', 'green');
            const filter = ['red'];
            model.filter_data_by_category(filter, 'A', 'src', ['v']);
            assert.ok(filter.includes('green'));
            // Calling again should NOT duplicate 'green'
            model.filter_data_by_category(filter, 'A', 'src', ['v']);
            const greenCount = filter.filter(c => c === 'green').length;
            assert.strictEqual(greenCount, 1);
        });
    });

    describe('add_view / manage_render / render_all', () => {
        it('manage_render dispatches to the right view', () => {
            let called = 0;
            model.add_view('v1', { render(){ called += 1; } });
            model.manage_render('v1');
            assert.strictEqual(called, 1);
        });

        it('render_all renders every registered view', () => {
            let count = 0;
            model.add_view('v1', { render(){ count += 1; } });
            model.add_view('v2', { render(){ count += 1; } });
            model.render_all();
            assert.strictEqual(count, 2);
        });
    });

    describe('update_row_counts', () => {
        it('falls back to total_row_major_counts when new_bins is empty', () => {
            model.add_view('v', { render(){} });
            const before = model.total_row_major_counts.A.slice();
            model.update_row_counts('src', 'v', 'A', {});
            assert.deepStrictEqual(model.row_major_counts.A, before);
        });
    });

    describe('apply_config', () => {
        it('mutates vars without re-running list_major', () => {
            // Wrap list_major with a counting spy. apply_config must not touch
            // it for non-facet_by changes — the whole point of the method.
            const original = model.list_major.bind(model);
            let calls = 0;
            model.list_major = function(...args){ calls += 1; return original(...args); };
            model.apply_config({ color_agg: 'median' });
            assert.strictEqual(calls, 0);
            assert.strictEqual(model.vars.color_agg, 'median');
        });

        it('color_agg change rebuilds box metrics with the new aggregator', () => {
            // Before: avg. After: max. Cell aggregates should change.
            const fac = model.facets[0];
            const before = model.faceted_bins[fac].column.map(c => c.bins.map(b => b.avg));
            model.apply_config({ color_agg: 'max' });
            const after_max = model.faceted_bins[fac].column.map(c => c.bins.map(b => b.max));
            // max >= avg at the cell level (for non-empty cells)
            for(let i = 0; i < before.length; i++){
                for(let j = 0; j < before[i].length; j++){
                    if(model.faceted_bins[fac].column[i].bins[j].count > 0){
                        assert.ok(after_max[i][j] >= before[i][j]);
                    }
                }
            }
        });

        it('y change re-runs y axis thresholds', () => {
            const fac = model.facets[0];
            const before_thresholds = model.y_axis_thresholds[fac];
            model.apply_config({ y: 'color' });
            // Thresholds depend on the y variable's range; swapping y -> color
            // (different range) must produce a different threshold array.
            assert.notDeepStrictEqual(model.y_axis_thresholds[fac], before_thresholds);
        });

        it('no-op on identical config', () => {
            const before = JSON.stringify(model.vars);
            model.apply_config({ ...model.vars });
            assert.strictEqual(JSON.stringify(model.vars), before);
        });

        it('accepts an Arrow IPC payload as the data argument (production path)', async () => {
            const fixture = makeFixture(8);
            const ipc = await makeArrowPayload(fixture);
            const m = new JSModel(ipc, VARS, {}, makeAnywidgetStub());
            // Same shape as the dict path: facets present, list_major_data full
            assert.deepStrictEqual(m.facets.sort(), ['A','B']);
            assert.strictEqual(m.list_major_data.length, 16);
            // Round-tripped values preserved through Arrow
            for(const r of m.list_major_data){
                assert.ok(typeof r.x === 'number');
                assert.ok(typeof r.cat === 'string');
            }
        });

        it('still detects a change when this.vars has been mutated in place first', () => {
            // ConfigurationInterface.createDropdown does:
            //   let vis_configs = self.model.vars
            //   vis_configs[config.name] = v
            //   self.anywidget_model.set('_vis_configs', JSON.stringify(vis_configs))
            // which leaves this.vars already equal to the "new" config by the
            // time apply_config runs. Diff must be against _applied_vars, not
            // this.vars — otherwise the visualizations never update.
            const fac = model.facets[0];
            const before_thresholds = model.y_axis_thresholds[fac];
            model.vars.y = 'color';                     // mutate in place
            model.apply_config({ ...model.vars });      // pass the mutated object
            assert.notDeepStrictEqual(model.y_axis_thresholds[fac], before_thresholds);
        });
    });
});


describe('JSModel — categorical x axis', () => {
    // ---- scalar categorical (e.g. "users") ----
    function makeScalarCatFixture(){
        return {
            user:  {0:'alice',1:'alice',2:'bob',3:'carol',4:'bob',5:'alice'},
            y:     {0:2,1:4,2:6,3:8,4:10,5:12},
            color: {0:1,1:2,2:3,3:4,4:5,5:6},
            cat:   {0:'red',1:'green',2:'blue',3:'red',4:'green',5:'blue'},
            fac:   {0:'A',1:'A',2:'A',3:'A',4:'A',5:'A'},
        };
    }
    const SCALAR_VARS = { facet_by:'fac', x:'user', y:'y', color:'color', color_agg:'avg', categorical:'cat' };
    const SCALAR_SS = { user: { semantic_type:'categorical' } };

    it('scalar: flags categorical, one column per value, ordered count-desc', () => {
        const m = new JSModel(makeScalarCatFixture(), SCALAR_VARS, SCALAR_SS, makeAnywidgetStub());
        assert.strictEqual(m.scale_types.A.x.categorical, true);
        assert.strictEqual(m.x_is_categorical(), true);
        assert.strictEqual(m.x_is_list(), false);
        const cols = m.faceted_bins.A.column;
        assert.strictEqual(cols.length, 3);
        assert.deepStrictEqual(cols.map(c => c.threshold), ['alice','bob','carol']);
        assert.deepStrictEqual(cols.map(c => c.count), [3,2,1]);
        assert.ok(Array.isArray(cols[0].bins) && cols[0].bins.length > 0);
    });

    it('scalar: right histogram is a plain per-y-bin sum (no dedup)', () => {
        const m = new JSModel(makeScalarCatFixture(), SCALAR_VARS, SCALAR_SS, makeAnywidgetStub());
        const total = m.row_major_counts.A.reduce((a,b)=>a+b,0);
        assert.strictEqual(total, 6); // 6 jobs, each in exactly one column
    });

    it('scalar: a y-axis change preserves the categorical x scale + column order', () => {
        // Regression: apply_config reset scale_types via _empty_scale_types() on
        // any y change, but only rebuilt the x scale-type when x itself changed.
        // A y-only change therefore dropped x.categorical to false, knocking the
        // heatmap off its scaleBand path so every column's x position became NaN.
        const m = new JSModel(makeScalarCatFixture(), SCALAR_VARS, SCALAR_SS, makeAnywidgetStub());
        m.apply_config({ ...m.vars, y: 'color' });
        assert.strictEqual(m.scale_types.A.x.categorical, true);
        assert.strictEqual(m.x_is_categorical(), true);
        const cols = m.faceted_bins.A.column;
        assert.deepStrictEqual(cols.map(c => c.threshold), ['alice','bob','carol']);
        assert.deepStrictEqual(cols.map(c => c.count), [3,2,1]);
    });

    it('scalar: no overflow flag when category count is under the cap', () => {
        const m = new JSModel(makeScalarCatFixture(), SCALAR_VARS, SCALAR_SS, makeAnywidgetStub());
        assert.strictEqual(m.categorical_overflow.A, null);
    });

    it('scalar: caps columns at MAX_CATEGORICAL_COLUMNS and records the overflow', () => {
        const N = MAX_CATEGORICAL_COLUMNS + 50;
        const user = {}, y = {}, color = {}, cat = {}, fac = {};
        for(let i = 0; i < N; i++){
            user[i]  = 'u' + String(i).padStart(4, '0'); // distinct, alpha-deterministic
            y[i]     = i % 10;
            color[i] = i % 5;
            cat[i]   = 'red';
            fac[i]   = 'A';
        }
        const m = new JSModel({user, y, color, cat, fac}, SCALAR_VARS, SCALAR_SS, makeAnywidgetStub());
        assert.strictEqual(m.faceted_bins.A.column.length, MAX_CATEGORICAL_COLUMNS);
        assert.deepStrictEqual(m.categorical_overflow.A, { shown: MAX_CATEGORICAL_COLUMNS, total: N });
    });

    // ---- list-valued (e.g. "nodes") ----
    function makeListFixture(){
        return {
            nodes: {0:['n1','n2'], 1:['n1','n2','n3'], 2:['n2'], 3:['n3']},
            y:     {0:2,1:4,2:6,3:8},
            color: {0:1,1:2,2:3,3:4},
            cat:   {0:'red',1:'green',2:'blue',3:'red'},
            fac:   {0:'A',1:'A',2:'A',3:'A'},
        };
    }
    const LIST_VARS = { facet_by:'fac', x:'nodes', y:'y', color:'color', color_agg:'avg', categorical:'cat' };
    const LIST_SS = { nodes: { semantic_type:'categorical', is_list:true } };

    it('list: explodes into one column per distinct node, ordered count-desc', () => {
        const m = new JSModel(makeListFixture(), LIST_VARS, LIST_SS, makeAnywidgetStub());
        assert.strictEqual(m.scale_types.A.x.categorical, true);
        assert.strictEqual(m.x_is_list(), true);
        const cols = m.faceted_bins.A.column;
        assert.strictEqual(cols.length, 3);
        // n2 touches 3 jobs, n1 and n3 touch 2 each; ties broken name-asc
        assert.deepStrictEqual(cols.map(c => c.threshold), ['n2','n1','n3']);
        assert.deepStrictEqual(cols.map(c => c.count), [3,2,2]);
        assert.strictEqual(cols.reduce((a,c)=>a+c.count,0), 7); // (job,node) pairs
    });

    it('list: right histogram dedupes multi-node jobs (double-count regression)', () => {
        const m = new JSModel(makeListFixture(), LIST_VARS, LIST_SS, makeAnywidgetStub());
        const deduped = m.row_major_counts.A.reduce((a,b)=>a+b,0);
        const naive = m.faceted_bins.A.column.reduce((a,c)=>a+c.count,0);
        assert.strictEqual(naive, 7);   // would-be count if we summed cells
        assert.strictEqual(deduped, 4); // distinct jobs — each counted once
    });

    it('list: computes per-column shared_fraction (fraction of multi-node jobs)', () => {
        const m = new JSModel(makeListFixture(), LIST_VARS, LIST_SS, makeAnywidgetStub());
        const byNode = Object.fromEntries(m.faceted_bins.A.column.map(c => [c.threshold, c.shared_fraction]));
        // jobs: [n1,n2],[n1,n2,n3],[n2],[n3]
        assert.strictEqual(byNode['n1'], 1);          // both of n1's jobs are multi-node
        assert.ok(Math.abs(byNode['n2'] - 2/3) < 1e-9); // 2 of n2's 3 jobs multi-node
        assert.strictEqual(byNode['n3'], 0.5);        // 1 of n3's 2 jobs multi-node
    });

    it('scalar: columns carry no shared_fraction (not a list x)', () => {
        const m = new JSModel(makeScalarCatFixture(), SCALAR_VARS, SCALAR_SS, makeAnywidgetStub());
        assert.ok(m.faceted_bins.A.column.every(c => c.shared_fraction === undefined));
    });

    it('list: co_occurrence_for returns P(other | hovered)', () => {
        const m = new JSModel(makeListFixture(), LIST_VARS, LIST_SS, makeAnywidgetStub());
        const n1 = Object.fromEntries(m.co_occurrence_for('A', 'n1').map(d => [d.node, d.strength]));
        assert.strictEqual(n1['n2'], 1);     // both of n1's records also use n2
        assert.strictEqual(n1['n3'], 0.5);   // 1 of n1's 2 records uses n3
        const n2 = Object.fromEntries(m.co_occurrence_for('A', 'n2').map(d => [d.node, d.strength]));
        assert.ok(Math.abs(n2['n1'] - 2/3) < 1e-9);
        assert.ok(Math.abs(n2['n3'] - 1/3) < 1e-9);
    });

    it('x_has_co_occurrence: true for a multi-node list, false otherwise (graceful empties)', () => {
        const list = new JSModel(makeListFixture(), LIST_VARS, LIST_SS, makeAnywidgetStub());
        assert.strictEqual(list.x_has_co_occurrence('A'), true);

        const scalar = new JSModel(makeScalarCatFixture(), SCALAR_VARS, SCALAR_SS, makeAnywidgetStub());
        assert.strictEqual(scalar.x_has_co_occurrence('A'), false);

        // List column whose every record is single-valued → no co-occurrence.
        const singles = { nodes:{0:['n1'],1:['n2'],2:['n1'],3:['n3']}, y:{0:1,1:2,2:3,3:4},
            color:{0:1,1:2,2:3,3:4}, cat:{0:'red',1:'green',2:'blue',3:'red'}, fac:{0:'A',1:'A',2:'A',3:'A'} };
        const ms = new JSModel(singles, LIST_VARS, LIST_SS, makeAnywidgetStub());
        assert.strictEqual(ms.x_has_co_occurrence('A'), false);
        assert.deepStrictEqual(ms.co_occurrence_for('A', 'n1'), []);   // no sharing
        assert.deepStrictEqual(ms.co_occurrence_for('A', 'nope'), []); // unknown node
    });

    it('set_pinned_selection unions + dedups pinned columns gp_idx into selected_records', () => {
        const idxFix = { gp_idx:{0:10,1:11,2:12,3:13}, nodes:{0:['n1','n2'],1:['n1','n2','n3'],2:['n2'],3:['n3']},
            y:{0:2,1:4,2:6,3:8}, color:{0:1,1:2,2:3,3:4}, cat:{0:'red',1:'green',2:'blue',3:'red'}, fac:{0:'A',1:'A',2:'A',3:'A'} };
        const stub = makeAnywidgetStub();
        const m = new JSModel(idxFix, LIST_VARS, LIST_SS, stub);
        m.set_pinned_selection('A', ['n1', 'n2'], []);
        // n1 → records 10,11 ; n2 → 10,11,12 ; deduped union = 10,11,12
        const sel = JSON.parse(stub._state['selected_records']).sort((a, b) => a - b);
        assert.deepStrictEqual(sel, [10, 11, 12]);
        assert.deepStrictEqual([...m.brushed_data.A].sort((a, b) => a - b), [10, 11, 12]);
    });

    it('list: column order follows the shipped category_order (seriation)', () => {
        const ss = { nodes: { semantic_type:'categorical', is_list:true, category_order:['n3','n1','n2'] } };
        const m = new JSModel(makeListFixture(), LIST_VARS, ss, makeAnywidgetStub());
        assert.deepStrictEqual(m.faceted_bins.A.column.map(c => c.threshold), ['n3','n1','n2']);
    });

    it('list: categories missing from category_order are appended in selection order', () => {
        const ss = { nodes: { semantic_type:'categorical', is_list:true, category_order:['n3'] } };
        const m = new JSModel(makeListFixture(), LIST_VARS, ss, makeAnywidgetStub());
        // n3 first (in the order), then the rest by frequency-desc selection: n2, n1
        assert.deepStrictEqual(m.faceted_bins.A.column.map(c => c.threshold), ['n3','n2','n1']);
    });

    it('list: selection ranks by category_score, overriding frequency order', () => {
        const ss = { nodes: { semantic_type:'categorical', is_list:true,
            category_score: { n1: 0.05, n2: 0.1, n3: 1.0 } } };
        const m = new JSModel(makeListFixture(), LIST_VARS, ss, makeAnywidgetStub());
        // score desc => n3, n2, n1 (frequency order would be n2, n1, n3)
        assert.deepStrictEqual(m.faceted_bins.A.column.map(c => c.threshold), ['n3','n2','n1']);
    });

    it('list: a high-score rare node survives the cap over higher-frequency low-score nodes', () => {
        const N = MAX_CATEGORICAL_COLUMNS;          // N f-nodes + 1 keep-node => over the cap
        const nodes = {}, y = {}, color = {}, cat = {}, fac = {}, score = {};
        let r = 0;
        for(let i = 0; i < N; i++){
            const name = 'f' + String(i).padStart(4, '0');
            score[name] = 0.1;
            for(let k = 0; k < 2; k++){              // frequency 2 each (beats keep's 1)
                nodes[r] = [name]; y[r] = 1; color[r] = 1; cat[r] = 'red'; fac[r] = 'A'; r++;
            }
        }
        score['keep'] = 1.0;
        nodes[r] = ['keep']; y[r] = 1; color[r] = 1; cat[r] = 'red'; fac[r] = 'A'; r++;  // frequency 1
        const ss = { nodes: { semantic_type:'categorical', is_list:true, category_score: score } };
        const m = new JSModel({nodes, y, color, cat, fac}, LIST_VARS, ss, makeAnywidgetStub());

        const shown = m.faceted_bins.A.column.map(c => c.threshold);
        assert.strictEqual(shown.length, MAX_CATEGORICAL_COLUMNS);
        assert.ok(shown.includes('keep'), 'high-score rare node kept despite low frequency');
        assert.deepStrictEqual(m.categorical_overflow.A, { shown: MAX_CATEGORICAL_COLUMNS, total: N + 1 });
    });

    // A genuine pyarrow-produced List<Utf8> IPC stream (base64). The JS
    // apache-arrow ListBuilder is broken in this env, so we exercise the
    // decode path (the production concern) against real Arrow bytes rather
    // than building the payload in JS. Columns: gp_idx, nodes, y, color, cat, fac.
    const LIST_ARROW_B64 = '/////4gBAAAQAAAAAAAKAAwABgAFAAgACgAAAAABBAAMAAAACAAIAAAABAAIAAAABAAAAAYAAAAgAQAAtAAAAIQAAABUAAAALAAAAAQAAAAI////AAABBRAAAAAUAAAABAAAAAAAAAADAAAAZmFjADD///8s////AAABBRAAAAAUAAAABAAAAAAAAAADAAAAY2F0AFT///9Q////AAABAxAAAAAYAAAABAAAAAAAAAAFAAAAY29sb3IAAADa////AAACAHz///8AAAEDEAAAABgAAAAEAAAAAAAAAAEAAAB5AAYACAAGAAYAAAAAAAIAqP///wAAAQwUAAAAHAAAAAQAAAABAAAAFAAAAAUAAABub2RlcwAAANj////U////AAABBRAAAAAcAAAABAAAAAAAAAAEAAAAaXRlbQAAAAAEAAQABAAAABAAFAAIAAYABwAMAAAAEAAQAAAAAAABAhAAAAAgAAAABAAAAAAAAAAGAAAAZ3BfaWR4AAAIAAwACAAHAAgAAAAAAAABQAAAAP/////YAQAAFAAAAAAAAAAMABYABgAFAAgADAAMAAAAAAMEABgAAADwAAAAAAAAAAAACgAYAAwABAAIAAoAAAAsAQAAEAAAAAQAAAAAAAAAAAAAABEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAABQAAAAAAAAAOAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAIAAAAAAAAABYAAAAAAAAAA4AAAAAAAAAaAAAAAAAAAAAAAAAAAAAAGgAAAAAAAAAIAAAAAAAAACIAAAAAAAAAAAAAAAAAAAAiAAAAAAAAAAgAAAAAAAAAKgAAAAAAAAAAAAAAAAAAACoAAAAAAAAABQAAAAAAAAAwAAAAAAAAAAPAAAAAAAAANAAAAAAAAAAAAAAAAAAAADQAAAAAAAAABQAAAAAAAAA6AAAAAAAAAAEAAAAAAAAAAAAAAAHAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAACAAAAAAAAAAMAAAAAAAAAAAAAAAIAAAAFAAAABgAAAAcAAAAAAAAAAAAAAAIAAAAEAAAABgAAAAgAAAAKAAAADAAAAA4AAABuMW4ybjFuMm4zbjJuMwAAAAAAAAAAAEAAAAAAAAAQQAAAAAAAABhAAAAAAAAAIEAAAAAAAADwPwAAAAAAAABAAAAAAAAACEAAAAAAAAAQQAAAAAADAAAACAAAAAwAAAAPAAAAAAAAAHJlZGdyZWVuYmx1ZXJlZAAAAAAAAQAAAAIAAAADAAAABAAAAAAAAABBQUFBAAAAAP////8AAAAA';

    it('list: decodes a List<Utf8> Arrow IPC payload (production transport)', () => {
        const m = new JSModel(LIST_ARROW_B64, LIST_VARS, LIST_SS, makeAnywidgetStub());
        const r0 = m.list_major_data.find(r => r.gp_idx === 0);
        assert.ok(r0 && Array.isArray(r0.nodes), 'list cell decoded to a JS array');
        assert.deepStrictEqual(r0.nodes, ['n1','n2']);
        // same model shape as the dict path
        assert.strictEqual(m.scale_types.A.x.categorical, true);
        assert.strictEqual(m.faceted_bins.A.column.length, 3);
        assert.strictEqual(m.row_major_counts.A.reduce((a,b)=>a+b,0), 4);
    });
});
