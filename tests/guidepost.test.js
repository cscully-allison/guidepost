const assert = require('assert');

// JSModel is an ES module that pulls in d3; load it dynamically once for the suite.
let JSModel;
let MAX_CATEGORICAL_COLUMNS;
let RENDER_NODE_BUDGET;
let CHUNK_TARGET_COLS;
let load_smart_default_configs;

before(async () => {
    ({ JSModel } = await import('../guidepost/src/guidepost/js_model.js'));
    ({ MAX_CATEGORICAL_COLUMNS, RENDER_NODE_BUDGET, CHUNK_TARGET_COLS, load_smart_default_configs } = await import('../guidepost/src/guidepost/consts.js'));
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


describe('No / insufficient categorical columns (synthetic fallback)', () => {
    // Mirrors the backend's synthetic "no grouping" column: a constant categorical
    // marked is_synthetic in the summary stats.
    const SYNTH = '__gp_no_grouping__';

    it('smart defaults bind both facet_by and categorical to the synthetic column when there are no real categoricals', () => {
        const sum_stats = {
            m1: { semantic_type: 'continuous', std: 5, mean: 10, n_unique: 50 },
            m2: { semantic_type: 'continuous', std: 3, mean: 8,  n_unique: 40 },
            m3: { semantic_type: 'continuous', std: 2, mean: 6,  n_unique: 30 },
            [SYNTH]: { semantic_type: 'categorical', is_synthetic: true, n_unique: 1 },
        };
        const cfg = load_smart_default_configs(sum_stats, null);
        assert.strictEqual(cfg.facet_by, SYNTH);
        assert.strictEqual(cfg.categorical, SYNTH);
        // x/y/color still draw from the continuous columns, never the synthetic.
        for(const role of ['x', 'y', 'color']){
            assert.ok(cfg[role] && cfg[role] !== SYNTH, `${role} should be a continuous column`);
        }
    });

    it('smart defaults use a single real categorical for facet_by and the synthetic for the (empty) bar chart', () => {
        const sum_stats = {
            m1: { semantic_type: 'continuous', std: 5, mean: 10, n_unique: 50 },
            m2: { semantic_type: 'continuous', std: 3, mean: 8,  n_unique: 40 },
            m3: { semantic_type: 'continuous', std: 2, mean: 6,  n_unique: 30 },
            region: { semantic_type: 'categorical', n_unique: 5 },
            [SYNTH]: { semantic_type: 'categorical', is_synthetic: true, n_unique: 1 },
        };
        const cfg = load_smart_default_configs(sum_stats, null);
        assert.strictEqual(cfg.facet_by, 'region');
        assert.strictEqual(cfg.categorical, SYNTH);
    });

    it('_build_categorical_bins yields an empty list when categorical is the synthetic column', () => {
        const fixture = makeFixture(10);
        // Constant synthetic categorical column on the fixture.
        fixture[SYNTH] = {};
        for(const k of Object.keys(fixture.x)) fixture[SYNTH][k] = 'All records';
        const vars = { facet_by: 'fac', x: 'x', y: 'y', color: 'color', color_agg: 'avg', categorical: SYNTH };
        const summary = { [SYNTH]: { semantic_type: 'categorical', is_synthetic: true, n_unique: 1 } };
        const model = new JSModel(fixture, vars, summary, makeAnywidgetStub());
        for(const fac of model.facets){
            assert.deepStrictEqual(model.categorical_bins[fac], []);
        }
    });
});


describe('categorical filter — "(missing)" bucket', () => {
    // Facet 'A', 12 rows; even indices have a null category, odd indices 'x'.
    function nullCatFixture(){
        const x = {}, y = {}, color = {}, cat = {}, fac = {};
        for(let i = 0; i < 12; i++){
            x[i] = i + 1; y[i] = (i + 1) * 2; color[i] = i; fac[i] = 'A';
            cat[i] = (i % 2 === 0) ? null : 'x';
        }
        return { x, y, color, cat, fac };
    }

    function totalFilteredCount(model, fac){
        let total = 0;
        for(const col of model.faceted_bins[fac].column) total += col.count;
        return total;
    }

    it('filtering on "(missing)" selects exactly the null-category rows', () => {
        const model = buildModel(nullCatFixture());
        model.faceted_states['A'].filter = ['(missing)'];
        model.calculate_box_metrics('A', model.x_axis_thresholds['A'], model.y_axis_thresholds['A']);
        assert.strictEqual(totalFilteredCount(model, 'A'), 6);
    });

    it('filtering on a real category excludes the null-category rows', () => {
        const model = buildModel(nullCatFixture());
        model.faceted_states['A'].filter = ['x'];
        model.calculate_box_metrics('A', model.x_axis_thresholds['A'], model.y_axis_thresholds['A']);
        assert.strictEqual(totalFilteredCount(model, 'A'), 6);
    });

    it('the bar chart bins null categories under "(missing)"', () => {
        const model = buildModel(nullCatFixture());
        const bins = model.categorical_bins['A'];
        const missing = bins.find(b => b.key === '(missing)');
        assert.ok(missing && missing.val === 6);
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

    it('scalar: constant-color facet keeps std_ratio + the legend range finite (no NaN)', () => {
        // All color values equal => facet color std is 0. std_ratio = std/0 must
        // be guarded to 0, else a single NaN poisons color_scale_range[1] and the
        // legend renders NaN with no intermediary ticks.
        const data = { user:{0:'a',1:'b',2:'c'}, y:{0:1,1:2,2:3}, color:{0:5,1:5,2:5},
            cat:{0:'r',1:'g',2:'b'}, fac:{0:'A',1:'A',2:'A'} };
        const vars = { facet_by:'fac', x:'user', y:'y', color:'color', color_agg:'std_ratio', categorical:'cat' };
        const m = new JSModel(data, vars, { user:{ semantic_type:'categorical' } }, makeAnywidgetStub());
        for(const col of m.faceted_bins.A.column){
            for(const cell of col.bins) assert.ok(!Number.isNaN(cell.std_ratio), 'std_ratio is finite');
        }
        assert.ok(Number.isFinite(m.color_scale_range[0]) && Number.isFinite(m.color_scale_range[1]),
            'color_scale_range stays finite');
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

    it('list: a facet whose x is entirely empty/null does not crash (empty columns)', () => {
        // facet B's rows all have empty node lists → no columns for that facet.
        const data = { nodes:{0:['a','b'],1:['a'],2:[],3:[]},
            y:{0:1,1:2,2:3,3:4}, color:{0:1,1:2,2:3,3:4}, cat:{0:'r',1:'g',2:'r',3:'g'}, fac:{0:'A',1:'A',2:'B',3:'B'} };
        const vars = { facet_by:'fac', x:'nodes', y:'y', color:'color', color_agg:'avg', categorical:'cat' };
        const m = new JSModel(data, vars, LIST_SS, makeAnywidgetStub());
        assert.strictEqual(m.faceted_bins.A.column.length > 0, true);   // A renders
        assert.strictEqual(m.faceted_bins.B.column.length, 0);          // B has no columns
        assert.deepStrictEqual([...m.row_major_counts.B], []);          // empty → views show "too few" message
        // The heatmap's update_scales reads current_detail_columns for EVERY facet
        // (to build the band domain) — an empty facet must return [] without
        // throwing, else the render loop halts at it (regression: the facet after
        // an empty one stopped rendering).
        assert.deepStrictEqual(m.current_detail_columns('B'), []);
        assert.deepStrictEqual(m.compute_detail_columns('B', 0, 0), []);
    });

    it('set_pinned_cell_selection unions + dedups pinned cells gp_idx', () => {
        const idxFix = { gp_idx:{0:10,1:11,2:12,3:13}, nodes:{0:['n1','n2'],1:['n1','n2','n3'],2:['n2'],3:['n3']},
            y:{0:2,1:4,2:6,3:8}, color:{0:1,1:2,2:3,3:4}, cat:{0:'red',1:'green',2:'blue',3:'red'}, fac:{0:'A',1:'A',2:'A',3:'A'} };
        const stub = makeAnywidgetStub();
        const m = new JSModel(idxFix, LIST_VARS, LIST_SS, stub);
        const cols = m.faceted_bins.A.column;
        const n1col = cols.find(c => c.threshold === 'n1');
        const n2col = cols.find(c => c.threshold === 'n2');
        // Pin every cell of n1 and n2 → union of their records, deduped.
        const keys = [
            ...n1col.bins.map((b, r) => `n1|${r}`),
            ...n2col.bins.map((b, r) => `n2|${r}`),
        ];
        m.set_pinned_cell_selection('A', keys, []);
        const sel = JSON.parse(stub._state['selected_records']).sort((a, b) => a - b);
        assert.deepStrictEqual(sel, [10, 11, 12]);   // n1{10,11} ∪ n2{10,11,12}
    });

    it('set_interaction_mode switches mode and clears the active selection', () => {
        const idxFix = { gp_idx:{0:10,1:11,2:12,3:13}, nodes:{0:['n1','n2'],1:['n1','n2','n3'],2:['n2'],3:['n3']},
            y:{0:2,1:4,2:6,3:8}, color:{0:1,1:2,2:3,3:4}, cat:{0:'red',1:'green',2:'blue',3:'red'}, fac:{0:'A',1:'A',2:'A',3:'A'} };
        const stub = makeAnywidgetStub();
        const m = new JSModel(idxFix, LIST_VARS, LIST_SS, stub);
        assert.strictEqual(m.interaction_mode, 'column-pin');   // default
        m.set_pinned_selection('A', ['n1'], []);
        assert.ok(JSON.parse(stub._state['selected_records']).length > 0);
        m.set_interaction_mode('cell-pin');
        assert.strictEqual(m.interaction_mode, 'cell-pin');
        assert.deepStrictEqual([...m.brushed_data.A], []);
        assert.deepStrictEqual(JSON.parse(stub._state['selected_records']), []);
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

    it('list: retains ALL nodes (no cap drop) when under the render budget', () => {
        // A list x no longer drops the tail: every node is kept. With fewer
        // nodes than RENDER_NODE_BUDGET the overview renders each individually.
        const N = MAX_CATEGORICAL_COLUMNS + 1;       // 151 — would have been capped before
        const nodes = {}, y = {}, color = {}, cat = {}, fac = {};
        for(let i = 0; i < N; i++){
            nodes[i] = ['n' + String(i).padStart(4, '0')];
            y[i] = i % 10; color[i] = i % 5; cat[i] = 'red'; fac[i] = 'A';
        }
        const m = new JSModel({nodes, y, color, cat, fac}, LIST_VARS, LIST_SS, makeAnywidgetStub());
        assert.ok(N <= RENDER_NODE_BUDGET, 'fixture stays under the render budget');
        assert.strictEqual(m.faceted_bins.A.column.length, N);   // every node kept, none dropped
        assert.strictEqual(m.categorical_overflow.A, null);      // no overflow note
        assert.strictEqual(m.faceted_groups.A.node_order.length, N);
    });

    it('list: chunks a high-cardinality list into an adaptive grouped overview, retaining all', () => {
        // More distinct nodes than the budget + no naming convention => the
        // model chunks the seriation order into ~CHUNK_TARGET_COLS groups so no
        // node is dropped, while the rendered column count stays legible.
        const N = RENDER_NODE_BUDGET + 80;
        const nodes = {}, y = {}, color = {}, cat = {}, fac = {};
        for(let i = 0; i < N; i++){
            nodes[i] = ['n' + String(i).padStart(4, '0')];
            y[i] = i % 10; color[i] = i % 5; cat[i] = 'red'; fac[i] = 'A';
        }
        const m = new JSModel({nodes, y, color, cat, fac}, LIST_VARS, LIST_SS, makeAnywidgetStub());
        const cols = m.faceted_bins.A.column;
        assert.ok(cols.length <= RENDER_NODE_BUDGET, 'overview fits the render budget');
        assert.ok(cols.length <= CHUNK_TARGET_COLS + 1, 'chunked to ~CHUNK_TARGET_COLS groups');
        assert.strictEqual(m.categorical_overflow.A, null);            // nothing dropped
        assert.strictEqual(m.faceted_groups.A.node_order.length, N);   // all nodes retained
        // Single-node jobs: each job lands in exactly one group, so the grouped
        // column counts sum to every job.
        assert.strictEqual(cols.reduce((a, c) => a + c.count, 0), N);
    });

    it('list: a node-name hierarchy builds nested groups + a deepest-fitting overview', () => {
        // Cray-XName-style nodes across 10 cabinets × 30 slots (one chassis each)
        // => 300 nodes. The shipped hierarchy lets the overview collapse to the
        // deepest level that fits the budget (here: cabinet/chassis, 10 cols).
        const CABS = 10, SLOTS = 30;
        const nodes = {}, y = {}, color = {}, cat = {}, fac = {}, hierarchy = {}, order = [];
        let r = 0;
        for(let c = 0; c < CABS; c++){
            for(let s = 0; s < SLOTS; s++){
                const cab = `x${1000 + c}`, chs = `${cab}c0`, slot = `${chs}s${s}`, blade = `${slot}b0`, leaf = `${blade}n0`;
                hierarchy[leaf] = [cab, chs, slot, blade, leaf];
                order.push(leaf);
                nodes[r] = [leaf]; y[r] = r % 10; color[r] = r % 5; cat[r] = 'red'; fac[r] = 'A'; r++;
            }
        }
        const ss = { nodes: { semantic_type:'categorical', is_list:true,
            category_order: order, category_hierarchy: hierarchy,
            category_levels: ['cabinet','chassis','slot','blade'] } };
        const m = new JSModel({nodes, y, color, cat, fac}, LIST_VARS, ss, makeAnywidgetStub());

        const groups = m.faceted_groups.A;
        assert.deepStrictEqual(groups.levels, ['cabinet','chassis','slot','blade']);
        assert.strictEqual(groups.node_order.length, CABS * SLOTS);          // all nodes retained
        assert.strictEqual(groups.groups_by_level[0].length, CABS);          // cabinet groups
        // Cabinet groups are contiguous runs over node_order.
        assert.deepStrictEqual(groups.groups_by_level[0].map(g => g.hi - g.lo + 1), Array(CABS).fill(SLOTS));
        // Overview collapses to a level within budget; column count == that level's group count.
        const cols = m.faceted_bins.A.column;
        assert.ok(cols.length <= RENDER_NODE_BUDGET);
        assert.strictEqual(m.categorical_overflow.A, null);
        assert.strictEqual(cols.reduce((a, c) => a + c.count, 0), CABS * SLOTS);  // single-node jobs, one per group-member
    });

    it('list: group rows dedupe a multi-node job spanning two members of the same group', () => {
        // Two nodes in the same cabinet; one job uses BOTH. The cabinet group
        // must count that job once, not twice.
        const nodes = {0:['x1000c0s0b0n0','x1000c0s1b0n0'], 1:['x1000c0s0b0n0'], 2:['x1000c0s1b0n0']};
        const gp_idx = {0:10, 1:11, 2:12};
        const y = {0:1,1:2,2:3}, color = {0:1,1:2,2:3}, cat = {0:'r',1:'g',2:'r'}, fac = {0:'A',1:'A',2:'A'};
        const order = ['x1000c0s0b0n0','x1000c0s1b0n0'];
        const hierarchy = {
            'x1000c0s0b0n0': ['x1000','x1000c0','x1000c0s0','x1000c0s0b0','x1000c0s0b0n0'],
            'x1000c0s1b0n0': ['x1000','x1000c0','x1000c0s1','x1000c0s1b0','x1000c0s1b0n0'],
        };
        const ss = { nodes: { semantic_type:'categorical', is_list:true,
            category_order: order, category_hierarchy: hierarchy,
            category_levels: ['cabinet','chassis','slot','blade'] } };
        const m = new JSModel({gp_idx, nodes, y, color, cat, fac}, LIST_VARS, ss, makeAnywidgetStub());
        // Only 2 nodes (< budget) => overview renders nodes individually, but we
        // can exercise the group-row dedup directly via the cabinet group.
        const cabinet = m.faceted_groups.A.groups_by_level[0][0];
        const rows = m._group_rows('A', cabinet);
        const ids = rows.map(r => r.gp_idx).sort((a,b)=>a-b);
        assert.deepStrictEqual(ids, [10, 11, 12]);   // 3 distinct jobs, the shared one counted once
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

describe('JSModel — overview + detail', () => {
    const VARS = { facet_by:'fac', x:'nodes', y:'y', color:'color', color_agg:'avg', categorical:'cat' };

    // 16 cabinets × 2 chassis × 8 slots × 2 nodes = 512 nodes (> RENDER_NODE_BUDGET,
    // so the axis must group) with a real Cray-XName-style hierarchy (blades hold
    // 2 leaf nodes — genuine multi-level structure for the detail view to descend).
    function makeFleet(){
        const CABS = 16, CHAS = 2, SLOTS = 8, NODES = 2;
        const nodes = {}, y = {}, color = {}, cat = {}, fac = {}, hierarchy = {}, order = [];
        let r = 0;
        for(let c = 0; c < CABS; c++){
            for(let h = 0; h < CHAS; h++){
                for(let s = 0; s < SLOTS; s++){
                    for(let n = 0; n < NODES; n++){
                        const cab = `x${1000+c}`, chs = `${cab}c${h}`, slot = `${chs}s${s}`, blade = `${slot}b0`, leaf = `${blade}n${n}`;
                        hierarchy[leaf] = [cab, chs, slot, blade, leaf];
                        order.push(leaf);
                        nodes[r] = [leaf]; y[r] = r % 10; color[r] = r % 5; cat[r] = 'red'; fac[r] = 'A'; r++;
                    }
                }
            }
        }
        const ss = { nodes: { semantic_type:'categorical', is_list:true,
            category_order: order, category_hierarchy: hierarchy,
            category_levels: ['cabinet','chassis','slot','blade'] } };
        return { data: {nodes, y, color, cat, fac}, ss, N: CABS*CHAS*SLOTS*NODES };
    }

    function partitionsRange(cols, lo, hi){
        let next = lo;
        for(const c of cols){ if(c.lo !== next) return false; next = c.hi + 1; }
        return next === hi + 1;
    }

    it('overview_aggregate: one entry per overview group, fractions in [0,1], counts sum to the fleet', () => {
        const { data, ss, N } = makeFleet();
        const m = new JSModel(data, VARS, ss, makeAnywidgetStub());
        const g = m.faceted_groups.A;
        const agg = m.overview_aggregate('A');
        assert.strictEqual(agg.length, g.groups_by_level[g.overview_level].length);
        assert.ok(agg.every(d => d.shared_fraction >= 0 && d.shared_fraction <= 1));
        assert.strictEqual(agg.reduce((a, d) => a + d.count, 0), N);  // single-node jobs, partitioned
    });

    it('compute_detail_columns: a narrow range partitions exactly + fits the budget', () => {
        const { data, ss } = makeFleet();
        const m = new JSModel(data, VARS, ss, makeAnywidgetStub());
        const lo = 40, hi = 180;
        const cols = m.compute_detail_columns('A', lo, hi);
        assert.ok(partitionsRange(cols, lo, hi), 'columns tile [lo,hi] contiguously');
        assert.ok(cols.length <= RENDER_NODE_BUDGET);
        assert.ok(cols.every(c => Array.isArray(c.bins) && c.bins.length > 0));
    });

    it('compute_detail_columns: a small range reaches individual-node resolution', () => {
        const { data, ss } = makeFleet();
        const m = new JSModel(data, VARS, ss, makeAnywidgetStub());
        const lo = 10, hi = 25;                       // 16 nodes <= budget
        const cols = m.compute_detail_columns('A', lo, hi);
        assert.strictEqual(cols.length, hi - lo + 1);
        assert.ok(cols.every(c => c.lo === c.hi), 'one column per node');
    });

    it('compute_detail_columns: the full range equals the at-rest overview', () => {
        const { data, ss } = makeFleet();
        const m = new JSModel(data, VARS, ss, makeAnywidgetStub());
        const g = m.faceted_groups.A;
        const cols = m.compute_detail_columns('A', 0, g.node_order.length - 1);
        assert.strictEqual(cols.length, m.faceted_bins.A.column.length);
    });


    it('detail-column cells are memoized (same object on repeat)', () => {
        const { data, ss } = makeFleet();
        const m = new JSModel(data, VARS, ss, makeAnywidgetStub());
        const desc = { key: 'x1000c0', lo: 0, hi: 31, level: 1 };
        const c0 = m._frontier_cells('A', desc);
        const c1 = m._frontier_cells('A', desc);
        assert.strictEqual(c0, c1, 'cells cached by level:lo:hi');
    });

    it('set_pinned_ranges selects every job in a pinned group (stable across re-brush)', () => {
        // gp_idx fixture: pin a 2-node range; selection = union of both nodes' jobs.
        const gp_idx = {0:100, 1:101, 2:102, 3:103};
        const nodes = {0:['x1000c0s0b0n0'], 1:['x1000c0s0b0n1'], 2:['x1000c0s0b0n0','x1000c0s0b0n1'], 3:['x1000c0s1b0n0']};
        const y = {0:1,1:2,2:3,3:4}, color = {0:1,1:2,2:3,3:4}, cat = {0:'r',1:'g',2:'r',3:'g'}, fac = {0:'A',1:'A',2:'A',3:'A'};
        const order = ['x1000c0s0b0n0','x1000c0s0b0n1','x1000c0s1b0n0'];
        const hierarchy = {
            'x1000c0s0b0n0': ['x1000','x1000c0','x1000c0s0','x1000c0s0b0','x1000c0s0b0n0'],
            'x1000c0s0b0n1': ['x1000','x1000c0','x1000c0s0','x1000c0s0b0','x1000c0s0b0n1'],
            'x1000c0s1b0n0': ['x1000','x1000c0','x1000c0s1','x1000c0s1b0','x1000c0s1b0n0'],
        };
        const ss = { nodes: { semantic_type:'categorical', is_list:true,
            category_order: order, category_hierarchy: hierarchy,
            category_levels: ['cabinet','chassis','slot','blade'] } };
        const stub = makeAnywidgetStub();
        const m = new JSModel({gp_idx, nodes, y, color, cat, fac}, VARS, ss, stub);
        // Pin the blade b0 of slot s0 — node indices 0..1 — selects jobs 100,101,102.
        m.set_pinned_ranges('A', [{ lo: 0, hi: 1 }], []);
        const sel = JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b);
        assert.deepStrictEqual(sel, [100, 101, 102]);   // multi-node job 102 counted once
    });

    it('co_occurrence_for_frontier projects partners onto their current frontier columns', () => {
        // 3 nodes; a job on node 0 also touches node 2. With node 1 and node 2
        // collapsed into one frontier group, node 0's partner lights up that group.
        const nodes = {0:['x1000c0s0b0n0','x1000c0s2b0n0'], 1:['x1000c0s0b0n0'], 2:['x1000c0s1b0n0'], 3:['x1000c0s2b0n0']};
        const gp_idx = {0:1, 1:2, 2:3, 3:4};
        const y = {0:1,1:2,2:3,3:4}, color = {0:1,1:2,2:3,3:4}, cat = {0:'r',1:'g',2:'r',3:'g'}, fac = {0:'A',1:'A',2:'A',3:'A'};
        const order = ['x1000c0s0b0n0','x1000c0s1b0n0','x1000c0s2b0n0'];
        const mk = n => ['x1000', 'x1000c0', `x1000c0${n.slice(6,8)}`, n.slice(0,11), n];
        const hierarchy = Object.fromEntries(order.map(n => [n, mk(n)]));
        const ss = { nodes: { semantic_type:'categorical', is_list:true,
            category_order: order, category_hierarchy: hierarchy,
            category_levels: ['cabinet','chassis','slot','blade'] } };
        const m = new JSModel({gp_idx, nodes, y, color, cat, fac}, VARS, ss, makeAnywidgetStub());
        // Hovered = node 0 (its own column); partners aggregated onto a frontier
        // where nodes 1 and 2 form one group column.
        const hovered = { key: order[0], lo: 0, hi: 0, is_node: true };
        const frontier = [ hovered, { key: 'grp12', lo: 1, hi: 2, is_node: false } ];
        const res = m.co_occurrence_for_frontier('A', hovered, frontier);
        // node 0's two jobs: job 1 touches node 2 (in grp12); job 2 touches only node 0.
        // So 1 of node 0's 2 jobs co-occurs with grp12 => strength 0.5.
        const byKey = Object.fromEntries(res.map(d => [d.key, d.strength]));
        assert.ok(Math.abs(byKey['grp12'] - 0.5) < 1e-9);
    });

    it('co_occurrence_for_frontier works on threshold-keyed detail columns (arc regression)', () => {
        // The rendered detail columns carry `threshold` (not `key`); the
        // projection must still resolve partners, else hover draws no arcs/bars.
        const { data, ss } = makeFleet();
        const m = new JSModel(data, VARS, ss, makeAnywidgetStub());
        // Force a multi-node job spanning two distant nodes so a partner exists.
        // (makeFleet jobs are single-node, so build a tiny dedicated fixture.)
        const nodes = {0:['x1000c0s0b0n0','x1000c0s4b0n0'], 1:['x1000c0s0b0n0'], 2:['x1000c0s4b0n0']};
        const gp_idx = {0:1,1:2,2:3}, y={0:1,1:2,2:3}, color={0:1,1:2,2:3}, cat={0:'r',1:'g',2:'r'}, fac={0:'A',1:'A',2:'A'};
        const order = ['x1000c0s0b0n0','x1000c0s4b0n0'];
        const mk = n => ['x1000','x1000c0',n.slice(0,9),n.slice(0,11),n];
        const hierarchy = Object.fromEntries(order.map(n => [n, mk(n)]));
        const ss2 = { nodes: { semantic_type:'categorical', is_list:true,
            category_order: order, category_hierarchy: hierarchy,
            category_levels: ['cabinet','chassis','slot','blade'] } };
        const m2 = new JSModel({gp_idx, nodes, y, color, cat, fac}, VARS, ss2, makeAnywidgetStub());
        const cols = m2.current_detail_columns('A');           // threshold-keyed, no `key`
        assert.ok(cols.every(c => c.key === undefined && c.threshold != null));
        const hovered = cols.find(c => c.threshold === order[0]);
        const res = m2.co_occurrence_for_frontier('A', hovered, cols);
        const byKey = Object.fromEntries(res.map(d => [d.key, d.strength]));
        // node 0's 2 jobs; 1 also touches the far node => strength 0.5 onto its column.
        assert.ok(Math.abs(byKey[order[1]] - 0.5) < 1e-9, 'partner resolved on threshold-keyed columns');
    });

    it('co_occurrence_fleet returns partners regardless of the detail window (incl. out-of-range)', () => {
        // node 0 (first) co-occurs with node 2 (last). Even after zooming the
        // detail to node 0 only, the fleet co-occurrence still surfaces node 2.
        const nodes = {0:['x1000c0s0b0n0','x1000c0s2b0n0'], 1:['x1000c0s0b0n0'], 2:['x1000c0s1b0n0'], 3:['x1000c0s2b0n0']};
        const gp_idx = {0:1, 1:2, 2:3, 3:4};
        const y = {0:1,1:2,2:3,3:4}, color = {0:1,1:2,2:3,3:4}, cat = {0:'r',1:'g',2:'r',3:'g'}, fac = {0:'A',1:'A',2:'A',3:'A'};
        const order = ['x1000c0s0b0n0','x1000c0s1b0n0','x1000c0s2b0n0'];
        const mk = n => ['x1000', 'x1000c0', `x1000c0${n.slice(6,8)}`, n.slice(0,11), n];
        const hierarchy = Object.fromEntries(order.map(n => [n, mk(n)]));
        const ss = { nodes: { semantic_type:'categorical', is_list:true,
            category_order: order, category_hierarchy: hierarchy,
            category_levels: ['cabinet','chassis','slot','blade'] } };
        const m = new JSModel({gp_idx, nodes, y, color, cat, fac}, VARS, ss, makeAnywidgetStub());
        m.detail_range.A = [0, 0];                       // zoom to just node 0
        const fleet = m.co_occurrence_fleet('A', order[0]);
        const byNode = Object.fromEntries(fleet.map(d => [d.node, d.strength]));
        // node 0's partner (the out-of-window last node) still appears at strength 0.5.
        assert.ok(Math.abs(byNode[order[2]] - 0.5) < 1e-9);
    });

    it('co_occurrence_fleet_range projects a group/range reach independent of the zoom', () => {
        // A job on node 0 also touches node 2 (far). Pinning the blade [0,1] and
        // zooming the detail elsewhere, the range reach still surfaces node 2.
        const nodes = {0:['x1000c0s0b0n0','x1000c0s2b0n0'], 1:['x1000c0s0b0n1'], 2:['x1000c0s1b0n0'], 3:['x1000c0s2b0n0']};
        const gp_idx = {0:1, 1:2, 2:3, 3:4};
        const y = {0:1,1:2,2:3,3:4}, color = {0:1,1:2,2:3,3:4}, cat = {0:'r',1:'g',2:'r',3:'g'}, fac = {0:'A',1:'A',2:'A',3:'A'};
        const order = ['x1000c0s0b0n0','x1000c0s0b0n1','x1000c0s1b0n0','x1000c0s2b0n0'];
        const mk = n => ['x1000','x1000c0',`x1000c0${n.slice(6,8)}`,n.slice(0,11),n];
        const hierarchy = Object.fromEntries(order.map(n => [n, mk(n)]));
        const ss = { nodes: { semantic_type:'categorical', is_list:true,
            category_order: order, category_hierarchy: hierarchy,
            category_levels: ['cabinet','chassis','slot','blade'] } };
        const m = new JSModel({gp_idx, nodes, y, color, cat, fac}, VARS, ss, makeAnywidgetStub());
        m.detail_range.A = [2, 3];                       // zoomed away from the pinned blade
        const reach = m.co_occurrence_fleet_range('A', 0, 1);   // pinned blade b0 (nodes 0,1)
        const byNode = Object.fromEntries(reach.map(d => [d.node, d.strength]));
        // The blade's 2 distinct jobs (on n0, n1); 1 of them touches node 'x1000c0s2b0n0'.
        assert.ok(Math.abs(byNode['x1000c0s2b0n0'] - 0.5) < 1e-9);
    });

    it('co_occurrence_for_frontier on a range excludes the source region itself', () => {
        // A 2-node blade [0,1]: one job spans its own two nodes (intra-region),
        // another spans node 0 and a far node. Only the far node is a partner.
        const nodes = {0:['x1000c0s0b0n0','x1000c0s0b0n1'], 1:['x1000c0s0b0n0','x1000c0s9b0n0'], 2:['x1000c0s0b0n1']};
        const gp_idx = {0:1,1:2,2:3}, y={0:1,1:2,2:3}, color={0:1,1:2,2:3}, cat={0:'r',1:'g',2:'r'}, fac={0:'A',1:'A',2:'A'};
        const order = ['x1000c0s0b0n0','x1000c0s0b0n1','x1000c0s9b0n0'];
        const mk = n => ['x1000','x1000c0',n.slice(0,9),n.slice(0,11),n];
        const hierarchy = Object.fromEntries(order.map(n => [n, mk(n)]));
        const ss = { nodes: { semantic_type:'categorical', is_list:true,
            category_order: order, category_hierarchy: hierarchy,
            category_levels: ['cabinet','chassis','slot','blade'] } };
        const m = new JSModel({gp_idx, nodes, y, color, cat, fac}, VARS, ss, makeAnywidgetStub());
        const cols = m.current_detail_columns('A');
        const farCol = cols.find(c => c.lo <= 2 && c.hi >= 2);   // column holding node 2
        const res = m.co_occurrence_for_frontier('A', { key: 'blade', lo: 0, hi: 1 }, cols);
        const keys = res.map(d => d.key);
        // The intra-region partner (node 1, within [0,1]) is excluded; the far one is kept.
        assert.ok(keys.includes(String(farCol.threshold)), 'far partner present');
        assert.ok(!keys.includes('x1000c0s0b0n1'), 'no self-arc to a member node');
    });

    it('cell-pin selection resolves against the zoomed detail columns', () => {
        // Zoom to node resolution, then pin a node-resolution cell; selection must
        // resolve via the detail columns (faceted_bins holds the overview keys).
        const { data, ss } = makeFleet();
        const stub = makeAnywidgetStub();
        const m = new JSModel(data, VARS, ss, stub);
        m.detail_range.A = [10, 12];                     // 3 nodes => node resolution
        const cols = m.current_detail_columns('A');
        assert.ok(cols.every(c => c.lo === c.hi));       // individual nodes
        // Pin the first non-empty cell of the first detail column.
        const col = cols[0];
        const row = col.bins.findIndex(b => b.count > 0);
        m.set_pinned_cell_selection('A', [`${col.threshold}|${row}`], []);
        const sel = JSON.parse(stub._state['selected_records']);
        assert.deepStrictEqual([...sel].sort((a,b)=>a-b),
            [...col.bins[row].indices].sort((a,b)=>a-b));
        assert.ok(sel.length > 0);
    });

    it('set_selection_indices sets the selection to an explicit (deduped) gp_idx set', () => {
        // The path cell-pin + box-brush use on a grouped x: indices captured at
        // action time drive the selection (so it persists across zoom).
        const { data, ss } = makeFleet();
        const stub = makeAnywidgetStub();
        const m = new JSModel(data, VARS, ss, stub);
        m.set_selection_indices('A', new Set([5, 5, 9, 2]), []);   // dup 5 collapses
        const sel = JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b);
        assert.deepStrictEqual(sel, [2, 5, 9]);
    });
});

describe('JSModel — color-legend brush selection', () => {
    // Three scalar columns a/b/c, each with a constant color so the cell color
    // (avg) per column is predictable: a=1, b=5, c=9. y varied so cells span
    // two y-bins, but color is constant within a column => any of its cells reads
    // the column's color.
    function fixture(){
        return {
            gp_idx: {0:10,1:11,2:12,3:13,4:14,5:15},
            user:  {0:'a',1:'a',2:'b',3:'b',4:'c',5:'c'},
            y:     {0:2,1:4,2:2,3:4,4:2,5:4},
            color: {0:1,1:1,2:5,3:5,4:9,5:9},
            cat:   {0:'r',1:'g',2:'b',3:'r',4:'g',5:'b'},
            fac:   {0:'A',1:'A',2:'A',3:'A',4:'A',5:'A'},
        };
    }
    const VARS = { facet_by:'fac', x:'user', y:'y', color:'color', color_agg:'avg', categorical:'cat' };
    const SS = { user: { semantic_type:'categorical' } };

    // Independently recompute the expected gp_idx union for cells whose avg is in
    // [lo,hi], from the model's own displayed cells.
    function expected(m, lo, hi){
        const ids = new Set();
        for(const col of m.current_detail_columns('A')){
            for(const cell of col.bins){
                if(!cell.count) continue;
                const v = cell.avg;
                if(v != null && !Number.isNaN(v) && v >= lo && v <= hi){
                    for(const i of cell.indices) ids.add(i);
                }
            }
        }
        return [...ids].sort((a,b)=>a-b);
    }

    it('selects the gp_idx of cells whose color-agg is in the brushed band', () => {
        const stub = makeAnywidgetStub();
        const m = new JSModel(fixture(), VARS, SS, stub);
        m.select_by_color_range('A', 4, 6, []);                    // catches column b (avg 5)
        assert.deepStrictEqual(m.brushed_ranges.A.color_range, [4, 6]);
        const sel = JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b);
        assert.deepStrictEqual(sel, expected(m, 4, 6));
        assert.deepStrictEqual(sel, [12, 13]);                     // b's records
    });

    it('orders the band endpoints; a full band selects every record', () => {
        const stub = makeAnywidgetStub();
        const m = new JSModel(fixture(), VARS, SS, stub);
        m.select_by_color_range('A', 100, 0, []);                  // reversed → [0,100]
        assert.deepStrictEqual(m.brushed_ranges.A.color_range, [0, 100]);
        const sel = JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b);
        assert.deepStrictEqual(sel, [10, 11, 12, 13, 14, 15]);
    });

    it('an empty-overlap band selects nothing', () => {
        const stub = makeAnywidgetStub();
        const m = new JSModel(fixture(), VARS, SS, stub);
        m.select_by_color_range('A', 100, 200, []);
        assert.deepStrictEqual(JSON.parse(stub._state['selected_records']), []);
        assert.deepStrictEqual(m.brushed_ranges.A.color_range, [100, 200]);
    });

    it('a null range clears the color band and the selection', () => {
        const stub = makeAnywidgetStub();
        const m = new JSModel(fixture(), VARS, SS, stub);
        m.select_by_color_range('A', 4, 6, []);
        m.select_by_color_range('A', null, null, []);
        assert.deepStrictEqual(m.brushed_ranges.A.color_range, []);
        assert.deepStrictEqual(JSON.parse(stub._state['selected_records']), []);
    });

    it('set_interaction_mode keeps the color stream (clears only pins)', () => {
        const stub = makeAnywidgetStub();
        const m = new JSModel(fixture(), VARS, SS, stub);
        m.select_by_color_range('A', 4, 6, []);                    // color stream = b's records
        const before = JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b);
        m.set_interaction_mode('cell-pin');                        // default is column-pin
        // Color band + selection persist across a mode switch; only pins clear.
        assert.deepStrictEqual(m.brushed_ranges.A.color_range, [4, 6]);
        assert.deepStrictEqual(JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b), before);
    });
});

describe('JSModel — union selection streams', () => {
    function scalarFixture(){
        return {
            gp_idx:{0:10,1:11,2:12,3:13},
            user:{0:'a',1:'b',2:'c',3:'d'},
            y:{0:1,1:2,2:3,3:4}, color:{0:1,1:2,2:3,3:4},
            cat:{0:'r',1:'g',2:'b',3:'r'}, fac:{0:'A',1:'A',2:'A',3:'A'},
        };
    }
    const SVARS = { facet_by:'fac', x:'user', y:'y', color:'color', color_agg:'avg', categorical:'cat' };
    const SSS = { user:{ semantic_type:'categorical' } };

    it('brushed_data is the deduped UNION of box + pin + color', () => {
        const stub = makeAnywidgetStub();
        const m = new JSModel(scalarFixture(), SVARS, SSS, stub);
        m.set_box_indices('A', new Set([10, 11]), []);
        m.set_pin_indices('A', new Set([11, 12]), []);
        m.set_color_indices('A', new Set([13]), []);
        const sel = JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b);
        assert.deepStrictEqual(sel, [10, 11, 12, 13]);     // 11 appears in box+pin, deduped
    });

    it('clearing one stream leaves the others', () => {
        const stub = makeAnywidgetStub();
        const m = new JSModel(scalarFixture(), SVARS, SSS, stub);
        m.set_box_indices('A', [10, 11], []);
        m.set_color_indices('A', [13], []);
        m.set_color_indices('A', [], []);                  // clear COLOR only
        assert.deepStrictEqual(JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b), [10, 11]);
        m.set_box_indices('A', [], []);                    // clear BOX too
        assert.deepStrictEqual(JSON.parse(stub._state['selected_records']), []);
    });

    it('set_interaction_mode clears the pin stream only (box + color persist)', () => {
        const stub = makeAnywidgetStub();
        const m = new JSModel(scalarFixture(), SVARS, SSS, stub);
        m.set_box_indices('A', [10], []);
        m.set_pin_indices('A', [11], []);
        m.set_color_indices('A', [12], []);
        m.set_interaction_mode('cell-pin');                // default is column-pin
        const sel = JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b);
        assert.deepStrictEqual(sel, [10, 12]);             // pin (11) cleared; box+color kept
    });
});

describe('JSModel — band box brush (2-d ↔ histogram via shared ranges)', () => {
    function grouped(){
        const nodes = {0:['x1000c0s0b0n0'],1:['x1000c0s0b0n1'],2:['x1000c0s1b0n0'],3:['x1000c0s1b0n1']};
        const gp_idx = {0:1,1:2,2:3,3:4}, y = {0:1,1:9,2:1,3:9}, color = {0:1,1:2,2:3,3:4};
        const cat = {0:'r',1:'g',2:'b',3:'r'}, fac = {0:'A',1:'A',2:'A',3:'A'};
        const order = ['x1000c0s0b0n0','x1000c0s0b0n1','x1000c0s1b0n0','x1000c0s1b0n1'];
        const mk = n => ['x1000','x1000c0',n.slice(0,9),n.slice(0,11),n];
        const hierarchy = Object.fromEntries(order.map(n => [n, mk(n)]));
        const ss = { nodes:{ semantic_type:'categorical', is_list:true,
            category_order:order, category_hierarchy:hierarchy,
            category_levels:['cabinet','chassis','slot','blade'] } };
        return { data:{gp_idx,nodes,y,color,cat,fac}, ss };
    }
    const VARS = { facet_by:'fac', x:'nodes', y:'y', color:'color', color_agg:'avg', categorical:'cat' };

    // Recompute the band-box gp_idx independently from the model's displayed cells.
    function bandExpected(m, cr, yr){
        const ids = new Set();
        const cols = m.current_detail_columns('A');
        for(let ci = 0; ci < cols.length; ci++){
            const col = cols[ci];
            let in_col = cr.length !== 2;
            if(cr.length === 2) in_col = col.lo != null ? (col.lo <= cr[1] && col.hi >= cr[0]) : (ci >= cr[0] && ci <= cr[1]);
            if(!in_col) continue;
            for(let row = 0; row < col.bins.length; row++){
                if(yr.length === 2 && !(row >= yr[1] && row < yr[0])) continue;
                const idx = col.bins[row].indices;
                for(let i = 0; i < idx.length; i++) ids.add(idx[i]);
            }
        }
        return [...ids].sort((a,b)=>a-b);
    }

    it('col_range × y_range selects the box cells (deduped) into the box stream', async () => {
        const stub = makeAnywidgetStub();
        const { data, ss } = grouped();
        const m = new JSModel(data, VARS, ss, stub);
        m.brushed_ranges.A.col_range = [0, 1];   // first slot's two nodes
        m.brushed_ranges.A.y_range = [50, 0];    // all rows ([hi, lo] descending)
        await m._apply_brush_selection('A', [], false);
        const sel = JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b);
        assert.deepStrictEqual(sel, bandExpected(m, [0,1], [50,0]));
        assert.deepStrictEqual(sel, [1, 2]);     // records on nodes 0 and 1
    });

    it('a y-only band brush (empty col_range) selects all columns in the y band', async () => {
        const stub = makeAnywidgetStub();
        const { data, ss } = grouped();
        const m = new JSModel(data, VARS, ss, stub);
        m.brushed_ranges.A.col_range = [];
        m.brushed_ranges.A.y_range = [50, 0];    // all rows
        await m._apply_brush_selection('A', [], false);
        const sel = JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b);
        assert.deepStrictEqual(sel, [1, 2, 3, 4]);   // every record
    });

    it('the box stream unions with a pin selection (no overwrite)', async () => {
        const stub = makeAnywidgetStub();
        const { data, ss } = grouped();
        const m = new JSModel(data, VARS, ss, stub);
        m.brushed_ranges.A.col_range = [0, 0];   // node 0 only -> record 1
        m.brushed_ranges.A.y_range = [50, 0];
        await m._apply_brush_selection('A', [], false);
        m.set_pin_indices('A', [4], []);          // pin adds record 4
        const sel = JSON.parse(stub._state['selected_records']).sort((a,b)=>a-b);
        assert.deepStrictEqual(sel, [1, 4]);
    });
});
