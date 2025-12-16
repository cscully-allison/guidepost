import * as d3 from "https://esm.sh/d3@7";
import { HISTOGRAM_LAYOUT, SHARED_X_SCALE, OVERVIEW_LAYOUT, X_VARIABLE_OFFSET, Y_VARIABLE_OFFSET, VERT_HISTOGRAM_LAYOUT, num_rows, MIN_BAR_WIDTH, draw_width, TAN, draw_height} from "./consts";
import {SmartScale} from "./smartscale"

class Histogram{
    constructor(model, parent, facet, height, width, orientation){
        // Initialize the Histogram with model, parent element, facet, height, width, and orientation
        this.model = model;
        this.parent = parent;
        this.facet = facet;
        this.height = height;
        this.width = width;
        this.orientation = orientation;
        this.id_token = `${facet}_${orientation}_histogram`;
        this.view = null;
     
        this.scale_y = null;
        this.scale_y_inverse = null;
        this.scale_x_utc = null;

        this.setup_scales();
        this.initial_render();
    }

    /**
     * Performs the initial rendering of the histogram.
     */
    initial_render(){
        const self = this;
        if(this.orientation == 'bottom'){

            let x_offset = X_VARIABLE_OFFSET + HISTOGRAM_LAYOUT.outer_margin;
            let y_offset = Y_VARIABLE_OFFSET + OVERVIEW_LAYOUT.height + HISTOGRAM_LAYOUT.outer_margin;



            //create the histograms
            let h_hist = this.parent.append('g')
                    .attr('class', 'faceted-h-hist')
                    .attr('transform', `translate(${x_offset},${y_offset})`);
            
            h_hist.append('rect')
                        .attr('width', this.width - 2*HISTOGRAM_LAYOUT.inner_padding)
                        .attr('height', this.height - HISTOGRAM_LAYOUT.inner_padding)
                        .attr('fill', 'rgba(240,240,240)')
                        .attr('transform', `translate(${HISTOGRAM_LAYOUT.inner_padding},${0})`);

            
            h_hist.append("g")
                .attr('class', 'bars');

            h_hist.append('g')
                    .attr('class', 'left-axis')
                    .call(d3.axisLeft().scale(this.scale_y_inverse).ticks(5))  
                    .attr('transform', `translate(${HISTOGRAM_LAYOUT.inner_padding},${0})`);

            h_hist.append('g')
                    .attr('class', 'bottom-axis')
                    .call(d3.axisBottom().scale(this.scale_x.scale).ticks(this.scale_x.get_ticks()))  
                    .attr('transform', `translate(${0},${this.height-HISTOGRAM_LAYOUT.inner_padding})`);

            h_hist.append('text')
                    .text(()=>{
                        if(this.model.scale_types[this.facet].x.log){
                            return `${this.model.vars.x}(log)`
                        }
                        return this.model.vars.x
                    })
                    .attr('text-anchor', 'middle')
                    .attr('transform', `translate(${this.width/2},${this.height})`);

            

            this.view = h_hist;
        

            this.brush = d3.brushX()
                .extent([[OVERVIEW_LAYOUT.inner_padding, 0], [OVERVIEW_LAYOUT.width - OVERVIEW_LAYOUT.inner_padding, this.height-HISTOGRAM_LAYOUT.inner_padding]])
                .on("end", function({selection}){
                    let select;
                    if(selection){
                        if(self.model.scale_types[self.facet]['x']['datetime']){
                            select = selection.map(self.scale_x.scale.invert, self.scale_x.scale).map(d3.utcDay.round);
                        }
                        if(self.model.scale_types[self.facet]['x']['log'] || self.model.scale_types[self.facet]['x']['linear']){
                            select = selection.map(self.scale_x.scale.invert, self.scale_x.scale).map((d)=>{return d});
                        }
                    }else{
                        select = [];
                    }
                    self.model.update_subselected_data(self.facet, [`${self.facet}_heatmap`, `${self.facet}_legend`], select, "x");
                });

            h_hist.append("g")
                .attr('class', 'h-brush')
                .call(this.brush);
        } 
        

        else if(this.orientation == 'right'){

            let x_offset = X_VARIABLE_OFFSET + OVERVIEW_LAYOUT.width - 5;
            let y_offset = Y_VARIABLE_OFFSET + VERT_HISTOGRAM_LAYOUT.outer_margin;

            let v_hist = this.parent.append('g')
                .attr('class', 'faceted-v-hist')
                .attr('transform', `translate(${x_offset},${y_offset})`);

            v_hist.append('rect')
                    .attr('width', this.width)
                    .attr('height', this.height - 2*HISTOGRAM_LAYOUT.inner_padding)
                    .attr('fill', 'rgba(240,240,240)')
                    .attr('transform', `translate(${0},${HISTOGRAM_LAYOUT.inner_padding})`);
;
                
            v_hist.append('g')
                .attr('class', 'bot-axis')
                .call(d3.axisBottom().scale(this.scale_x).ticks(5))  
                .attr('transform', `translate(${VERT_HISTOGRAM_LAYOUT.inner_padding*4},${VERT_HISTOGRAM_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding})`);

            v_hist.append('g')
                    .attr('class', 'left-axis')
                    .call(d3.axisRight().scale(this.axis_scale_y_inverse))  
                    .attr('transform', `translate(${self.width-VERT_HISTOGRAM_LAYOUT.inner_padding},${0})`);

            this.brush = d3.brushY()
                .extent([[0, HISTOGRAM_LAYOUT.inner_padding], [this.width, this.height - OVERVIEW_LAYOUT.inner_padding]])
                .on("end", function({selection}){
                    let select;
                    if(selection){
                        select = selection.map(self.scale_y.invert, self.scale_y).map((d)=>{return d+0.1})
                    }else{
                        select = [];
                    }
                    self.model.update_subselected_data(self.facet, [`${self.facet}_heatmap`, `${self.facet}_legend`], select, "y");
                });

            
            v_hist.append("g")
                .attr('class', 'bars');

            v_hist.append("g")
                .attr('class', 'v-brush')
                .call(this.brush);

            this.view = v_hist;
        }



    }

