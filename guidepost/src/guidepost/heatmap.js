import * as d3 from "https://esm.sh/d3@7";
import { SHARED_X_SCALE, OVERVIEW_LAYOUT, num_rows, X_VARIABLE_OFFSET, Y_VARIABLE_OFFSET, draw_width, MIN_BAR_WIDTH, draw_height, zoom_factor_h, zoom_factor_v, MAX_NODE_LABEL_CHARS, NODE_LABEL_BAND, COUNT_STRIP_HEIGHT, COUNT_STRIP_MARGIN, SHAREDNESS_STRIP_HEIGHT, SHAREDNESS_STRIP_MARGIN, OVERVIEW_STRIP_HEIGHT, OVERVIEW_STRIP_MARGIN, OVERVIEW_BRUSH_MIN_PX, RICH_BLUE, RICH_TAN, RIBBON_COLOR, ICON_ACCENT, ICON_MUTED, SHAREDNESS_BASE } from "./consts";
import { SmartScale } from "./smartscale";

// Max height (px) of the co-occurrence arcs that bow below the sharedness strip.
// The overview strip sits just past this band, so keep it modest to avoid
// pushing the strip too far down the panel.
const ARC_MAX_APEX = 22;

class Heatmap{
    constructor(model, parent, facet, height, width, num_rows){
        // Initialize the Heatmap with model, parent element, facet, height, width, and number of rows
        this.model = model;
        this.parent = parent;
        this.facet = facet;
        this.height = height;
        this.width = width;
        this.view = parent;
        this.num_rows = num_rows;
        this.id_token = `${facet}_heatmap`;
        this.pinned_cols = [];          // column-pin mode: pinned column thresholds
        this.pinned_col_ranges = {};    // key -> {lo,hi} node-index range; pins persist by range across zoom
        this.pinned_cells = new Set();  // cell-pin (non-grouped x): "threshold|row" keys
        this.brushed_cells = null;      // 2D-brush (non-grouped x): covered cell keys
        // Grouped list x: cell-pin + box-brush are stored as node-index regions
        // {lo,hi,row_lo,row_hi,indices} so their highlight + selection persist
        // across zoom (the node range is absolute; indices are captured at action).
        this.pinned_cell_regions = [];  // cell-pin: one region per pinned cell
        this.brushed_region = null;     // 2D-brush: the brushed box region
        this.cell_brush = null;         // d3.brush instance (2D-brush mode)
        this.cached_bins = {};

        this.scale_x = null;
        this.scale_x_utc = null;
        this.scale_y = null;
        this.scale_y_inverse = null;
        this.scale_color = null;

        this.update_scales();
        this.initial_render();
    }

