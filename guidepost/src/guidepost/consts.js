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

export const FACET_LAYOUT = {
    bottom_padding: bottom_padding,
    outer_margin: 30,
    height: OVERVIEW_LAYOUT.height + CAT_HISTOGRAM_LAYOUT.height + (2 * OVERVIEW_LAYOUT.outer_margin) + (2 * CAT_HISTOGRAM_LAYOUT.outer_margin) + bottom_padding
}

export const FULL_SVG_WIDTH = OVERVIEW_LAYOUT.width + (2 * OVERVIEW_LAYOUT.outer_margin) + (VERT_HISTOGRAM_LAYOUT.width+(2*VERT_HISTOGRAM_LAYOUT.outer_margin)) + LEGEND_LAYOUT.width

export const X_VARIABLE_OFFSET = LEGEND_LAYOUT.width;
export const Y_VARIABLE_OFFSET = 0;

export const num_rows = 50;
export const num_cols = 150;

export const MIN_BAR_WIDTH = 45;

export const SHARED_X_SCALE = false

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
                'ordinal'
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

export function load_smart_default_configs(sum_stats){
    return retrieve_options_from_data(sum_stats);
}