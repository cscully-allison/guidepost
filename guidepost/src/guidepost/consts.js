//layout vars


export const OVERVIEW_LAYOUT = {
    width: 900,
    height: 300,
    outer_margin: 10,
    inner_padding: 30
}

export const HISTOGRAM_LAYOUT = {
    width: OVERVIEW_LAYOUT.width,
    height: 100,
    outer_margin: 10,
    inner_padding: 30
}


export const VERT_HISTOGRAM_LAYOUT = {
    width: 200,
    height: OVERVIEW_LAYOUT.height,
    outer_margin: 10,
    right_padding: 30,
    inner_padding: 0
}

export const CAT_HISTOGRAM_LAYOUT = {
    width: VERT_HISTOGRAM_LAYOUT.width,
    height: 175,
    outer_margin: 0,
    inner_padding: 10,
    top_padding: 45,
    left_padding: 0,
    bottom_title_margin: 25
}

export const LEGEND_LAYOUT = {
    width: 100,
    height: OVERVIEW_LAYOUT.height,
    outer_margin: 10,
    inner_padding: 30,
    top_padding: 45,
    left_padding: 20,
    right_padding: 50
}

export const CONFIGURATION_LAYOUT = {
    width: OVERVIEW_LAYOUT.width,
    height: 150
}

export const VIS_HEADER_HEIGHT = 30;
export const HEADER_HEIGHT = 30;
let bottom_padding = 20;

// Reserved vertical space above each facet's plot area, split into two
// non-overlapping bands so the header info no longer collides with the pinned-
// column hover labels (bug 1.a):
//   - HEADER_BAND: group title, "records selected for export", mode toggles
//   - PIN_LABEL_BAND: pinned-column hover labels (rotated for narrow band x)
// Every per-facet view group (heatmap, histograms, barchart, legend) is shifted
// down by TOP_MARGIN as a unit, so row alignment is preserved and the axes/cells
// (which key off OVERVIEW_LAYOUT.inner_padding) are untouched.
export const HEADER_BAND_HEIGHT = 28;
export const PIN_LABEL_BAND_HEIGHT = 34;
export const TOP_MARGIN = HEADER_BAND_HEIGHT + PIN_LABEL_BAND_HEIGHT;

export const FACET_LAYOUT = {
    bottom_padding: bottom_padding,
    outer_margin: 30,
    height: OVERVIEW_LAYOUT.height + CAT_HISTOGRAM_LAYOUT.height + (2 * OVERVIEW_LAYOUT.outer_margin) + (2 * CAT_HISTOGRAM_LAYOUT.outer_margin) + bottom_padding + TOP_MARGIN
}

export const FULL_SVG_WIDTH = OVERVIEW_LAYOUT.width + (2 * OVERVIEW_LAYOUT.outer_margin) + (VERT_HISTOGRAM_LAYOUT.width+(2*VERT_HISTOGRAM_LAYOUT.outer_margin)) + LEGEND_LAYOUT.width

export const X_VARIABLE_OFFSET = LEGEND_LAYOUT.width;
export const Y_VARIABLE_OFFSET = 0;

export const num_rows = 50;
export const num_cols = 150;
export const MAX_CATEGORICAL_COLUMNS = 150;   // cap on columns for a *scalar* categorical x (e.g. JOB_NAME) with no groupable structure; the less-frequent tail is dropped

// Grouping constants for a list-valued (HPC node) x axis. Instead of dropping
// the tail past MAX_CATEGORICAL_COLUMNS, every node is retained and the x axis
// is rendered as a hierarchy of groups (cabinet > chassis > ...). The full fleet
// is always shown as a compact overview strip; brushing it zooms the detail
// heatmap into a node-index range (Overview + Detail navigation).
export const RENDER_NODE_BUDGET = 220;   // max columns rendered at once: the detail view picks the deepest hierarchy level whose group count fits this within the brushed range
export const CHUNK_TARGET_COLS = 120;    // when node names lack a hierarchy (seriation fallback), retain all by chunking the ordered nodes into ~this many synthetic groups

// Overview strip (the persistent full-fleet "distribution map" with a brush that
// drives the detail heatmap's zoom range).
export const OVERVIEW_STRIP_HEIGHT = 34;   // px height of the heat band
export const OVERVIEW_STRIP_MARGIN = 14;   // gap above the strip (below the co-occurrence arcs)
export const OVERVIEW_BRUSH_MIN_PX = 6;    // ignore degenerate brushes narrower than this

// Maximum number of facet panels rendered for a "Group By" column. When the
// grouping column has more distinct values, only the MAX_FACETS largest groups
// (by row count) are drawn; the remainder are summarized in an elision notice.
export const MAX_FACETS = 30;

export const MIN_BAR_WIDTH = 45;

