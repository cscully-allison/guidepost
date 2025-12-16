//layout vars
export const FACET_LAYOUT = {
    outer_margin: 30
}

export const OVERVIEW_LAYOUT = {
    width: 1000,
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
    inner_padding: 0
}

export const CAT_HISTOGRAM_LAYOUT = {
    width: VERT_HISTOGRAM_LAYOUT.width+20,
    height: HISTOGRAM_LAYOUT.height,
    outer_margin: 0,
    inner_padding: 30,
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
export const HEADER_HEIGHT = 50;

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

export const TAN = 'rgb(215, 194, 191)';
export const RICH_TAN = 'rgb(180, 144, 139)';

export const GUIDEPOST_MAIN_COLOR = '#aec3d1e8'
export const BACKGROUND_COLOR = '#e3e6ebea';

export let draw_width = OVERVIEW_LAYOUT.width-2*OVERVIEW_LAYOUT.inner_padding;
export let draw_height = OVERVIEW_LAYOUT.height - 2*OVERVIEW_LAYOUT.inner_padding;
export let total_hist_height = HISTOGRAM_LAYOUT.height + HISTOGRAM_LAYOUT.outer_margin;
export let zoom_factor_h = 3;
export let zoom_factor_v = 10;
