const assert = require('assert');
describe('Guidepost Tests', () => {
    let guidepostModule;
    let JSModel, LEGEND_LAYOUT;

    // Dynamically import the ES module before running tests
    before(async () => {
        guidepostModule = await import('../guidepost/guidepost.js');
        console.log('Guidepost module loaded:', guidepostModule);
        JSModel = guidepostModule.JSModel;
        LEGEND_LAYOUT = guidepostModule.LEGEND_LAYOUT;
    });

    it('should have LEGEND_LAYOUT.left_padding equal to 20', () => {
        assert.strictEqual(LEGEND_LAYOUT.left_padding, 20);
    });

    it('should have JSModel defined', () => {
        assert.ok(JSModel);
        assert.strictEqual(typeof JSModel, 'function');
    });

    describe('JSModel methods', () => {
        let model;
        const sampleData = {
            a: {0: 1, 1: 2},
            b: {0: 'x', 1: 'y'},
            facet: {0: 'group1', 1: 'group2'}
        };
        const varSpec = { facet_by: "facet", x: "a", y: "b", color: "facet" };
        const anywidgetStub = {};

        before(() => {
            model = new JSModel(sampleData, varSpec, anywidgetStub);
        });

        it('list_major should convert dictionary to list-major format', () => {
            const dict = {
                col1: {0: 10, 1: 20},
                col2: {0: 'a', 1: 'b'}
            };
            const result = model.list_major(dict);
            assert.strictEqual(result.length, 2);
            // Validate that each record has col1, col2 and index provided
            assert.strictEqual(result[0].col1, 10);
            assert.strictEqual(result[0].col2, 'a');
            assert.ok(result[0].hasOwnProperty("index"));
        });

        it('facet should group records by given column', () => {
            const dataList = [
                {id: 1, group: "A"},
                {id: 2, group: "B"},
                {id: 3, group: "A"}
            ];
            const facets = model.facet(dataList, "group");
            // Assuming Object.groupBy is available in the environment
            assert.ok(facets.A);
            assert.ok(facets.B);
            // Check that group "A" has 2 entries
            assert.strictEqual(facets.A.length, 2);
        });

        it('linearScale should generate an array of numbers with correct spacing', () => {
            const result = model.linearScale(0, 100, 5);
            assert.strictEqual(result.length, 5);
            // First and last elements should match min and max
            assert.strictEqual(result[0], 0);
            assert.strictEqual(result[4], 100);
            // Spacing should be 25
            assert.strictEqual(result[1] - result[0], 25);
        });

        it('logScale should generate an array of positive numbers', () => {
            // Ensure min and max are > 0 for log scale
            const result = model.logScale(1, 1000, 4);
            assert.strictEqual(result.length, 4);
            // Each value should be greater than 0
            result.forEach(value => {
                assert.ok(value > 0);
            });
        });
    });
});