// Categorical x-axis layout. The rotated node labels and the per-node count
// strip live in the vertical space freed by skipping the bottom histogram
// (HISTOGRAM_LAYOUT.height) when x is categorical.
export const MAX_NODE_LABEL_CHARS = 8;   // truncate long node names + ellipsis
export const NODE_LABEL_BAND = 40;       // px reserved below the heatmap for rotated labels
export const COUNT_STRIP_HEIGHT = 30;    // px height of the per-node distinct-count strip
export const COUNT_STRIP_MARGIN = 12;    // gap between the label band and the count strip
export const SHAREDNESS_STRIP_HEIGHT = 30; // px height of the per-node sharedness strip
export const SHAREDNESS_STRIP_MARGIN = 12; // gap between the count strip and the sharedness strip

export const SHARED_X_SCALE = false

// Hover/pin co-occurrence ribbon (arcs + column highlight).
export const RIBBON_COLOR = 'rgb(176, 64, 140)';

// Interaction-mode toggle icons (cell-pin / column-pin / 2D-brush).
export const ICON_ACCENT = '#b8a9d9';   // light, low-saturation purple (active element)
export const ICON_MUTED = '#cfcfcf';    // neutral grey (inactive elements)

// Sharedness strip base color (neutral grey so the co-occurrence ramp toward
// RIBBON_COLOR reads clearly against it).
export const SHAREDNESS_BASE = '#d0d0d0';

// COLORS
export const BLUE = 'rgba(32, 61, 192, 0.7)';
export const RICH_BLUE = 'rgb(32, 61, 192)';

export const TAN = 'rgba(211, 175, 168, 0.86)';
export const RICH_TAN = 'rgba(242, 156, 145, 1)';

export const LIGHT_BLUE = 'rgba(201, 206, 225, 0.87)';
export const DEEP_LIGHT_BLUE = 'rgba(142, 155, 216, 1)';

export const GUIDEPOST_MAIN_COLOR = '#85848de8'
export const BACKGROUND_COLOR = '#e3e6ebea';

export let draw_width = OVERVIEW_LAYOUT.width-2*OVERVIEW_LAYOUT.inner_padding;
export let draw_height = OVERVIEW_LAYOUT.height - 2*OVERVIEW_LAYOUT.inner_padding;
export let total_hist_height = HISTOGRAM_LAYOUT.height + HISTOGRAM_LAYOUT.outer_margin;
export let zoom_factor_h = 3;
export let zoom_factor_v = 10;

export const VALID_CONFIG_FIELDS = [
            {'name':'facet_by', 
             'human_readable': 'Group By', 
             'valid_semantic_data_types':[
                'categorical'
            ],
            'options':[]},
            {'name':'x',
             'human_readable': 'X Axis Variable',
             'valid_semantic_data_types':[
                'continuous',
                'ordinal',
                'categorical'
            ],
            'options':[]},
            {'name':'y', 
             'human_readable': 'Y Axis Variable', 
             'valid_semantic_data_types':[
                'continuous',
                'ordinal'
            ],
            'options':[]},
            {'name':'color', 
             'human_readable': 'Color Variable', 
             'valid_semantic_data_types':[
                'continuous',
                'ordinal'
            ],
            'options':[]},
            {'name':'color_agg', 
             'human_readable': 'Color Aggregation Method', 
             'valid_semantic_data_types':[
                'categorical'
             ],
             'options': [
                'avg',
                'median',
                'max',
                'min',
                'count'
            ]},
            {'name':'categorical',
             'human_readable': 'Categorical Bar Chart', 
             'valid_semantic_data_types':[
                'categorical'
            ],
            'options':[]}
        ]


function retrieve_options_from_data(sum_stats){
        let local_config_fields = JSON.parse(JSON.stringify(VALID_CONFIG_FIELDS));

        let semantic_feature_map = {
        'categorical': [],
        'ordinal':[],
        'continuous': []
        }

        for(let feature in sum_stats){
            semantic_feature_map[sum_stats[feature]['semantic_type']].push(feature)
        }

        for(let config in local_config_fields){
            let potential_options = [];
            if(!local_config_fields[config]['name'].includes('color_agg')){
                for(let dt of local_config_fields[config]['valid_semantic_data_types']){
                    potential_options = potential_options.concat(semantic_feature_map[dt])
                }
                local_config_fields[config]['options'] = potential_options;
            }  
        }

    return local_config_fields;
}