    /**
     * Sets up the scales for the histogram based on the current data.
     */
    setup_scales(){
        let sum_stats = this.model.faceted_sum_stats[this.facet];

        if(this.orientation == 'bottom'){
            this.scale_y = d3.scaleLinear()
                                .domain([0, sum_stats.col_counts.max])
                                .range([0, this.height - HISTOGRAM_LAYOUT.inner_padding]);
            
            this.scale_y_inverse = d3.scaleLinear()
                                        .domain([sum_stats.col_counts.max, 0])
                                        .range([0, this.height - HISTOGRAM_LAYOUT.inner_padding]);

            //references OVERVIEW LAYOUT SIZES
            //BE CAREFUL
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
            
        }
        
        else if(this.orientation == 'right'){

            if(this.model.is_more_than_n_orders_of_magnitude(0, Math.max(...this.model.row_major_counts[this.facet]), 3)){
                let local_log_floor = 0.3
                this.scale_x = d3.scaleLog()
                                    .domain([local_log_floor, Math.max(...this.model.row_major_counts[this.facet])])
                                    .range([0, VERT_HISTOGRAM_LAYOUT.width - VERT_HISTOGRAM_LAYOUT.inner_padding]);
            }else{
                this.scale_x = d3.scaleLinear() 
                                    .domain([0, Math.max(...this.model.row_major_counts[this.facet])])
                                    .range([0, VERT_HISTOGRAM_LAYOUT.width - VERT_HISTOGRAM_LAYOUT.inner_padding]);
            }


        if(this.model.scale_types[this.facet].y.log){
            this.axis_scale_y = d3.scaleLog()
                            .domain([this.model.log_values_floor, sum_stats.y.max])
                            .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);

            this.axis_scale_y_inverse = d3.scaleLog()
                            .domain([sum_stats.y.max, this.model.log_values_floor])
                            .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);
        }
        else if(this.model.scale_types[this.facet].y.linear){
            this.axis_scale_y = d3.scaleLinear()
                        .domain([sum_stats.y.min, sum_stats.y.max])
                        .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);

            this.axis_scale_y_inverse = d3.scaleLinear()
                        .domain([sum_stats.y.max, sum_stats.y.min])
                        .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);
        }

        this.scale_y = d3.scaleLinear()
                .domain([num_rows-2, -1])
                .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);

        }
    }

    /**
     * Renders the histogram by updating the DOM elements based on the current data.
     */
    render(){
        const self = this;
        let bar_width = 0;
        let axis_height = 1;

        if(SHARED_X_SCALE){
            bar_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.global_sum_stats.num_cols))
        }
        else{
            bar_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.faceted_bins[self.facet].column.length))
        }
            
        let bar_layer = this.view.select('.bars');

    
        if(self.model.row_major_counts[self.facet].length > 2){
            if(this.orientation == 'bottom'){
                bar_layer.selectAll('.column')
                        .data(self.model.faceted_bins[self.facet].column, function(d){return d.index} )
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
                                    .attr('class', 'bar')
                                    .attr('height', (d)=>{return self.scale_y(d.column_values.length)})
                                    .attr('width', bar_width)
                                    .attr('fill', TAN)
                                    .attr(`transform`, (d)=>{return `translate(${0}, ${(HISTOGRAM_LAYOUT.height- self.scale_y(d.column_values.length))-2*HISTOGRAM_LAYOUT.inner_padding - axis_height})`});
                            },
                            function(update){
                                update.select('.bar')
                                    .transition()
                                    .duration(500)
                                    .attr('height', (d,i)=>{return self.scale_y(self.model.faceted_bins[self.facet].column[i].column_values.length)})
                                    .attr(`transform`, (d, i)=>{return `translate(${0}, ${(HISTOGRAM_LAYOUT.height- self.scale_y(self.model.faceted_bins[self.facet].column[i].column_values.length))-2*HISTOGRAM_LAYOUT.inner_padding - axis_height})`});
                            }
                        );
            }

            if(this.orientation == "right"){
                bar_layer.selectAll('.row')
                    .data(self.model.row_major_counts[self.facet])
                    .join(
                        function(enter){
                            let row = enter.append('g')
                                            .attr('class', 'row')
                                            .attr('transform', (d, i)=>{return `translate(${VERT_HISTOGRAM_LAYOUT.inner_padding},${self.scale_y(i)})`});

                            row.append('rect')
                                .attr('class', 'bar')
                                .attr('width', (d)=>{
                                        return self.scale_x(d) ? self.scale_x(d) : 0;
                                    })
                                .attr('height', (d)=>{return draw_height / self.model.faceted_bins[self.facet].column[0].bins.length})
                                .attr('fill', TAN);
                            
                            return enter;
                        },
                        function(update){
                            update.select('.bar')
                                .transition()
                                .attr('width', (d)=>{
                                        return self.scale_x(d) ? self.scale_x(d) : 0;
                                    });
                        },
                        function(exit){
                            exit.remove();
                        }
                    )
            }
        }

    }  
}

export {Histogram};