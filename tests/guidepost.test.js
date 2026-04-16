const assert = require('assert');

// JSModel is an ES module that pulls in d3; load it dynamically once for the suite.
let JSModel;

before(async () => {
    ({ JSModel } = await import('../guidepost/src/guidepost/js_model.js'));
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

    it('snapshots original_bins for each facet', () => {
        for(const fac of model.facets){
            assert.strictEqual(typeof model.faceted_states[fac].original_bins, 'string');
            assert.ok(model.faceted_states[fac].original_bins.length > 0);
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
            assert.deepStrictEqual(model.brushed_data.A, []);
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
});