export function load_smart_default_configs(sum_stats, data){
    // Bucket columns by semantic type
    const datetime_cols = [];
    const continuous = [];
    const ordinal = [];
    const categorical = [];
    // Detect datetime via dtype OR by sampling actual values: pandas often
    // loads date columns as object/string, in which case the summary stats
    // call them "categorical" and dtype is "object". We sniff the data to
    // find string columns whose values parse as valid dates (and aren't just
    // numbers, which Date() will happily accept as ms-since-epoch).
    const looks_like_datetime_value = (v) => {
        if(typeof v !== 'string') return false;
        if(/^-?\d+(\.\d+)?$/.test(v.trim())) return false; // pure number
        const t = Date.parse(v);
        return !isNaN(t);
    };
    const is_datetime = (col) => {
        const dt = sum_stats[col]['dtype'] || '';
        if(dt.indexOf('datetime') !== -1) return true;
        if(!data || !data[col]) return false;
        // Sample up to 5 non-null values; require all sampled to look like dates.
        let checked = 0;
        let ok = 0;
        for(const k in data[col]){
            const v = data[col][k];
            if(v == null) continue;
            checked++;
            if(looks_like_datetime_value(v)) ok++;
            if(checked >= 5) break;
        }
        return checked > 0 && ok === checked;
    };
    for(let col in sum_stats){
        const t = sum_stats[col]['semantic_type'];
        if(is_datetime(col)){
            datetime_cols.push(col);
        } else if(t === 'continuous'){
            continuous.push(col);
        } else if(t === 'ordinal'){
            ordinal.push(col);
        } else if(t === 'categorical'){
            categorical.push(col);
        }
    }

    // Categorical ranking: 2 < n_unique < 20, prefer cardinality nearest to 6.
    const categorical_pool = categorical
        .filter(c => {
            const n = sum_stats[c]['n_unique'];
            return n != null && n > 2 && n < 20;
        })
        .sort((a, b) => Math.abs(sum_stats[a]['n_unique'] - 6) - Math.abs(sum_stats[b]['n_unique'] - 6));

    const defaults = { color_agg: 'avg' };
    const used = new Set();
    const take = (pool) => {
        for(const c of pool){
            if(!used.has(c)){
                used.add(c);
                return c;
            }
        }
        return undefined;
    };

    const facet_by = take(categorical_pool);
    if(facet_by !== undefined) defaults['facet_by'] = facet_by;

    const cat_choice = take(categorical_pool);
    if(cat_choice !== undefined) defaults['categorical'] = cat_choice;

    // Per-facet variance check: a numerical column is "good" if at least half
    // of facets have non-trivial variance in it. This filters out columns that
    // are all-zeros (or constant) within each facet — a global std can look
    // healthy even when every facet is flat.
    const eps = 1e-12;
    const has_facet_variance = (col) => {
        if(!data || !facet_by || !data[col] || !data[facet_by]) return true;
        const colvals = data[col];
        const facetvals = data[facet_by];
        const groups = {};
        for(const k in colvals){
            const v = colvals[k];
            if(v == null) continue;
            const f = facetvals[k];
            if(f == null) continue;
            (groups[f] = groups[f] || []).push(typeof v === 'number' ? v : Number(new Date(v)));
        }
        const facet_keys = Object.keys(groups);
        if(facet_keys.length === 0) return false;
        let good = 0;
        for(const f of facet_keys){
            const arr = groups[f];
            if(arr.length < 2) continue;
            const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
            let ss = 0;
            let min = arr[0], max = arr[0];
            for(const v of arr){
                ss += (v - mean) * (v - mean);
                if(v < min) min = v;
                if(v > max) max = v;
            }
            // Reject flat facets directly: if min == max the facet is constant
            // (covers the all-zeros case where CoV is ill-defined).
            if(min === max) continue;
            const std = Math.sqrt(ss / arr.length);
            const denom = Math.max(Math.abs(mean), eps);
            if(std / denom > 1e-6) good++;
        }
        return good >= Math.ceil(facet_keys.length / 2);
    };

    // Numerical ranking: continuous by CoV; ordinal as fallback tier.
    const normalized_var = (col) => {
        const s = sum_stats[col];
        const std = s['std'];
        const mean = s['mean'];
        if(std == null || mean == null) return -Infinity;
        return Math.abs(std) / Math.max(Math.abs(mean), eps);
    };
    const continuous_ranked = continuous.slice().sort((a, b) => normalized_var(b) - normalized_var(a));
    const ordinal_ranked = ordinal.slice().sort((a, b) => {
        const ua = sum_stats[a]['n_unique'] || 0;
        const ub = sum_stats[b]['n_unique'] || 0;
        return ub - ua;
    });
    const numeric_only_pool = continuous_ranked.concat(ordinal_ranked).filter(has_facet_variance);
    const datetime_pool = datetime_cols.filter(has_facet_variance);

    // X-axis: prefer datetime columns, then numeric.
    const x_pool = datetime_pool.concat(numeric_only_pool);
    const x_choice = take(x_pool);
    if(x_choice !== undefined) defaults['x'] = x_choice;

    const y_choice = take(numeric_only_pool);
    if(y_choice !== undefined) defaults['y'] = y_choice;

    const color_choice = take(numeric_only_pool);
    if(color_choice !== undefined) defaults['color'] = color_choice;

    return defaults;
}