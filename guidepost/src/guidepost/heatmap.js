import * as d3 from "https://esm.sh/d3@7";
import { SHARED_X_SCALE, OVERVIEW_LAYOUT, num_rows, X_VARIABLE_OFFSET, Y_VARIABLE_OFFSET, draw_width, MIN_BAR_WIDTH, draw_height, zoom_factor_h, zoom_factor_v } from "./consts";
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
        this.pinned_cols = [];
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

        // this.scale_x = d3.scaleBand()
        //                             .domain(this.model.faceted_bins[this.facet].column.keys())
        //                             .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.width - OVERVIEW_LAYOUT.inner_padding]);
        

        if(SHARED_X_SCALE){
            this.scale_x = new SmartScale([this.model.global_sum_stats.x.min, this.model.global_sum_stats.x.max],
                        [OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.width-OVERVIEW_LAYOUT.inner_padding],
                        this.model);
        }
        else{
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

        view.append('g')
            .attr('class', 'bottom-axis')
            .call(d3.axisBottom().scale(this.scale_x.scale).ticks(this.scale_x.get_ticks())) 
            .attr('transform', `translate(${0},${OVERVIEW_LAYOUT.height-OVERVIEW_LAYOUT.inner_padding})`)

        
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
        let base_width;
        if(SHARED_X_SCALE){
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.global_sum_stats.num_cols))
        }
        else{
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.faceted_bins[self.facet].column.length))
        }
       
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
                if(typeof(d.threshold) === 'string'){
                    return `translate(${self.scale_x.scale(new Date(d.threshold))}, ${OVERVIEW_LAYOUT.inner_padding})`
                }
                return `translate(${self.scale_x.scale(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`;
            });
    }

    /**
     * Resets a column back to original dimensions
     */
    unfocus_col(update_element){
        let self = this;
        let base_width;
        if(SHARED_X_SCALE){
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.global_sum_stats.num_cols))
        }
        else{
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.faceted_bins[self.facet].column.length))
        }
       
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
                if(typeof(d.threshold) === "string"){
                    return `translate(${self.scale_x.scale(new Date(d.threshold))}, ${OVERVIEW_LAYOUT.inner_padding})`
                }
                return `translate(${self.scale_x.scale(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`
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
     * Renders the heatmap by updating the DOM elements based on the current data.
     */
    render(){
        const self = this;


        let base_width = 0;
        if(SHARED_X_SCALE){
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.global_sum_stats.num_cols))
        }
        else{
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.faceted_bins[self.facet].column.length))
        }

        

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
                            if(typeof(d.threshold) === 'string'){
                                return `translate(${self.scale_x.scale(new Date(d.threshold))}, ${OVERVIEW_LAYOUT.inner_padding})`
                            }
                            return `translate(${self.scale_x.scale(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`
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
                            if(self.pinned_cols.includes(String(new Date(d.threshold)))){
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
                        .text((data)=>{
                            if(self.model.scale_types[self.facet].x.datetime){
                                return `${self.format_utc_date(new Date(data.threshold))} (Local: ${new Date(data.threshold).toLocaleDateString()})`;
                            }
                            else{
                                let current_threshold_index = self.model.x_axis_thresholds[self.facet].indexOf(data.threshold);
                                return `Records for '${self.model.vars.x}' range: (${self.format_number_with_commas(Math.floor(data.threshold))} - ${self.format_number_with_commas(Math.floor(self.model.x_axis_thresholds[self.facet][current_threshold_index+1]))})`;
                            }
                        })
                        .attr('text-anchor', 'middle');

                    col.each(
                        function (column){
                            for(let row in column.bins){
                                d3.select(this)
                                    .append('rect')
                                    .attr('class', 'row')
                                    .attr('width', base_width)
                                    .attr('height', (d)=>{return draw_height / column.bins.length})
                                    .attr('y', ()=>{return self.scale_y_blocks(row) - OVERVIEW_LAYOUT.inner_padding})
                                    .attr('x', ()=>{return 0})
                                    .attr('fill', (d)=>{
                                        if(column.bins[row].values.length == 0){
                                            return 'rgba(240,240,240)'
                                        }
                                        return self.scale_color(column.bins[row][self.model.vars.color_agg])
                                    })
                            }
                        }
                    )
                    col.on('mouseenter', function (e, d){
                        delete self.cached_bins['hover'];

                        console.log("HOVERING OVER: ", d);

                        self.focus_col(d3.select(e.target));
                        if(!Object.keys(self.cached_bins).includes(String(d.threshold))){
                            let dt_text_selection = d3.select(e.target).select('.text-field');
                            dt_text_selection.style('visibility', 'visible')
                                .select('text')
                                .text((data)=>{
                                    if(self.model.scale_types[self.facet].x.datetime){
                                        return `${self.format_utc_date(new Date(data.threshold))} (Local: ${new Date(data.threshold).toLocaleDateString()})`;
                                    }
                                    else{
                                        let current_threshold_index = self.model.x_axis_thresholds[self.facet].indexOf(data.threshold);
                                        return `Records for '${self.model.vars.x}' range: (${self.format_number_with_commas(Math.floor(data.threshold))} - ${self.format_number_with_commas(Math.floor(self.model.x_axis_thresholds[self.facet][current_threshold_index+1]))})`;
                                    }
                                });

                            d3.select(e.target)
                                .select('.text-bg')
                                .attr('width', ()=>{
                                    return d3.select(e.target).select('.text-field').select('text').node().getBBox().width + 10;
                                }).attr('transform', `translate(${-(d3.select(e.target).select('.text-field').select('text').node().getBBox().width/2)},${0})`)
                            
                            self.cached_bins['hover'] = d.bins
                        }

                        
                        self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, self.cached_bins);
                    })
                    .on('mouseleave', function(e,d){
                        if(!Object.keys(self.cached_bins).includes(String(new Date(d.threshold)))){
                            self.unfocus_col(d3.select(e.target));
                            d3.select(e.target)
                                .select('.text-field')
                                .style('visibility', 'hidden');
                        }
            
                        delete self.cached_bins['hover'];
                        self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, self.cached_bins);
                    })
                    // CUTTING PIN FUNCTIONALITY FOR NOW! Its a QOL Improvement we don't need but may come back later.
                    // .on('click', function(e, d){
                    //     if(self.pinned_cols.includes(String(new Date(d.threshold)))){
                    //         self.pinned_cols = self.pinned_cols.filter((item) => item !== d.threshold);
                    //         delete self.cached_bins[d.threshold];
                    //     }else{
                    //         self.pinned_cols.push(String(new Date(d.threshold)));
                    //         self.cached_bins[String(new Date(d.threshold))] = d.bins;
                    //     }

                    //     if (self.pinned_cols.length == 0){
                    //         self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, {});
                    //     } else {
                    //         self.model.update_subselected_data(self.facet, [`${self.facet}_right_histogram`, `${self.facet}_bottom_histogram`, `${self.facet}_legend`], [], "");
                    //     }

                    // })
                },
                function(update){
                    update.attr('transform', (d, i)=>{
                            if(typeof(d.threshold) === 'string'){
                                return `translate(${self.scale_x.scale(new Date(d.threshold))}, ${OVERVIEW_LAYOUT.inner_padding})`
                            }
                            return `translate(${self.scale_x.scale(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`
                        });

                    update.select('.col-bg')
                            .style('visibility', (d)=>{
                                return 'hidden';
                            })

                    update.select('.text-field')
                            .style('visibility', (d)=>{
                                if(self.pinned_cols.includes(String(new Date(d.threshold)))){
                                    return 'visible';
                                }
                                return 'hidden';
                            })
                            .select('text')
                            .text((d)=>{
                                return `${new Date(d.threshold).toUTCString()} (${new Date(d.threshold).toLocaleDateString()})`;
                            });

                    //calling this as a .each so that we have access to
                    // column data for each row
                    update.each(
                        function(col_data){
                            d3.select(this).selectAll('.row').each(
                                function(row_data, row_num){
                                    d3.select(this)
                                        .transition()
                                        .attr('fill', ()=>{
                                            if(col_data.bins[row_num].values.length > 0){
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
        }
    }


}

export {Heatmap};