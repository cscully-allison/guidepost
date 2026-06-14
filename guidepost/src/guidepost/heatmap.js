import * as d3 from "https://esm.sh/d3@7";
import { SHARED_X_SCALE, OVERVIEW_LAYOUT, num_rows, X_VARIABLE_OFFSET, Y_VARIABLE_OFFSET, draw_width, MIN_BAR_WIDTH, draw_height, zoom_factor_h, zoom_factor_v, MAX_NODE_LABEL_CHARS, NODE_LABEL_BAND, COUNT_STRIP_HEIGHT, COUNT_STRIP_MARGIN, SHAREDNESS_STRIP_HEIGHT, SHAREDNESS_STRIP_MARGIN, RICH_BLUE, RICH_TAN, RIBBON_COLOR, ICON_ACCENT, ICON_MUTED } from "./consts";
import { SmartScale } from "./smartscale";

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
        this.pinned_cells = new Set();  // cell-pin mode: "threshold|row" keys
        this.brushed_cells = null;      // 2D-brush (categorical): covered cell keys
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

        // Categorical x: a d3 band scale keyed by the column names (each column's
        // `.threshold` holds its category/node name). x_is_band routes the
        // positioning accessors below down the band path.
        if(this.model.scale_types[this.facet].x.categorical){
            this.x_is_band = true;
            this.scale_x = d3.scaleBand()
                .domain(this.model.faceted_bins[this.facet].column.map(c => c.threshold))
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
        const cell_key = `${col_data.threshold}|${row_num}`;
        if((self.pinned_cells && self.pinned_cells.has(cell_key))
            || (self.brushed_cells && self.brushed_cells.has(cell_key))){
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
     * Per-column width: scaleBand bandwidth for a categorical x, otherwise the
     * capped even split the continuous path uses.
     */
    col_width(){
        if(this.x_is_band){
            return this.scale_x.bandwidth();
        }
        const denom = SHARED_X_SCALE
            ? this.model.global_sum_stats.num_cols
            : this.model.faceted_bins[this.facet].column.length;
        return Math.min(MIN_BAR_WIDTH, (draw_width / denom));
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
            .data(this.model.faceted_bins[this.facet].column)
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
                        .attr('width', base_width)
                        .attr('fill', '#ffffff');

                    let date  = col.append('g')
                        .attr('class', 'text-field')
                        .attr('transform', `translate(${0}, ${-20})`)
                        .style('visibility', (d)=>{
                            if(self.pinned_cols.includes(String(d.threshold))){
                                return 'visible';
                            }
                            return 'hidden';
                        });
                        
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
                                    .attr('width', base_width)
                                    .attr('height', (d)=>{return draw_height / column.bins.length})
                                    .attr('y', ()=>{return self.scale_y_blocks(row) - OVERVIEW_LAYOUT.inner_padding})
                                    .attr('x', ()=>{return 0})
                                    .attr('fill', (d)=>{
                                        if(column.bins[row].count == 0){
                                            return 'rgba(240,240,240)'
                                        }
                                        return self.scale_color(column.bins[row][self.model.vars.color_agg])
                                    })
                                    // Cell-pin: toggle this (column, row) cell.
                                    .on('click', function(e){
                                        if(self.model.interaction_mode !== 'cell-pin') return;
                                        self.toggle_pinned_cell(column.threshold, row_idx);
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
                        // clicking in cell-pin mode.
                        if(self.model.interaction_mode === 'column-pin'){
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
                            self.draw_ribbons([...new Set([String(d.threshold), ...self.pinned_cols])]);
                        }

                        self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, self.cached_bins);
                    })
                    .on('mouseleave', function(e,d){
                        if(self.model.interaction_mode === '2d-brush') return;
                        if(!Object.keys(self.cached_bins).includes(String(d.threshold))){
                            if(self.model.interaction_mode === 'column-pin'){
                                self.unfocus_col(d3.select(e.target));
                            }
                            d3.select(e.target)
                                .select('.text-field')
                                .style('visibility', 'hidden');
                        }

                        delete self.cached_bins['hover'];
                        // Drop the hover ribbon; pinned column ribbons persist.
                        if(self.model.interaction_mode === 'column-pin'){
                            self.draw_ribbons(self.pinned_cols);
                        }
                        self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, self.cached_bins);
                    })
                    .on('click', function(e, d){
                        // Column-pin mode only; works for any x type.
                        if(self.model.interaction_mode !== 'column-pin') return;
                        const key = String(d.threshold);
                        const pinning = !self.pinned_cols.includes(key);
                        if(pinning){
                            self.pinned_cols.push(key);
                            self.cached_bins[key] = d.bins;
                        } else {
                            self.pinned_cols = self.pinned_cols.filter(item => item !== key);
                            delete self.cached_bins[key];
                        }

                        // Persist (or clear) the clicked column's label to match.
                        const tf = d3.select(e.target).select('.text-field')
                            .style('visibility', pinning ? 'visible' : 'hidden');
                        tf.select('text').text(self.column_label(d));
                        self._fit_text_bg(tf);

                        // Right histogram reflects pinned (+ hover) columns; the
                        // selection + legend reflect the pinned node records.
                        self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, self.cached_bins);
                        self.model.set_pinned_selection(self.facet, self.pinned_cols, [`${self.facet}_legend`]);

                        // Persistent ribbons for pinned nodes (+ still-hovered one).
                        self.draw_ribbons([...new Set([key, ...self.pinned_cols])]);
                    })
                },
                function(update){
                    update.attr('transform', (d, i)=>{
                            return `translate(${self.x_pos(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`
                        });

                    update.select('.col-bg')
                            .style('visibility', (d)=>{
                                return 'hidden';
                            })

                    update.select('.text-field')
                            .style('visibility', (d)=>{
                                if(self.pinned_cols.includes(String(d.threshold))){
                                    return 'visible';
                                }
                                return 'hidden';
                            })
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
                            d3.select(this).selectAll('.row').each(
                                function(row_data, row_num){
                                    d3.select(this)
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
            }
            // Interaction-mode toggle + per-mode overlays apply to every x type.
            self.render_mode_buttons();
            self.apply_interaction_mode();
        }
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
        const columns = this.model.faceted_bins[this.facet].column;
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
            .data(columns)
            .join('rect')
                .attr('class', 'count-bar')
                .attr('x', d => self.x_pos(d.threshold))
                .attr('width', self.col_width())
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

        const columns = this.model.faceted_bins[this.facet].column;
        // Sits one margin below the count strip (which itself sits below the
        // rotated label band).
        const count_bottom = OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding
            + NODE_LABEL_BAND + COUNT_STRIP_MARGIN + COUNT_STRIP_HEIGHT;
        const strip_top = count_bottom + SHAREDNESS_STRIP_MARGIN;
        const strip_bottom = strip_top + SHAREDNESS_STRIP_HEIGHT;
        // Fraction domain is fixed [0,1] so heights are comparable across facets.
        const h_scale = d3.scaleLinear().domain([0, 1]).range([0, SHAREDNESS_STRIP_HEIGHT]);

        let strip = this.view.select('.sharedness-strip');
        if(strip.empty()){
            strip = this.view.append('g').attr('class', 'sharedness-strip');
        }
        strip.selectAll('.sharedness-bar')
            .data(columns)
            .join('rect')
                .attr('class', 'sharedness-bar')
                .attr('x', d => self.x_pos(d.threshold))
                .attr('width', self.col_width())
                .attr('y', d => strip_bottom - h_scale(d.shared_fraction || 0))
                .attr('height', d => h_scale(d.shared_fraction || 0))
                .attr('fill', RICH_TAN);

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
     * Co-occurrence ribbon: for each source node in `nodes`, draws an arc from
     * that column to every co-occurring column (width/opacity ∝ strength) plus a
     * translucent highlight over those columns and an outline on the source.
     * Lives in a raised, pointer-events:none overlay so it never blocks hover.
     * A no-op (cleared) when x has no co-occurrence or `nodes` is empty — so a
     * scalar categorical / all-single-valued list x simply shows nothing.
     */
    draw_ribbons(nodes){
        let ribbon = this.view.select('.ribbon');
        if(ribbon.empty()){
            ribbon = this.view.append('g').attr('class', 'ribbon').style('pointer-events', 'none');
        }
        ribbon.raise();
        ribbon.selectAll('*').remove();

        if(!nodes || nodes.length === 0) return;

        const baseline = OVERVIEW_LAYOUT.inner_padding;
        const cell_h = OVERVIEW_LAYOUT.height - 2 * OVERVIEW_LAYOUT.inner_padding;
        const max_apex = cell_h * 0.6;
        const cw = this.col_width();
        // Resolve a node key (always a String) back to its column's original
        // threshold so x_pos gets the right type — important for continuous x,
        // where x_pos misreads a numeric string as a date.
        const col_by_key = new Map(
            this.model.faceted_bins[this.facet].column.map(c => [String(c.threshold), c]));
        const x_of = (key) => {
            const col = col_by_key.get(String(key));
            return col ? this.x_pos(col.threshold) : NaN;
        };
        const center = (key) => x_of(key) + cw / 2;

        // The source-column outline is a hover/pin affordance drawn for ANY x.
        // Arcs + co-occurring-column highlights are added only when the (list) x
        // actually has co-occurrence.
        const has_co = this.model.x_has_co_occurrence(this.facet);
        const hl = ribbon.append('g').attr('class', 'ribbon-highlights');
        const arcs = ribbon.append('g').attr('class', 'ribbon-arcs');
        const marked = new Set();

        for(const src of nodes){
            const hx = center(src);
            if(!isFinite(hx)) continue;

            // Always outline the hovered/pinned source column once.
            if(!marked.has(String(src))){
                marked.add(String(src));
                hl.append('rect')
                    .attr('x', x_of(src)).attr('y', baseline)
                    .attr('width', cw).attr('height', cell_h)
                    .attr('fill', 'none').attr('stroke', RIBBON_COLOR).attr('stroke-width', 2);
            }

            if(!has_co) continue;
            const co = this.model.co_occurrence_for(this.facet, src);
            for(const { node: other, strength } of co){
                const ox = center(other);
                if(!isFinite(ox)) continue;
                hl.append('rect')
                    .attr('x', x_of(other)).attr('y', baseline)
                    .attr('width', cw).attr('height', cell_h)
                    .attr('fill', RIBBON_COLOR).attr('opacity', 0.08 + 0.22 * strength);

                const span = Math.abs(ox - hx);
                const apex = Math.min(span * 0.5, max_apex);
                const midx = (hx + ox) / 2;
                arcs.append('path')
                    .attr('d', `M${hx},${baseline} Q${midx},${baseline + apex} ${ox},${baseline}`)
                    .attr('fill', 'none')
                    .attr('stroke', RIBBON_COLOR)
                    .attr('stroke-width', 1 + 3 * strength)
                    .attr('stroke-linecap', 'round')
                    .attr('opacity', 0.25 + 0.55 * strength);
            }
        }
    }

    // ---- cell-pin ------------------------------------------------------------

    /** Toggles a (column, row) cell in the cell-pin set, updates the selection
     *  (union of pinned cells' records) and re-fills the heatmap highlights. */
    toggle_pinned_cell(threshold, row){
        const key = `${threshold}|${row}`;
        if(this.pinned_cells.has(key)) this.pinned_cells.delete(key);
        else this.pinned_cells.add(key);
        this.model.set_pinned_cell_selection(this.facet, [...this.pinned_cells],
            [`${this.facet}_legend`]);
        this.refresh_cell_fills();
    }

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
        if(mode !== 'column-pin'){ this.pinned_cols = []; }
        if(mode !== 'cell-pin'){ this.pinned_cells.clear(); }
        if(mode !== '2d-brush'){ this.remove_cell_brush(); this.brushed_cells = null; }

        this.draw_ribbons(mode === 'column-pin' ? this.pinned_cols : []);
        if(mode === '2d-brush'){ this.ensure_cell_brush(); this.reflect_cell_brush(); }
    }

    /** The set of views kept in sync by any brush/selection on this facet. */
    _linked_targets(){
        return [`${this.facet}_heatmap`, `${this.facet}_bottom_histogram`,
                `${this.facet}_right_histogram`, `${this.facet}_legend`];
    }

    /** Attaches a d3.brush over the cell area (once) for 2D-brush mode. */
    ensure_cell_brush(){
        const self = this;
        if(!this.view.select('.cell-brush').empty()) return;
        const cols = this.model.faceted_bins[this.facet].column;
        if(!cols || !cols.length) return;
        const cw = this.col_width();
        const xs = cols.map(c => this.x_pos(c.threshold));
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs) + cw;
        const y0 = OVERVIEW_LAYOUT.inner_padding;
        const y1 = OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding;
        this.cell_brush = d3.brush()
            .extent([[x0, y0], [x1, y1]])
            // Ignore programmatic brush.move (sourceEvent null) so reflecting the
            // shared ranges onto this brush can't re-fire the selection loop.
            .on('end', function(event){ if(!event.sourceEvent) return; self.on_cell_brush_end(event.selection); });
        this.view.append('g').attr('class', 'cell-brush').call(this.cell_brush);
    }

    /** Positions the heatmap box brush from the shared ranges (continuous x).
     *  Categorical uses cell membership, not a range, so it isn't reflected. */
    reflect_cell_brush(){
        const g = this.view.select('.cell-brush');
        if(g.empty() || !this.cell_brush || this.x_is_band) return;
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
        const ip = OVERVIEW_LAYOUT.inner_padding;
        if(!selection){
            this.brushed_cells = null;
            this.model.brushed_ranges[this.facet].x_range = [];
            this.model.brushed_ranges[this.facet].y_range = [];
            this.model.brushed_data[this.facet] = new Int32Array(0);
            this.model._finalize_selection(targets, false);
            this.refresh_cell_fills();
            return;
        }
        const [[x0, y0], [x1, y1]] = selection;

        if(this.x_is_band){
            const cols = this.model.faceted_bins[this.facet].column;
            const cw = this.col_width();
            const cell_h = (OVERVIEW_LAYOUT.height - 2 * ip) / (cols[0] ? cols[0].bins.length : 1);
            const keys = [];
            for(const col of cols){
                const cx = this.x_pos(col.threshold);
                if(cx + cw < x0 || cx > x1) continue;
                for(let row = 0; row < col.bins.length; row++){
                    const ry = this.scale_y_blocks(row);
                    if(ry + cell_h < y0 || ry > y1) continue;
                    keys.push(`${col.threshold}|${row}`);
                }
            }
            this.brushed_cells = new Set(keys);
            this.model.set_pinned_cell_selection(this.facet, keys, targets);
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