    /**
     * Updates the scales for the heatmap based on the current data state defined by the model.
     */
    update_scales(){
        let sum_stats = this.model.faceted_sum_stats[this.facet];
        // Drop any cached detail-column set — the data/scales are being rebuilt.
        this._cols_cache = null;

        // Categorical x: a d3 band scale keyed by the column names (each column's
        // `.threshold` holds its category/node name). For a grouped list x the
        // columns are the current detail window (whole-fleet overview when no
        // brush is set), so the band auto-scopes to the brushed range with
        // uniform widths. x_is_band routes the positioning accessors down the
        // band path.
        if(this.model.scale_types[this.facet].x.categorical){
            this.x_is_band = true;
            this.scale_x = d3.scaleBand()
                .domain(this.current_columns().map(c => c.threshold))
                .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.width - OVERVIEW_LAYOUT.inner_padding])
                .padding(0.05);
        }
        else if(SHARED_X_SCALE){
            this.x_is_band = false;
            this.scale_x = new SmartScale([this.model.global_sum_stats.x.min, this.model.global_sum_stats.x.max],
                        [OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.width-OVERVIEW_LAYOUT.inner_padding],
                        this.model);
        }
        else{
            this.x_is_band = false;
            this.scale_x = new SmartScale([sum_stats.x.min, sum_stats.x.max],
                        [OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.width-OVERVIEW_LAYOUT.inner_padding],
                        this.model);

        }


        //Determine if y scale is log or linear based on input data
        if(this.model.scale_types[this.facet].y.log){

            this.scale_y = d3.scaleLog()
                            .domain([this.model.log_values_floor, sum_stats.y.max])
                            .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);

            this.scale_y_inverse = d3.scaleLog()
                            .domain([sum_stats.y.max, this.model.log_values_floor])
                            .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);
        }
        else if(this.model.scale_types[this.facet].y.linear){
            this.scale_y = d3.scaleLinear()
                        .domain([sum_stats.y.min, sum_stats.y.max])
                        .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);

            this.scale_y_inverse = d3.scaleLinear()
                        .domain([sum_stats.y.max, sum_stats.y.min])
                        .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);
        }

        if(this.model.vars.color_agg != 'std_ratio'){
            this.scale_color = d3.scaleSequentialSymlog().interpolator(t=>d3.interpolatePurples(t+.2));
            this.scale_color.domain(this.model.color_scale_range);

            this.highlighted_scale_color = d3.scaleSequentialSymlog().interpolator(t=>d3.interpolateOranges(t+.2));
            this.highlighted_scale_color.domain(this.model.color_scale_range);
        }
        else{
            this.scale_color = d3.scaleDiverging().interpolator(t=>d3.interpolateRdYlBu((1-t) - .1));
            this.scale_color.domain([this.model.color_scale_range[0], 1, this.model.color_scale_range[1]]);
        }

        this.scale_y_blocks = d3.scaleLinear()
                        .domain([num_rows-2, -1])
                        .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);

    }

    /**
     * Performs the initial rendering of the heatmap.
     */
    initial_render(){
        const self = this;

        let x_offset = X_VARIABLE_OFFSET + OVERVIEW_LAYOUT.outer_margin;
        let y_offset = Y_VARIABLE_OFFSET + OVERVIEW_LAYOUT.outer_margin;
        
        let view = this.parent.append('g')
                    .attr('class', 'heatmap')
                    .attr('transform', (d, i)=>`translate(${x_offset},${y_offset})`)
                    .attr('width', this.width)
                    .attr('height', this.height);


        let axis_left = d3.axisLeft().scale(this.scale_y_inverse);
        if(this.model.scale_types[this.facet].y.linear){
            axis_left.tickFormat(d3.format(".2s"));
        }

        view.append('g')
            .attr('class', 'left-axis')
            .call(axis_left)   
            .attr('transform', `translate(${OVERVIEW_LAYOUT.inner_padding},${0})`);

        if(this.x_is_band){
            // Thin ticks so labels don't collide at high node cardinality, then
            // rotate (≤45°) and truncate long names.
            const domain = this.scale_x.domain();
            const max_labels = 40;
            const step = Math.max(1, Math.ceil(domain.length / max_labels));
            const tick_vals = domain.filter((d, i) => i % step === 0);
            view.append('g')
                .attr('class', 'bottom-axis')
                .call(d3.axisBottom(this.scale_x).tickValues(tick_vals))
                .attr('transform', `translate(${0},${OVERVIEW_LAYOUT.height-OVERVIEW_LAYOUT.inner_padding})`)
                .selectAll('text')
                    .attr('text-anchor', 'start')
                    .attr('transform', 'rotate(45)')
                    .text(d => (typeof d === 'string' && d.length > MAX_NODE_LABEL_CHARS)
                        ? d.slice(0, MAX_NODE_LABEL_CHARS) + '…'
                        : d);
        }
        else{
            view.append('g')
                .attr('class', 'bottom-axis')
                .call(d3.axisBottom().scale(this.scale_x.scale).ticks(this.scale_x.get_ticks()))
                .attr('transform', `translate(${0},${OVERVIEW_LAYOUT.height-OVERVIEW_LAYOUT.inner_padding})`)
        }

        
        view.append('text')
            .text(`Group: ${this.facet}`)
            .attr('baseline', 'bottom')
            .attr('anchor', 'middle')
            .attr('x', (draw_width)/2)
            .attr('y', OVERVIEW_LAYOUT.inner_padding - 18)
            .style('font-size', '12pt')
            .style('font-weight', 'bold');


        view.append('text')
                .text(()=>{
                    if(this.model.scale_types[this.facet].y.linear){
                        return this.model.vars.y;
                    }
                    return this.model.vars.y+'(log)'
                })
                .attr('text-anchor', 'middle')
                .attr('transform', `translate(${-10},${this.height/2}) rotate(270)`);

        this.view = view;
    }

    /**
     * Draws sparklines (placeholder function).
     * @param {Event} e - The event object.
     * @param {Object} d - The data object.
     */
    draw_sparklines(e, d){
        // console.log(e, d);
    }

    manage_highlight(col_data, row_num){
        const self = this;

        // Cell membership highlight (cell-pin pins + categorical 2D-brush) —
        // works for any x type, independent of the numeric brush ranges below.
        if(self._cell_selected(col_data, row_num)){
            return self.highlighted_scale_color(col_data.bins[row_num][self.model.vars.color_agg]);
        }

        //fill row if only y axis is brushed
        if(self.model.brushed_ranges[self.facet].y_range.length != 0 
            && self.model.brushed_ranges[self.facet].x_range.length == 0){
            if(parseInt(row_num) >= self.model.brushed_ranges[self.facet].y_range[1] 
                && parseInt(row_num) < self.model.brushed_ranges[self.facet].y_range[0]){
                return self.highlighted_scale_color(col_data.bins[row_num][self.model.vars.color_agg]);
            }
        }

        let test_threshold = col_data.threshold;
        if(self.model.scale_types[self.facet].x.datetime){
            test_threshold = new Date(test_threshold);
        }
        //fill columns only if x axis is brushed
        if(self.model.brushed_ranges[self.facet].x_range.length != 0
            && self.model.brushed_ranges[self.facet].y_range.length == 0){
            if(test_threshold >= self.model.brushed_ranges[self.facet].x_range[0] 
                && test_threshold <= self.model.brushed_ranges[self.facet].x_range[1]){
                    return self.highlighted_scale_color(col_data.bins[row_num][self.model.vars.color_agg]);
            }
        }

        else if(self.model.brushed_ranges[self.facet].y_range.length != 0 
            && self.model.brushed_ranges[self.facet].x_range.length != 0){
            if(parseInt(row_num) >= self.model.brushed_ranges[self.facet].y_range[1] 
                && parseInt(row_num) < self.model.brushed_ranges[self.facet].y_range[0]
                && test_threshold >= self.model.brushed_ranges[self.facet].x_range[0] 
                && test_threshold <= self.model.brushed_ranges[self.facet].x_range[1]){
                return self.highlighted_scale_color(col_data.bins[row_num][self.model.vars.color_agg]);
            }
        }


        


        return self.scale_color(col_data.bins[row_num][self.model.vars.color_agg]);
    }

    /**
     * Raises and zooms on a column slightly
     */
    focus_col(update_element){
        let self = this;
        let base_width = self.col_width();
       
        self.scale_y_blocks.range([OVERVIEW_LAYOUT.inner_padding-(zoom_factor_v/2), OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding + (zoom_factor_v/2)]);

        update_element.raise();
        
        update_element.selectAll('.row')
                .attr('width', ()=>{return base_width + zoom_factor_h})
                .attr('height', ()=>{return ( (OVERVIEW_LAYOUT.height + zoom_factor_v) - 2*OVERVIEW_LAYOUT.inner_padding) / self.model.faceted_bins[self.facet].column[0].bins.length})
                .attr('y', (d, i)=>{return self.scale_y_blocks(i) - OVERVIEW_LAYOUT.inner_padding});
            
        update_element.selectAll('.col-bg')
            .attr('width', ()=>{return base_width + zoom_factor_h})
            .attr('height', ()=>{return ( (OVERVIEW_LAYOUT.height + zoom_factor_v) - 2*OVERVIEW_LAYOUT.inner_padding)})
            .attr('y', -(zoom_factor_v/2));
            
    
        update_element.attr('transform', (d)=>{
                return `translate(${self.x_pos(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`;
            });
    }

    /**
     * Resets a column back to original dimensions
     */
    unfocus_col(update_element){
        let self = this;
        let base_width = self.col_width();
       
        self.scale_y_blocks.range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);


        update_element.selectAll('.col-bg')
            .attr('width', base_width)
            .attr('height', ()=>{return draw_height})
            .attr('y', 0);


        update_element.selectAll('.row')  
            .attr('width', base_width)
            .attr('height', (d)=>{return draw_height / self.model.faceted_bins[self.facet].column[0].bins.length})
            .attr('y', (d,i)=>{return self.scale_y_blocks(i) - OVERVIEW_LAYOUT.inner_padding});

        update_element.attr('transform', (d)=>{
                return `translate(${self.x_pos(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`
            });
    }

    /**
     * Formats a number with commas every three digits.
     * @param {number} num - The number to format.
     * @returns {string} - The formatted number.
     */
    format_number_with_commas(num) {
        if (typeof num !== 'number') {
            throw new Error("Input must be a number");
        }
        return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /**
     * Formats the output of Date.toUTCString() to remove the time.
     * @param {Date} date - The date to format.
     * @returns {string} - The formatted date string without the time.
     */
    format_utc_date(date) {
        if (!(date instanceof Date)) {
            throw new Error("Input must be a Date object");
        }
        return date.toUTCString().split(' ').slice(0, 4).join(' ');
    }

    /**
     * Left-edge x coordinate for a column, bridging the categorical (scaleBand,
     * keyed by category name) and continuous (SmartScale, keyed by number/Date)
     * paths. The continuous path preserves the prior string⇒Date assumption.
     */
    x_pos(threshold){
        if(this.x_is_band){
            return this.scale_x(threshold);
        }
        const t = (typeof threshold === 'string') ? new Date(threshold) : threshold;
        return this.scale_x.scale(t);
    }

    /**
     * Per-column width: scaleBand bandwidth for a categorical/grouped band x
     * (uniform — stable, no distortion), otherwise the capped even split the
     * continuous path uses. The optional `threshold` arg is ignored on the band
     * path and kept only so existing call sites read unchanged.
     */
    col_width(threshold){
        if(this.x_is_band){
            return this.scale_x.bandwidth();
        }
        const denom = SHARED_X_SCALE
            ? this.model.global_sum_stats.num_cols
            : this.model.faceted_bins[this.facet].column.length;
        return Math.min(MIN_BAR_WIDTH, (draw_width / denom));
    }

    /**
     * The columns to render. For a grouped list x this is the detail window:
     * `compute_detail_columns` over the brushed node-index range (memoized on
     * the range), or the whole-fleet adaptive overview when no range is set.
     * Scalar categorical / continuous x return the static per-facet columns.
     */
    current_columns(){
        const groups = this.model.faceted_groups && this.model.faceted_groups[this.facet];
        if(groups){
            // Always the detail columns (the full-range default IS the overview),
            // so every rendered column carries lo/hi/level for co-occurrence
            // projection and range pins. Memoize per zoom range so the column
            // join, both strips, _col_center and the reach read one consistent set.
            const range = (this.model.detail_range && this.model.detail_range[this.facet]) || null;
            if(this._cols_cache && this._cols_range === range) return this._cols_cache;
            this._cols_cache = this.model.current_detail_columns(this.facet);
            this._cols_range = range;
            return this._cols_cache;
        }
        return this.model.faceted_bins[this.facet].column;
    }

    /**
     * Visible hover label for a column. Categorical shows the value name and its
     * distinct-record count; continuous keeps the date / numeric-range formatting.
     */
    column_label(data){
        if(this.x_is_band){
            return `${this.model.vars.x}: ${data.threshold} (${data.count} records)`;
        }
        if(this.model.scale_types[this.facet].x.datetime){
            return `${this.format_utc_date(new Date(data.threshold))} (Local: ${new Date(data.threshold).toLocaleDateString()})`;
        }
        const i = this.model.x_axis_thresholds[this.facet].indexOf(data.threshold);
        return `Records for '${this.model.vars.x}' range: (${this.format_number_with_commas(Math.floor(data.threshold))} - ${this.format_number_with_commas(Math.floor(this.model.x_axis_thresholds[this.facet][i+1]))})`;
    }

    /**
     * Renders the heatmap by updating the DOM elements based on the current data.
     */
    render(){
        const self = this;


        let base_width = self.col_width();



        if(self.model.row_major_counts[self.facet].length < 2){
            this.view
                .append('text')
                .text(`There are too few datapoints in this category: ${self.facet}. To remove this chart, please filter this category from the original dataset.`)
                .attr('text-anchor', 'middle')
                .attr('transform', `translate(${draw_width/2},${draw_height/2})`)
        }   
        else{

            this.view
            .selectAll('.column')
            .data(this.current_columns(), d => d.threshold)
            .join(
                function(enter){
                    let col = enter.append('g')
                        .attr('class', 'column')
                        .attr('transform', (d, i)=>{
                            return `translate(${self.x_pos(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`
                        });



                    col.append('rect')
                        .attr('class', 'col-bg')
                        .attr('height', OVERVIEW_LAYOUT.height - 2*OVERVIEW_LAYOUT.inner_padding)
                        .attr('width', d => self.col_width(d.threshold))
                        .attr('fill', '#ffffff');

                    let date  = col.append('g')
                        .attr('class', 'text-field')
                        .attr('transform', `translate(${0}, ${-20})`)
                        .style('visibility', (d)=> self._is_pinned(d) ? 'visible' : 'hidden');
                        
                    date.append('rect')
                        .attr('class', 'text-bg')
                        .attr('height', 15)
                        .attr('width', 150)
                        .attr('fill', 'white');
                        
                    date.append('text')
                        .attr('fill', 'black')
                        .text((data)=> self.column_label(data))
                        .attr('text-anchor', 'middle');

                    col.each(
                        function (column){
                            for(let row in column.bins){
                                const row_idx = row;
                                d3.select(this)
                                    .append('rect')
                                    .attr('class', 'row')
                                    .attr('width', self.col_width(column.threshold))
                                    .attr('height', (d)=>{return draw_height / column.bins.length})
                                    .attr('y', ()=>{return self.scale_y_blocks(row) - OVERVIEW_LAYOUT.inner_padding})
                                    .attr('x', ()=>{return 0})
                                    .attr('fill', (d)=>{
                                        if(column.bins[row].count == 0){
                                            return 'rgba(240,240,240)'
                                        }
                                        // manage_highlight (not plain scale_color) so a
                                        // persisted cell/brush selection shows on freshly
                                        // entered columns after a zoom.
                                        return self.manage_highlight(column, Number(row))
                                    })
                                    // Cell-pin: toggle this (column, row) cell.
                                    .on('click', function(e){
                                        if(self.model.interaction_mode !== 'cell-pin') return;
                                        self.toggle_pinned_cell(column, row_idx);
                                    })
                                    // Cell-pin hover affordance: outline the cell under the pointer.
                                    .on('mouseenter.cellhover', function(){
                                        if(self.model.interaction_mode !== 'cell-pin') return;
                                        self.draw_cell_hover(column, row_idx);
                                    })
                                    .on('mouseleave.cellhover', function(){
                                        self.clear_cell_hover();
                                    })
                            }
                        }
                    )
                    col.on('mouseenter', function (e, d){
                        // 2D-brush mode covers the cells with a brush overlay; no
                        // column hover there.
                        if(self.model.interaction_mode === '2d-brush') return;
                        delete self.cached_bins['hover'];

                        // Lift the whole heatmap group above its siblings (the
                        // legend is a later sibling and otherwise paints its
                        // "Records Selected for Export" text over the hover
                        // label's white background).
                        self.view.raise();

                        // Zoom only in column-pin so cells stay put for precise
                        // clicking in cell-pin mode. Skipped for a grouped list x
                        // (its columns are already a stable zoomable detail band;
                        // the per-column DOM stretch would just add noise).
                        if(self.model.interaction_mode === 'column-pin' && !self._has_grouping()){
                            self.focus_col(d3.select(e.target));
                        }
                        if(!Object.keys(self.cached_bins).includes(String(d.threshold))){
                            let dt_text_selection = d3.select(e.target).select('.text-field');
                            dt_text_selection.style('visibility', 'visible')
                                .select('text')
                                .text((data)=> self.column_label(data));

                            self._fit_text_bg(dt_text_selection);

                            self.cached_bins['hover'] = d.bins
                        }

                        // Hover ribbon (column-pin only): hovered + pinned columns.
                        if(self.model.interaction_mode === 'column-pin'){
                            self.draw_ribbons(String(d.threshold));
                        }

                        self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, self.cached_bins);
                    })
                    .on('mouseleave', function(e,d){
                        if(self.model.interaction_mode === '2d-brush') return;
                        if(!Object.keys(self.cached_bins).includes(String(d.threshold))){
                            if(self.model.interaction_mode === 'column-pin' && !self._has_grouping()){
                                self.unfocus_col(d3.select(e.target));
                            }
                            d3.select(e.target)
                                .select('.text-field')
                                .style('visibility', 'hidden');
                        }

                        delete self.cached_bins['hover'];
                        // Drop the hover ribbon; pinned region ribbons persist.
                        if(self.model.interaction_mode === 'column-pin'){
                            self.draw_ribbons(null);
                        }
                        self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, self.cached_bins);
                    })
                    .on('click', function(e, d){
                        // Column-pin mode only; works for any x type.
                        if(self.model.interaction_mode !== 'column-pin') return;
                        const key = String(d.threshold);
                        // Toggle by RANGE so a click un-pins whichever pinned
                        // region this column falls in — even when the region was
                        // pinned at a different zoom (its key won't match this
                        // column's threshold). Falls back to the key for a
                        // non-grouped x.
                        const existing = d.lo != null
                            ? Object.keys(self.pinned_col_ranges).find(k => {
                                  const r = self.pinned_col_ranges[k];
                                  return d.lo <= r.hi && d.hi >= r.lo;
                              })
                            : (self.pinned_cols.includes(key) ? key : undefined);
                        const pinning = existing === undefined;
                        if(pinning){
                            self.pinned_cols.push(key);
                            self.cached_bins[key] = d.bins;
                            // Capture the node-index range so the pin's selection
                            // and outline survive a re-brush that scrolls/collapses
                            // it out of view (d.lo/d.hi exist on grouped columns).
                            if(d.lo !== undefined) self.pinned_col_ranges[key] = { lo: d.lo, hi: d.hi };
                        } else {
                            self.pinned_cols = self.pinned_cols.filter(item => item !== existing);
                            delete self.cached_bins[existing];
                            delete self.pinned_col_ranges[existing];
                        }

                        // Persist (or clear) the clicked column's label to match.
                        const tf = d3.select(e.target).select('.text-field')
                            .style('visibility', pinning ? 'visible' : 'hidden');
                        tf.select('text').text(self.column_label(d));
                        self._fit_text_bg(tf);

                        // Right histogram reflects pinned (+ hover) columns; the
                        // selection + legend reflect the pinned node records.
                        self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, self.cached_bins);
                        self._sync_pinned_selection();

                        // Persistent ribbons for pinned regions (+ still-hovered one).
                        self.draw_ribbons(key);
                    })
                },
                function(update){
                    update.attr('transform', (d, i)=>{
                            return `translate(${self.x_pos(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`
                        });

                    // Re-apply each column's (and its rows') width on update — the
                    // band width changes when a detail zoom changes the column set.
                    update.select('.col-bg')
                            .attr('width', d => self.col_width(d.threshold))
                            .style('visibility', (d)=>{
                                return 'hidden';
                            })

                    update.select('.text-field')
                            .style('visibility', (d)=> self._is_pinned(d) ? 'visible' : 'hidden')
                            .select('text')
                            .text((d)=> self.column_label(d));

                    //calling this as a .each so that we have access to
                    // column data for each row.
                    //
                    // The fill change here is a STATE replacement (filter,
                    // brush highlight, color-agg change) — not an animation
                    // — so the prior `.transition()` was paying the cost of
                    // ~7,500 transitions per facet on every update without
                    // adding visual value. Direct .attr() is ~5× faster.
                    update.each(
                        function(col_data){
                            const cw = self.col_width(col_data.threshold);
                            d3.select(this).selectAll('.row').each(
                                function(row_data, row_num){
                                    d3.select(this)
                                        .attr('width', cw)
                                        .attr('fill', ()=>{
                                            if(col_data.bins[row_num].count > 0){
                                                return self.manage_highlight(col_data, row_num);
                                            }
                                            else{
                                                return 'rgba(240,240,240)';
                                            }
                                        })
                                }
                            )
            
                            // if(!self.pinned_cols.includes(String(new Date(col_data.threshold)))){
                            //     self.unfocus_col(d3.select(this));
                            // }else{
                            //     self.focus_col(d3.select(this));
                            // }
                    })
                    
                },
                function(end){
                    end.remove();
                }

            );

            if(self.x_is_band){
                self.render_count_strip();
                self.render_sharedness_strip();
                self.render_overflow_note();
                // Persistent full-fleet overview strip + brush (grouped list x).
                if(self._has_grouping()) self.render_overview_strip();
            }
            // Interaction-mode toggle + per-mode overlays apply to every x type.
            self.render_mode_buttons();
            self.apply_interaction_mode();
        }
    }

    /** True when this facet's x is a grouped list x (node hierarchy / chunks) —
     *  the precondition for the overview strip, detail-range zoom, and
     *  range-based pin selection. */
    _has_grouping(){
        return !!(this.model.faceted_groups && this.model.faceted_groups[this.facet]);
    }

    /**
     * Pushes the current pinned-column selection to the model. For a grouped
     * list x a pinned key may be a group at any level or an individual node, and
     * may have scrolled out of the detail window, so we select by the captured
     * node-index ranges; otherwise we select by threshold key.
     */
    _sync_pinned_selection(){
        const target = [`${this.facet}_legend`];
        if(this._has_grouping()){
            this.model.set_pinned_ranges(this.facet, Object.values(this.pinned_col_ranges), target);
        } else {
            this.model.set_pinned_selection(this.facet, this.pinned_cols, target);
        }
    }

    /** Pixel span [x0,x1] shared by the detail band scale, the overview strip,
     *  and the overview brush — the one coordinate basis they must agree on. */
    _strip_x_span(){
        return [OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.width - OVERVIEW_LAYOUT.inner_padding];
    }

    /** Top y of the overview strip (below the count/sharedness strips and the
     *  co-occurrence arc band). */
    _overview_strip_top(){
        // Just past the co-occurrence arc band (which bows ARC_MAX_APEX below the
        // sharedness strip), plus a small margin.
        return this._sharedness_strip_bounds().bottom + ARC_MAX_APEX + OVERVIEW_STRIP_MARGIN;
    }

    /** Band scale over the whole-fleet overview groups (the strip's mini-map).
     *  Domain/range/padding match the heatmap's overview band exactly, so the
     *  strip cells line up 1:1 with the columns and the count/sharedness bars. */
    _strip_band(){
        const agg = this.model.overview_aggregate(this.facet);
        const [x0, x1] = this._strip_x_span();
        return d3.scaleBand().domain(agg.map(g => String(g.key)))
            .range([x0, x1]).padding(0.05);
    }

    /**
     * Renders the persistent full-fleet overview strip: one EQUAL-WIDTH cell per
     * whole-fleet overview-level group (band-aligned with the columns), colored
     * by its sharedness fraction (the "distribution map"), opacity ∝ job count.
     * Carries a brushX that drives the detail heatmap's zoom range; the current
     * detail range is reflected back onto the brush handles.
     */
    render_overview_strip(){
        const self = this;
        const agg = this.model.overview_aggregate(this.facet);
        const band = this._strip_band();
        const top = this._overview_strip_top();
        const h = OVERVIEW_STRIP_HEIGHT;
        const ramp = d3.interpolateLab(SHAREDNESS_BASE, RIBBON_COLOR);
        const max_count = d3.max(agg, d => d.count) || 1;

        let strip = this.view.select('.overview-strip');
        if(strip.empty()){
            strip = this.view.append('g').attr('class', 'overview-strip');
        }
        strip.selectAll('.overview-cell')
            .data(agg, d => d.key)
            .join('rect')
                .attr('class', 'overview-cell')
                .attr('x', d => band(String(d.key)))
                .attr('width', band.bandwidth())
                .attr('y', top)
                .attr('height', h)
                .attr('fill', d => ramp(d.shared_fraction))
                .attr('opacity', d => 0.35 + 0.65 * (d.count / max_count));

        // Strip caption (mirrors the count/sharedness strip label style).
        let label = this.view.select('.overview-strip-label');
        if(label.empty()){
            label = this.view.append('text').attr('class', 'overview-strip-label');
        }
        const [sx0] = this._strip_x_span();
        label.text('Fleet (brush to zoom)')
            .attr('text-anchor', 'start')
            .style('font-size', '8pt')
            .style('fill', '#666')
            .attr('x', sx0)
            .attr('y', top - 3);

        // Brush over the strip; ignores programmatic moves so reflecting the
        // current range doesn't re-fire the end handler.
        const [x0, x1] = this._strip_x_span();
        this.overview_brush = d3.brushX()
            .extent([[x0, top], [x1, top + h]])
            .on('end', function(event){
                if(!event.sourceEvent) return;       // programmatic move — ignore
                self.on_overview_brush_end(event.selection);
            });
        let brush_g = this.view.select('.overview-brush');
        if(brush_g.empty()){
            brush_g = this.view.append('g').attr('class', 'overview-brush');
        }
        brush_g.call(this.overview_brush);

        // Reflect the current detail range as the band span of the groups it covers.
        const range = this.model.detail_range[this.facet];
        const covered = range ? agg.filter(g => g.lo <= range[1] && g.hi >= range[0]) : [];
        if(covered.length){
            const bx0 = band(String(covered[0].key));
            const bx1 = band(String(covered[covered.length - 1].key)) + band.bandwidth();
            brush_g.call(this.overview_brush.move, [bx0, bx1]);
        } else {
            brush_g.call(this.overview_brush.move, null);
        }
    }

    /** Brush-end handler: maps the pixel selection to the overview groups it
     *  covers and zooms the detail heatmap to their node range (or clears the
     *  zoom on an empty/tiny brush). */
    on_overview_brush_end(selection){
        if(!selection || (selection[1] - selection[0]) < OVERVIEW_BRUSH_MIN_PX){
            this.set_detail_range(null);
            return;
        }
        const agg = this.model.overview_aggregate(this.facet);
        const band = this._strip_band();
        const bw = band.bandwidth();
        const covered = agg.filter(g => {
            const gx0 = band(String(g.key));
            return gx0 + bw > selection[0] && gx0 < selection[1];   // band overlaps the brush
        });
        if(!covered.length){ this.set_detail_range(null); return; }
        this.set_detail_range([covered[0].lo, covered[covered.length - 1].hi]);
    }

    /** Sets the detail-zoom node-index range (or null = whole fleet) and
     *  re-renders: rebuild the band domain from the new detail columns, redraw. */
    set_detail_range(range){
        this.model.detail_range[this.facet] = range;
        this._cols_cache = null;
        this.update_scales();
        this.render();
    }

    /**
     * When a categorical/list x had more categories than the column cap, draws a
     * note that the heatmap shows only the most frequent ones. Idempotent: the
     * note is removed when this facet isn't capped.
     */
    render_overflow_note(){
        const overflow = this.model.categorical_overflow[this.facet];
        let note = this.view.select('.overflow-note');
        if(!overflow){
            note.remove();
            return;
        }
        if(note.empty()){
            note = this.view.append('text').attr('class', 'overflow-note');
        }
        // List x is selected by a frequency+association score; plain
        // categoricals by frequency alone.
        const basis = this.model.x_is_list() ? 'frequency & association' : 'frequency';
        note
            .text(`Showing top ${overflow.shown.toLocaleString()} of ${overflow.total.toLocaleString()} categories (by ${basis})`)
            .attr('x', draw_width / 2)
            .attr('y', OVERVIEW_LAYOUT.inner_padding - 4)
            .attr('text-anchor', 'middle')
            .style('font-size', '9pt')
            .style('fill', '#a04040');
    }

    /**
     * Sizes a column's white `.text-bg` rect to exactly cover its label text
     * (plus a small margin) so the hover label stays readable over the heatmap
     * cells behind it. `field` is the `.text-field` <g> selection.
     */
    _fit_text_bg(field){
        const text = field.select('text').node();
        if(!text) return;
        const bb = text.getBBox();
        const margin = 4;
        field.select('.text-bg')
            .attr('x', bb.x - margin)
            .attr('y', bb.y - margin)
            .attr('width', bb.width + 2 * margin)
            .attr('height', bb.height + 2 * margin)
            .attr('transform', null);
    }

    /**
     * Per-value count strip: one bar per column encoding that column's distinct-
     * job count (col.count). Drawn only for a categorical (band) x, in its own
     * <g> below the rotated labels — a sharedness strip stacks beneath it in a
     * later phase.
     */
    render_count_strip(){
        const self = this;
        const columns = this.current_columns();
        // COUNT_STRIP_MARGIN pushes the strip clear of the rotated label band
        // so the bars don't crowd the bottom axis.
        const strip_top = OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding + NODE_LABEL_BAND + COUNT_STRIP_MARGIN;
        const strip_bottom = strip_top + COUNT_STRIP_HEIGHT;
        const max_count = d3.max(columns, c => c.count) || 1;
        const h_scale = d3.scaleLinear().domain([0, max_count]).range([0, COUNT_STRIP_HEIGHT]);

        let strip = this.view.select('.count-strip');
        if(strip.empty()){
            strip = this.view.append('g').attr('class', 'count-strip');
        }
        strip.selectAll('.count-bar')
            .data(columns, d => d.threshold)
            .join('rect')
                .attr('class', 'count-bar')
                .attr('x', d => self.x_pos(d.threshold))
                .attr('width', d => self.col_width(d.threshold))
                .attr('y', d => strip_bottom - h_scale(d.count))
                .attr('height', d => h_scale(d.count))
                .attr('fill', RICH_BLUE);

        // Left axis: lowest (0), midpoint, and highest distinct-job count.
        // Counts are shortened (1-999, 1K-999K, 1M-999M, …) so the labels stay
        // narrow and don't collide with the rotated strip label.
        const short_count = (n) => {
            n = Math.round(n);
            const abs = Math.abs(n);
            if(abs >= 1e9) return `${Math.round(n / 1e9)}B`;
            if(abs >= 1e6) return `${Math.round(n / 1e6)}M`;
            if(abs >= 1e3) return `${Math.round(n / 1e3)}K`;
            return `${n}`;
        };
        // Dedupe so a tiny range (e.g. max_count of 1) doesn't stack two ticks at 0.
        const tick_vals = [...new Set([0, Math.round(max_count / 2), max_count])];
        const axis_scale = d3.scaleLinear().domain([0, max_count]).range([strip_bottom, strip_top]);
        const count_axis = d3.axisLeft(axis_scale).tickValues(tick_vals).tickFormat(short_count);
        let axis_g = this.view.select('.count-strip-axis');
        if(axis_g.empty()){
            axis_g = this.view.append('g').attr('class', 'count-strip-axis');
        }
        axis_g
            .attr('transform', `translate(${OVERVIEW_LAYOUT.inner_padding},${0})`)
            .call(count_axis);

        // Rotated label for the strip, mirroring the y-axis label style. Sits
        // left of the (now shortened) tick numbers so the two don't overlap.
        let label = this.view.select('.count-strip-label');
        if(label.empty()){
            label = this.view.append('text').attr('class', 'count-strip-label');
        }
        label
            .text('Records')
            .attr('text-anchor', 'middle')
            .style('font-size', '8pt')
            .attr('transform', `translate(${OVERVIEW_LAYOUT.inner_padding - 50},${(strip_top + strip_bottom) / 2}) rotate(270)`);
    }

    /** Top/bottom y of the sharedness strip bars (shared by the strip render
     *  and the co-occurrence arcs drawn just below it). */
    _sharedness_strip_bounds(){
        const count_bottom = OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding
            + NODE_LABEL_BAND + COUNT_STRIP_MARGIN + COUNT_STRIP_HEIGHT;
        const top = count_bottom + SHAREDNESS_STRIP_MARGIN;
        return { top, bottom: top + SHAREDNESS_STRIP_HEIGHT };
    }

    /** Horizontal center (px) of a column given its (stringified) threshold key,
     *  resolving back to the original threshold type so x_pos is correct for a
     *  continuous numeric x (where a numeric string would misread as a date). */
    _col_center(key){
        const cols = this.current_columns();
        const col = cols.find(c => String(c.threshold) === String(key));
        return col ? this.x_pos(col.threshold) + this.col_width(col.threshold) / 2 : NaN;
    }

    /**
     * Per-node sharedness strip: one bar per column encoding the fraction of
     * that node's jobs that also ran on ≥1 other node (col.shared_fraction).
     * Only meaningful for a list x — a scalar categorical job sits in exactly
     * one column, so the strip (and its axis/label) are removed for those.
     * Stacks beneath the count strip in its own <g>.
     */
    render_sharedness_strip(){
        const self = this;
        const classes = ['.sharedness-strip', '.sharedness-strip-axis', '.sharedness-strip-label'];
        // Only meaningful when the list x actually has shared records; a scalar
        // categorical or an all-single-valued list column shows no strip.
        if(!this.model.x_has_co_occurrence(this.facet)){
            classes.forEach(c => this.view.select(c).remove());
            return;
        }

        const columns = this.current_columns();
        // Sits one margin below the count strip (which itself sits below the
        // rotated label band).
        const { top: strip_top, bottom: strip_bottom } = this._sharedness_strip_bounds();
        // Fraction domain is fixed [0,1] so heights are comparable across facets.
        const h_scale = d3.scaleLinear().domain([0, 1]).range([0, SHAREDNESS_STRIP_HEIGHT]);

        let strip = this.view.select('.sharedness-strip');
        if(strip.empty()){
            strip = this.view.append('g').attr('class', 'sharedness-strip');
        }
        strip.selectAll('.sharedness-bar')
            .data(columns, d => d.threshold)
            .join('rect')
                .attr('class', 'sharedness-bar')
                .attr('x', d => self.x_pos(d.threshold))
                .attr('width', d => self.col_width(d.threshold))
                .attr('y', d => strip_bottom - h_scale(d.shared_fraction || 0))
                .attr('height', d => h_scale(d.shared_fraction || 0))
                .attr('fill', SHAREDNESS_BASE);

        // Left axis: 0 / 50 / 100 %.
        const axis_scale = d3.scaleLinear().domain([0, 1]).range([strip_bottom, strip_top]);
        const shared_axis = d3.axisLeft(axis_scale).tickValues([0, 0.5, 1]).tickFormat(d3.format('.0%'));
        let axis_g = this.view.select('.sharedness-strip-axis');
        if(axis_g.empty()){
            axis_g = this.view.append('g').attr('class', 'sharedness-strip-axis');
        }
        axis_g
            .attr('transform', `translate(${OVERVIEW_LAYOUT.inner_padding},${0})`)
            .call(shared_axis);

        // Rotated label, matching the count strip's treatment.
        let label = this.view.select('.sharedness-strip-label');
        if(label.empty()){
            label = this.view.append('text').attr('class', 'sharedness-strip-label');
        }
        label
            .text('Shared')
            .attr('text-anchor', 'middle')
            .style('font-size', '8pt')
            .attr('transform', `translate(${OVERVIEW_LAYOUT.inner_padding - 50},${(strip_top + strip_bottom) / 2}) rotate(270)`);
    }

    /**
     * Active co-occurrence sources: every pinned region (kept as a node-index
     * range so it persists across zoom/clip/level changes) plus the optionally
     * hovered column. Each is {key, lo, hi}; lo/hi null only for a non-grouped x.
     */
    _co_sources(hoveredKey){
        const sources = Object.entries(this.pinned_col_ranges)
            .map(([key, r]) => ({ key, lo: r.lo, hi: r.hi }));
        // Non-grouped x (scalar/continuous) keeps pins as threshold keys with no
        // range — include them so their outline persists too.
        for(const key of this.pinned_cols){
            if(this.pinned_col_ranges[key]) continue;     // already added as a range
            sources.push({ key, lo: null, hi: null });
        }
        if(hoveredKey != null){
            const col = this.current_columns().find(c => String(c.threshold) === String(hoveredKey));
            const lo = (col && col.lo != null) ? col.lo : null;
            const hi = (col && col.hi != null) ? col.hi : null;
            const dup = lo != null
                ? sources.some(s => s.lo === lo && s.hi === hi)
                : sources.some(s => String(s.key) === String(hoveredKey));
            if(!dup) sources.push({ key: String(hoveredKey), lo, hi });
        }
        return sources;
    }

    /** True when a rendered column datum lies within any pinned region (by
     *  node-index range, so pins persist across zoom); falls back to the pinned
     *  threshold list for a non-grouped x. */
    _is_pinned(d){
        if(d.lo == null) return this.pinned_cols.includes(String(d.threshold));
        return Object.values(this.pinned_col_ranges).some(r => d.lo <= r.hi && d.hi >= r.lo);
    }

    /** Horizontal center (px) of a source: the midpoint of the visible columns
     *  overlapping its range (or the column itself for a non-grouped x). NaN when
     *  the source isn't currently in view. */
    _range_center(s){
        if(s.lo == null) return this._col_center(s.key);
        let minx = Infinity, maxx = -Infinity;
        for(const c of this.current_columns()){
            if(c.lo == null || c.lo > s.hi || c.hi < s.lo) continue;
            const x = this.x_pos(c.threshold);
            minx = Math.min(minx, x);
            maxx = Math.max(maxx, x + this.col_width(c.threshold));
        }
        return minx === Infinity ? NaN : (minx + maxx) / 2;
    }

    /**
     * Hover/pin affordance: outlines every VISIBLE column that lies in an active
     * source region (pinned ranges persist across zoom; the hovered column is
     * transient), in a raised pointer-events:none overlay. Co-occurrence encoding
     * (bar recolor + arcs + fleet reach) is delegated to render_co_occurrence.
     * `hoveredKey` is the hovered column's threshold, or null for pins only.
     */
    draw_ribbons(hoveredKey){
        let ribbon = this.view.select('.ribbon');
        if(ribbon.empty()){
            ribbon = this.view.append('g').attr('class', 'ribbon').style('pointer-events', 'none');
        }
        ribbon.raise();
        ribbon.selectAll('*').remove();

        const sources = this._co_sources(hoveredKey);
        const ranges = sources.filter(s => s.lo != null);
        const baseline = OVERVIEW_LAYOUT.inner_padding;
        const cell_h = OVERVIEW_LAYOUT.height - 2 * OVERVIEW_LAYOUT.inner_padding;
        for(const col of this.current_columns()){
            const hit = col.lo != null
                ? ranges.some(r => col.lo <= r.hi && col.hi >= r.lo)
                : sources.some(s => String(s.key) === String(col.threshold));
            if(!hit) continue;
            const cw = this.col_width(col.threshold);
            ribbon.append('rect')
                .attr('x', this.x_pos(col.threshold)).attr('y', baseline)
                .attr('width', cw).attr('height', cell_h)
                .attr('fill', 'none').attr('stroke', RIBBON_COLOR).attr('stroke-width', 2);
        }

        // Co-occurrence visuals live below the sharedness strip, not on the cells.
        this.render_co_occurrence(sources);
    }

    /**
     * Co-occurrence encoding for the active sources (pinned regions + hovered
     * column, each a {key, lo, hi} range descriptor): recolors the sharedness
     * bars by co-occurrence strength, draws local arcs between visible columns,
     * and ticks the fleet reach on the overview strip. Range-based so a pinned
     * region keeps its encoding across zoom — bars/arcs when it's in view, reach
     * ticks always. Resets when nothing is active.
     */
    render_co_occurrence(sources){
        let arcs = this.view.select('.co-occ-arcs');
        if(arcs.empty()){
            arcs = this.view.append('g').attr('class', 'co-occ-arcs').style('pointer-events', 'none');
        }
        arcs.raise();
        arcs.selectAll('*').remove();

        const strip = this.view.select('.sharedness-strip');
        sources = sources || [];

        if(!this.model.x_has_co_occurrence(this.facet) || sources.length === 0){
            if(!strip.empty()) strip.selectAll('.sharedness-bar').attr('fill', SHAREDNESS_BASE);
            this.render_overview_reach([]);
            return;
        }

        const frontier = this.current_columns();
        // Partners for a source, projected onto the current columns. A range
        // source uses co_occurrence_for_frontier over its [lo,hi]; a non-grouped
        // source falls back to per-node co-occurrence.
        const partners = (s) => (s.lo != null)
            ? this.model.co_occurrence_for_frontier(this.facet, { key: s.key, lo: s.lo, hi: s.hi }, frontier)
            : this.model.co_occurrence_for(this.facet, s.key).map(d => ({ key: d.node, strength: d.strength }));

        // Strength per current column + which columns are themselves sources.
        const strength_by = new Map();
        for(const s of sources){
            for(const { key, strength } of partners(s)){
                strength_by.set(String(key), Math.max(strength_by.get(String(key)) || 0, strength));
            }
        }
        const ranges = sources.filter(s => s.lo != null);
        const is_source_col = (c) => c.lo != null
            ? ranges.some(r => c.lo <= r.hi && c.hi >= r.lo)
            : sources.some(s => String(s.key) === String(c.threshold));

        // Recolor bars: source → solid accent; co-occurring → ramp by strength.
        const ramp = d3.interpolateLab(SHAREDNESS_BASE, RIBBON_COLOR);
        if(!strip.empty()){
            const by_threshold = new Map(frontier.map(c => [String(c.threshold), c]));
            strip.selectAll('.sharedness-bar').attr('fill', d => {
                const col = by_threshold.get(String(d.threshold));
                if(col && is_source_col(col)) return RIBBON_COLOR;
                const s = strength_by.get(String(d.threshold));
                return s ? ramp(s) : SHAREDNESS_BASE;
            });
        }

        // Arcs from each source's visible center to each partner column center.
        const bottom = this._sharedness_strip_bounds().bottom;
        const max_apex = ARC_MAX_APEX;
        for(const s of sources){
            const hx = this._range_center(s);
            if(!isFinite(hx)) continue;       // source not currently in view
            for(const { key: other, strength } of partners(s)){
                const ox = this._col_center(other);
                if(!isFinite(ox)) continue;
                const span = Math.abs(ox - hx);
                const apex = Math.min(span * 0.5, max_apex);
                const midx = (hx + ox) / 2;
                arcs.append('path')
                    .attr('d', `M${hx},${bottom} Q${midx},${bottom + apex} ${ox},${bottom}`)
                    .attr('fill', 'none')
                    .attr('stroke', RIBBON_COLOR)
                    .attr('stroke-width', 1 + 3 * strength)
                    .attr('stroke-linecap', 'round')
                    .attr('opacity', 0.3 + 0.5 * strength);
            }
        }

        // Fleet-wide reach: tick every co-occurring partner at its TRUE full-fleet
        // position on the overview strip — including partners (and sources) outside
        // the brushed detail window. The spread of these ticks is "how distributed".
        this.render_overview_reach(sources);
    }

    /**
     * Marks, on the overview strip, where across the WHOLE fleet the active
     * (hovered/pinned) sources' jobs co-occur. `sources` are {key, lo, hi}
     * descriptors so the projection is window-independent — a node or a group,
     * in view or scrolled away, still casts its reach. Each partner is a tick at
     * its true fleet position (width/opacity ∝ strength); each source's own
     * node-range is outlined. Cleared when nothing is active.
     */
    render_overview_reach(sources){
        let reach = this.view.select('.overview-reach');
        if(reach.empty()){
            reach = this.view.append('g').attr('class', 'overview-reach').style('pointer-events', 'none');
        }
        reach.raise();
        reach.selectAll('*').remove();
        const ranges = (sources || []).filter(s => s.lo != null);
        if(!this._has_grouping() || ranges.length === 0) return;

        const agg = this.model.overview_aggregate(this.facet);
        const band = this._strip_band();
        const bw = band.bandwidth();
        const name_to_idx = this.model._node_name_index(this.facet);
        const top = this._overview_strip_top();
        const h = OVERVIEW_STRIP_HEIGHT;

        // node index -> {group key, group.lo, group size}, so a node maps to its
        // exact fractional position WITHIN its group's band cell (per-node
        // precision, while the cells stay band-aligned with the columns).
        const node_group = [];
        for(const g of agg){
            const size = g.hi - g.lo + 1;
            for(let i = g.lo; i <= g.hi; i++) node_group[i] = { key: String(g.key), lo: g.lo, size };
        }
        const node_px = (idx) => {
            const ng = node_group[idx];
            if(!ng) return null;
            const gx = band(ng.key);
            return gx == null ? null : gx + ((idx - ng.lo + 0.5) / ng.size) * bw;
        };

        // One tick per co-occurring partner NODE, at its true within-cell position.
        const strength_by = new Map();
        for(const s of ranges){
            for(const { node, strength } of this.model.co_occurrence_fleet_range(this.facet, s.lo, s.hi)){
                const idx = name_to_idx.get(String(node));
                if(idx == null) continue;
                strength_by.set(idx, Math.max(strength_by.get(idx) || 0, strength));
            }
        }
        for(const [idx, strength] of strength_by){
            const x = node_px(idx);
            if(x == null) continue;
            reach.append('line')
                .attr('x1', x).attr('x2', x).attr('y1', top).attr('y2', top + h)
                .attr('stroke', RIBBON_COLOR).attr('stroke-width', 1 + 1.5 * strength)
                .attr('opacity', 0.4 + 0.5 * strength);
        }
        // Outline each source's own region at its exact within-cell extent.
        for(const s of ranges){
            const ng0 = node_group[s.lo], ng1 = node_group[s.hi];
            if(!ng0 || !ng1) continue;
            const bx0 = band(ng0.key) + ((s.lo - ng0.lo) / ng0.size) * bw;
            const bx1 = band(ng1.key) + ((s.hi - ng1.lo + 1) / ng1.size) * bw;
            reach.append('rect')
                .attr('x', bx0).attr('y', top).attr('width', Math.max(1.5, bx1 - bx0)).attr('height', h)
                .attr('fill', 'none').attr('stroke', '#222').attr('stroke-width', 1.5).attr('opacity', 0.9);
        }
    }

    // ---- cell-pin ------------------------------------------------------------

    /** True when (col_data, row_num) is in the current cell-pin or box-brush
     *  selection. Grouped x matches by node-index region (persists across zoom);
     *  other x types match by the "threshold|row" cell key. */
    _cell_selected(col_data, row_num){
        const key = `${col_data.threshold}|${row_num}`;
        if(this.pinned_cells && this.pinned_cells.has(key)) return true;
        if(this.brushed_cells && this.brushed_cells.has(key)) return true;
        if(col_data.lo != null){
            for(const r of this.pinned_cell_regions){
                if(row_num >= r.row_lo && row_num <= r.row_hi
                    && col_data.lo <= r.hi && col_data.hi >= r.lo) return true;
            }
            const br = this.brushed_region;
            if(br && row_num >= br.row_lo && row_num <= br.row_hi
                && col_data.lo <= br.hi && col_data.hi >= br.lo) return true;
        }
        return false;
    }

    /** Toggles a (column, row) cell, updates the selection (union of pinned
     *  cells' records) and re-fills the heatmap highlights. Grouped x toggles a
     *  node-index region (persists across zoom); other x types toggle a cell key. */
    toggle_pinned_cell(col_data, row){
        if(this._has_grouping() && col_data.lo != null){
            const i = this.pinned_cell_regions.findIndex(r =>
                r.row_lo === row && col_data.lo <= r.hi && col_data.hi >= r.lo);
            if(i >= 0){
                this.pinned_cell_regions.splice(i, 1);
            } else {
                this.pinned_cell_regions.push({
                    lo: col_data.lo, hi: col_data.hi, row_lo: row, row_hi: row,
                    indices: col_data.bins[row].indices });
            }
            this._sync_cell_pin_selection();
        } else {
            const key = `${col_data.threshold}|${row}`;
            if(this.pinned_cells.has(key)) this.pinned_cells.delete(key);
            else this.pinned_cells.add(key);
            this.model.set_pinned_cell_selection(this.facet, [...this.pinned_cells],
                [`${this.facet}_legend`]);
        }
        this.refresh_cell_fills();
    }

    /** Pushes the union of pinned-cell-region records to the model (grouped x). */
    _sync_cell_pin_selection(){
        const ids = new Set();
        for(const r of this.pinned_cell_regions){
            const idx = r.indices;
            for(let i = 0; i < idx.length; i++) ids.add(idx[i]);
        }
        this.model.set_selection_indices(this.facet, ids, [`${this.facet}_legend`]);
    }

    /** Cell-pin hover affordance: outlines the cell under the pointer, mirroring
     *  the column-pin hover ribbon. */
    draw_cell_hover(col_data, row){
        let g = this.view.select('.cell-hover');
        if(g.empty()){
            g = this.view.append('g').attr('class', 'cell-hover').style('pointer-events', 'none');
        }
        g.raise();
        g.selectAll('*').remove();
        const nrows = col_data.bins.length || 1;
        g.append('rect')
            .attr('x', this.x_pos(col_data.threshold))
            .attr('y', this.scale_y_blocks(row))
            .attr('width', this.col_width(col_data.threshold))
            .attr('height', draw_height / nrows)
            .attr('fill', 'none').attr('stroke', RIBBON_COLOR).attr('stroke-width', 2);
    }

    clear_cell_hover(){ this.view.select('.cell-hover').selectAll('*').remove(); }

    /** Re-applies manage_highlight to every cell rect without a full re-render. */
    refresh_cell_fills(){
        const self = this;
        this.view.selectAll('.column').each(function(col_data){
            d3.select(this).selectAll('.row').each(function(row_data, row_num){
                d3.select(this).attr('fill', () =>
                    col_data.bins[row_num].count > 0
                        ? self.manage_highlight(col_data, row_num)
                        : 'rgba(240,240,240)');
            });
        });
    }

    // ---- interaction mode + 2D brush ----------------------------------------

    /** Reconciles per-mode overlays with the current model.interaction_mode:
     *  clears the other modes' transient state, draws column ribbons in
     *  column-pin, and attaches/detaches the cell brush in 2d-brush. */
    apply_interaction_mode(){
        const mode = this.model.interaction_mode;
        if(mode !== 'column-pin'){ this.pinned_cols = []; this.pinned_col_ranges = {}; }
        if(mode !== 'cell-pin'){ this.pinned_cells.clear(); this.pinned_cell_regions = []; this.clear_cell_hover(); }
        if(mode !== '2d-brush'){ this.remove_cell_brush(); this.brushed_cells = null; this.brushed_region = null; }

        // Pinned regions persist via pinned_col_ranges; the hover overlay is added
        // separately on mouseenter. (Empty pinned set => clears the overlay.)
        this.draw_ribbons(null);
        if(mode === '2d-brush'){
            this.ensure_cell_brush();
            // Re-render appends the columns AFTER the brush overlay, which would
            // swallow its pointer events — raise it back on top each render.
            this.view.select('.cell-brush').raise();
            this.reflect_cell_brush();
        }
    }

    /** The set of views kept in sync by any brush/selection on this facet. */
    _linked_targets(){
        return [`${this.facet}_heatmap`, `${this.facet}_bottom_histogram`,
                `${this.facet}_right_histogram`, `${this.facet}_legend`];
    }

    /** Attaches a d3.brush over the full cell area (once) for 2D-brush mode. The
     *  extent is the fixed plot rectangle, so it's stable across zoom. */
    ensure_cell_brush(){
        const self = this;
        if(!this.view.select('.cell-brush').empty()) return;
        const [x0, x1] = this._strip_x_span();
        const y0 = OVERVIEW_LAYOUT.inner_padding;
        const y1 = OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding;
        this.cell_brush = d3.brush()
            .extent([[x0, y0], [x1, y1]])
            // Ignore programmatic brush.move (sourceEvent null) so reflecting the
            // brushed region onto this brush can't re-fire the selection loop.
            .on('end', function(event){ if(!event.sourceEvent) return; self.on_cell_brush_end(event.selection); });
        this.view.append('g').attr('class', 'cell-brush').call(this.cell_brush);
    }

    _cell_row_height(cols){
        const nrows = (cols[0] && cols[0].bins.length) || 1;
        return (OVERVIEW_LAYOUT.height - 2 * OVERVIEW_LAYOUT.inner_padding) / nrows;
    }

    /** Re-positions the box brush after a render. Grouped x reflects the brushed
     *  node-index region (so the box re-appears at the zoomed location, or clears
     *  when scrolled out of view); continuous x reflects the shared x/y ranges. */
    reflect_cell_brush(){
        const g = this.view.select('.cell-brush');
        if(g.empty() || !this.cell_brush) return;

        if(this.x_is_band){
            const br = this.brushed_region;
            const cols = this.current_columns();
            const covered = br ? cols.filter(c => c.lo != null && c.lo <= br.hi && c.hi >= br.lo) : [];
            if(!covered.length){ g.call(this.cell_brush.move, null); return; }
            const cw = this.col_width();
            const px0 = Math.min(...covered.map(c => this.x_pos(c.threshold)));
            const px1 = Math.max(...covered.map(c => this.x_pos(c.threshold))) + cw;
            const cell_h = this._cell_row_height(cols);
            const ys = [];
            for(let r = br.row_lo; r <= br.row_hi; r++) ys.push(this.scale_y_blocks(r));
            const py0 = Math.min(...ys), py1 = Math.max(...ys) + cell_h;
            g.call(this.cell_brush.move, [[px0, py0], [px1, py1]]);
            return;
        }

        const xr = this.model.brushed_ranges[this.facet].x_range;
        const yr = this.model.brushed_ranges[this.facet].y_range;
        if(xr.length === 2 && yr.length === 2){
            const px = [this.scale_x.scale(xr[0]), this.scale_x.scale(xr[1])];
            const py = [this.scale_y_blocks(yr[0]), this.scale_y_blocks(yr[1])];
            g.call(this.cell_brush.move, [
                [Math.min(...px), Math.min(...py)],
                [Math.max(...px), Math.max(...py)],
            ]);
        } else {
            g.call(this.cell_brush.move, null);
        }
    }

    remove_cell_brush(){ this.view.select('.cell-brush').remove(); this.cell_brush = null; }

    /** Maps a brushed pixel rectangle to a record selection. Categorical x →
     *  union of covered cells' indices (membership highlight); continuous x →
     *  x-data + y-row ranges reusing the existing brush plumbing. */
    on_cell_brush_end(selection){
        const targets = this._linked_targets();
        if(!selection){
            this.brushed_cells = null;
            this.brushed_region = null;
            this.model.brushed_ranges[this.facet].x_range = [];
            this.model.brushed_ranges[this.facet].y_range = [];
            this.model.brushed_data[this.facet] = new Int32Array(0);
            this.model._finalize_selection(targets, false);
            this.refresh_cell_fills();
            return;
        }
        const [[x0, y0], [x1, y1]] = selection;

        if(this.x_is_band){
            const cols = this.current_columns();   // detail window when zoomed
            const cw = this.col_width();
            const cell_h = this._cell_row_height(cols);
            const grouped = this._has_grouping();
            const ids = new Set();
            const keys = [];
            let lo = Infinity, hi = -Infinity, row_lo = Infinity, row_hi = -Infinity;
            for(const col of cols){
                const cx = this.x_pos(col.threshold);
                if(cx + cw < x0 || cx > x1) continue;
                for(let row = 0; row < col.bins.length; row++){
                    const ry = this.scale_y_blocks(row);
                    if(ry + cell_h < y0 || ry > y1) continue;
                    const idx = col.bins[row].indices;
                    for(let i = 0; i < idx.length; i++) ids.add(idx[i]);
                    if(grouped && col.lo != null){
                        lo = Math.min(lo, col.lo); hi = Math.max(hi, col.hi);
                        row_lo = Math.min(row_lo, row); row_hi = Math.max(row_hi, row);
                    } else {
                        keys.push(`${col.threshold}|${row}`);
                    }
                }
            }
            if(grouped && hi >= 0){
                // Region (node range × y rows) so the box selection persists +
                // re-highlights across zoom; indices captured for the selection.
                this.brushed_region = { lo, hi, row_lo, row_hi, indices: Int32Array.from(ids) };
                this.brushed_cells = null;
                this.model.set_selection_indices(this.facet, ids, targets);
            } else {
                this.brushed_cells = new Set(keys);
                this.brushed_region = null;
                this.model.set_pinned_cell_selection(this.facet, keys, targets);
            }
            this.refresh_cell_fills();
        } else {
            // Continuous: invert pixels to x-data + y-row ranges, reuse the
            // existing X+Y brush compute/highlight.
            const xa = this.scale_x.scale.invert(x0);
            const xb = this.scale_x.scale.invert(x1);
            const x_lo = xa <= xb ? xa : xb;
            const x_hi = xa <= xb ? xb : xa;
            const ra = this.scale_y_blocks.invert(y0);
            const rb = this.scale_y_blocks.invert(y1);
            const hi = Math.max(ra, rb);   // y_range stored descending [high, low]
            const lo = Math.min(ra, rb);
            this.model.brushed_ranges[this.facet].x_range = [x_lo, x_hi];
            this.model.brushed_ranges[this.facet].y_range = [hi, lo];
            this.model._apply_brush_selection(this.facet, targets, false);
        }
    }

    // ---- interaction-mode toggle buttons ------------------------------------

    /** Renders the three square mode buttons (cell-pin / column-pin / 2D-brush)
     *  with distinct SVG glyph icons, top-right of the heatmap. */
    render_mode_buttons(){
        const self = this;
        const modes = [
            { key: 'cell-pin',   draw: (g, s) => self.draw_cell_icon(g, s) },
            { key: 'column-pin', draw: (g, s) => self.draw_column_icon(g, s) },
            { key: '2d-brush',   draw: (g, s) => self.draw_brush_icon(g, s) },
        ];
        const size = 24, gap = 6;
        const total = modes.length * size + (modes.length - 1) * gap;
        const x0 = draw_width - total;            // right-aligned within the plot
        const y0 = OVERVIEW_LAYOUT.inner_padding - size - 6;

        let bar = this.view.select('.mode-bar');
        if(bar.empty()) bar = this.view.append('g').attr('class', 'mode-bar');
        bar.raise();
        bar.selectAll('*').remove();

        modes.forEach((m, i) => {
            const active = self.model.interaction_mode === m.key;
            const g = bar.append('g')
                .attr('class', 'mode-btn')
                .attr('transform', `translate(${x0 + i * (size + gap)},${y0})`)
                .style('cursor', 'pointer')
                .on('click', () => self.model.set_interaction_mode(m.key));
            g.append('rect')
                .attr('width', size).attr('height', size).attr('rx', 4)
                .attr('fill', active ? '#eef0fb' : '#ffffff')
                .attr('stroke', active ? RIBBON_COLOR : '#bbbbbb')
                .attr('stroke-width', active ? 2 : 1);
            const inner = g.append('g').attr('transform', 'translate(4,4)');
            m.draw(inner, size - 8);
        });
    }

    /** 2×2 grid; top-left accent, others muted. Fills the icon area (centered). */
    draw_cell_icon(g, s){
        const gap = s * 0.14;
        const sq = (s - gap) / 2;
        const cells = [[0, 0, ICON_ACCENT], [1, 0, ICON_MUTED], [0, 1, ICON_MUTED], [1, 1, ICON_MUTED]];
        for(const [cx, cy, fill] of cells){
            g.append('rect')
                .attr('x', cx * (sq + gap)).attr('y', cy * (sq + gap))
                .attr('width', sq).attr('height', sq).attr('fill', fill);
        }
    }

    /** Three columns of stacked squares; left column accent, others muted. */
    draw_column_icon(g, s){
        const ncol = 3, nsq = 4, gapx = s * 0.12;
        const colw = (s - (ncol - 1) * gapx) / ncol;
        const sqh = s / nsq;
        for(let c = 0; c < ncol; c++){
            const fill = c === 0 ? ICON_ACCENT : ICON_MUTED;
            for(let r = 0; r < nsq; r++){
                g.append('rect')
                    .attr('x', c * (colw + gapx)).attr('y', r * sqh)
                    .attr('width', colw).attr('height', sqh - 0.5).attr('fill', fill);
            }
        }
    }

    /** Low-opacity square with a brighter outline + a bold "+" brush cursor. */
    draw_brush_icon(g, s){
        const boxR = s * 0.7;
        g.append('rect')
            .attr('width', boxR).attr('height', boxR)
            .attr('fill', ICON_ACCENT).attr('opacity', 0.25)
            .attr('stroke', RIBBON_COLOR).attr('stroke-width', 1.5);
        // "+" cursor at the bottom-right corner of the box.
        const cx = boxR, cy = boxR, arm = s * 0.22;
        g.append('path')
            .attr('d', `M${cx - arm},${cy} H${cx + arm} M${cx},${cy - arm} V${cy + arm}`)
            .attr('stroke', '#333333').attr('stroke-width', 2.5).attr('stroke-linecap', 'round');
    }

}

export {Heatmap};