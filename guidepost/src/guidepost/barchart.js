import * as d3 from "https://esm.sh/d3@7";
import { CAT_HISTOGRAM_LAYOUT, OVERVIEW_LAYOUT, X_VARIABLE_OFFSET, Y_VARIABLE_OFFSET, HISTOGRAM_LAYOUT, LIGHT_BLUE, DEEP_LIGHT_BLUE } from "./consts";

class CategoricalBarChart{
    constructor(model, parent, facet, height, width, orientation) {
        // Initialize the CategoricalBarChart with model, parent element, facet, height, width, and orientation
        this.model = model;
        this.parent = parent;
        this.facet = facet;
        this.height = height;
        this.width = width;
        this.orientation = orientation;
        this.id_token = `${facet}_${orientation}_histogram`;
        this.n = 10;
        this.view = null;
        
        this.scale_y = null;
        this.scale_y_inverse = null;
        this.scale_x = null;

        this.is_histogram_focused = false;

        this.setup_scales();
        this.initial_render();
    }

    /**
     * Performs the initial rendering of the categorical histogram.
     */
    initial_render(){
        if(this.orientation == 'bottom'){
            
            //create the histograms

            let x_offset = X_VARIABLE_OFFSET + OVERVIEW_LAYOUT.width;
            let y_offset = Y_VARIABLE_OFFSET + CAT_HISTOGRAM_LAYOUT.outer_margin + OVERVIEW_LAYOUT.height ;

            let h_hist = this.parent.append('g')
                    .attr('class', 'faceted-h-hist')
                    .attr('transform', `translate(${x_offset},${y_offset})`);

            h_hist.append('g')
                    .attr('class', 'left-axis')
                    .call(d3.axisLeft().scale(this.scale_y_inverse).ticks(5))  
                    .attr('transform', `translate(${CAT_HISTOGRAM_LAYOUT.inner_padding},${0})`);

            h_hist.append('g')
                    .attr('class', 'bottom-axis')
                    .call(d3.axisBottom().scale(this.scale_x))  
                    .attr('transform', `translate(${0},${this.height-CAT_HISTOGRAM_LAYOUT.inner_padding})`);

            h_hist.select('.bottom-axis')
                    .selectAll('text')
                    .attr('text-anchor', 'start')
                    .attr('transform', 'rotate(35)');

            h_hist.append('text')
                    .text(()=>{
                        if(this.model.categorical_bins[this.facet].length > this.n){
                            return `Top ${this.n} ${this.model.vars.categorical}`;
                        } 
                        return this.model.vars.categorical;
                    })
                    .attr('text-anchor', 'middle')
                    .attr('transform', `translate(${this.width/2},${this.height+CAT_HISTOGRAM_LAYOUT.bottom_title_margin})`);
            

            this.view = h_hist;
        } 

        else if(this.orientation == 'right'){

            let x_offset = X_VARIABLE_OFFSET + OVERVIEW_LAYOUT.width;
            let y_offset = Y_VARIABLE_OFFSET + CAT_HISTOGRAM_LAYOUT.outer_margin + OVERVIEW_LAYOUT.height ;

            let v_hist = this.parent.append('g')
                .attr('class', 'faceted-v-hist')
                .attr('transform', `translate(${x_offset},${y_offset})`);

            v_hist.append('g')
                    .attr('class', 'bars-group');

            v_hist.append('g')
                .attr('class', 'bot-axis')
                .call(d3.axisBottom().scale(this.scale_x).ticks(5))  
                .attr('transform', `translate(${CAT_HISTOGRAM_LAYOUT.inner_padding},${CAT_HISTOGRAM_LAYOUT.height-CAT_HISTOGRAM_LAYOUT.inner_padding})`);

            v_hist.append('g')
                    .attr('class', 'left-axis')
                    .call(d3.axisLeft().scale(this.scale_y))  
                    .attr('transform', `translate(${CAT_HISTOGRAM_LAYOUT.inner_padding},${0})`);

            v_hist.select('.left-axis')
                    .selectAll('text')
                    .attr('text-anchor', 'start')
                    .attr('transform', 'translate(13,0)');

            this.view = v_hist;
        }
    }

    /**
     * Sets up the scales for the categorical histogram based on the current data.
     */
    setup_scales(){
        this.n = Math.min(this.model.categorical_bins[this.facet].length, this.n);
        let top_n_cats = this.model.categorical_bins[this.facet].slice(0,this.n);
        
        this.max_bar_width = 30;
        this.max_bar_height = 30;
        this.drawable_height = (this.height-2*CAT_HISTOGRAM_LAYOUT.inner_padding)+3;
        this.drawable_width = (this.width-2*CAT_HISTOGRAM_LAYOUT.inner_padding);

        this.calc_bar_width = Math.min(this.max_bar_width, this.drawable_width/this.n);
        this.calc_bar_height = Math.min(this.max_bar_height, this.drawable_height/this.n);

        if(this.orientation == 'bottom'){
            if(this.model.is_more_than_n_orders_of_magnitude(0, top_n_cats[0].val, 3)){
                let local_log_floor = 0.3
                this.scale_y = d3.scaleLog()
                                    .domain([local_log_floor, top_n_cats[0].val])
                                    .range([0, this.height - CAT_HISTOGRAM_LAYOUT.inner_padding]);
                
                this.scale_y_inverse = d3.scaleLog()
                                            .domain([top_n_cats[0].val, local_log_floor])
                                            .range([0, this.height - CAT_HISTOGRAM_LAYOUT.inner_padding]);
            }
            else{
                this.scale_y = d3.scaleLinear()
                                    .domain([0, top_n_cats[0].val])
                                    .range([0, this.height - CAT_HISTOGRAM_LAYOUT.inner_padding]);
                
                this.scale_y_inverse = d3.scaleLinear()
                                            .domain([top_n_cats[0].val, 0])
                                            .range([0, this.height - CAT_HISTOGRAM_LAYOUT.inner_padding]);
            }

            this.scale_x = d3.scaleBand()
                            .domain(top_n_cats.map((obj)=>{
                                return obj.key;
                            }))
                            .range([CAT_HISTOGRAM_LAYOUT.inner_padding, this.width - CAT_HISTOGRAM_LAYOUT.inner_padding])
                            .padding(0.1);
        }
        
        else if(this.orientation == 'right'){
            this.scale_y = d3.scaleBand()
                            .domain(top_n_cats.map((obj)=>{
                                return obj.key;
                            }))
                            .range([CAT_HISTOGRAM_LAYOUT.inner_padding, this.height - CAT_HISTOGRAM_LAYOUT.inner_padding])
                            .padding(0.1);

            if(this.model.is_more_than_n_orders_of_magnitude(0, top_n_cats[0].val, 3)){
                let local_log_floor = 0.3
                this.scale_x = d3.scaleLog()
                                    .domain([local_log_floor, top_n_cats[0].val])
                                    .range([0, this.width - CAT_HISTOGRAM_LAYOUT.inner_padding]);
                
                this.scale_x_inverse = d3.scaleLog()
                                            .domain([top_n_cats[0].val, local_log_floor])
                                            .range([0, this.width - CAT_HISTOGRAM_LAYOUT.inner_padding]);
            }
            else{
                this.scale_x = d3.scaleLinear()
                                    .domain([0, top_n_cats[0].val])
                                    .range([0, this.width - CAT_HISTOGRAM_LAYOUT.inner_padding]);
                
                this.scale_x_inverse = d3.scaleLinear()
                                            .domain([top_n_cats[0].val, 0])
                                            .range([0, this.width - CAT_HISTOGRAM_LAYOUT.inner_padding]);
            }

        }
    }

    /**
     * Renders the categorical histogram by updating the DOM elements based on the current data.
     */
    render(){

        const self = this;
        let top_n_cats = this.model.categorical_bins[this.facet].slice(0,this.n);
        let update_targets = [`${this.facet}_heatmap`, `${this.facet}_right_histogram`, `${this.facet}_bottom_histogram`, `${this.facet}_legend`];

        if(self.model.row_major_counts[self.facet].length > 2){

            if(this.orientation == 'bottom'){
                //make sure re-renders to unfiltered data updates happen
                // only when the mouse leaves the histogram
                this.view.on('mouseleave', function(e,d){
                    self.model.filter_data_by_category([], self.facet, this.id_token, update_targets);
                });

                this.view.selectAll('.column')
                        .data(top_n_cats)
                        .join(
                            function(enter){
                                let col = enter.append('g')
                                                .attr('class', 'column')
                                                .attr('transform', (d, i)=>{
                                                        const tickPos = self.scale_x(d.key);
                                                        const bandWidth = self.scale_x.bandwidth();
                                                        // Center bar if calc_bar_width < bandWidth
                                                        const offset = (bandWidth - self.calc_bar_width) / 2;
                                                        return `translate(${tickPos + offset}, ${CAT_HISTOGRAM_LAYOUT.inner_padding})`;
                                                });

                                col.append('rect')
                                    .attr('class', 'bar')
                                    .attr('height', (d)=>{return self.scale_y(d.val)})
                                    // .attr('width', (d)=>{return ((HISTOGRAM_LAYOUT.width - 2*HISTOGRAM_LAYOUT.inner_padding) / faceted_bins[d.facet].x.length)})
                                    .attr('width', self.calc_bar_width)
                                    .attr('fill', LIGHT_BLUE)
                                    .attr(`transform`, (d)=>{return `translate(${0}, ${(CAT_HISTOGRAM_LAYOUT.height- self.scale_y(d.val))-2*CAT_HISTOGRAM_LAYOUT.inner_padding})`})
                                    .on('mouseover', function (e,d){
                                        d3.select(this).attr('fill', DEEP_LIGHT_BLUE);
                                        self.model.filter_data_by_category([d.key], self.facet, self.id_token, update_targets);
                                        // self.model.update_row_counts(self.token, `${self.facet}_right_histogram`, self.facet, []);
                                    })
                                    .on('mouseout', function (e,d){
                                        if(!self.model.is_category_pinned(self.facet, d.key)){
                                            d3.select(this).attr('fill', LIGHT_BLUE);
                                        }

                                    })
                                    .on('click', function(e,d){
                                        self.model.pin_unpin_clicked_category(self.id_token, self.facet, d.key);
                                    });
                            }
                        );
            }


            if(this.orientation == "right"){
            //make sure re-renders to unfiltered data updates happen
                // only when the mouse leaves the histogram
                this.view.on('mouseleave', function(e,d){
                    self.model.filter_data_by_category([], self.facet, this.id_token, update_targets);
                });

                this.view.select('.bars-group')
                        .selectAll('.row')
                        .data(top_n_cats)
                        .join(
                            function(enter){
                                let col = enter.append('g')
                                                .attr('class', 'row')
                                                .attr('transform', (d, i)=>{
                                                        const tickPos = self.scale_y(d.key);
                                                        const bandWidth = self.scale_y.bandwidth();
                                                        // Center bar if calc_bar_width < bandWidth
                                                        const offset = (bandWidth - self.calc_bar_width) / 2;
                                                        return `translate(${CAT_HISTOGRAM_LAYOUT.inner_padding}, ${tickPos + offset + 1})`;
                                                });

                                col.append('rect')
                                    .attr('class', 'bar')
                                    .attr('width', (d)=>{return self.scale_x(d.val)})
                                    // .attr('width', (d)=>{return ((HISTOGRAM_LAYOUT.width - 2*HISTOGRAM_LAYOUT.inner_padding) / faceted_bins[d.facet].x.length)})
                                    .attr('height', self.calc_bar_height)
                                    .attr('fill', LIGHT_BLUE)
                                    // .attr(`transform`, (d)=>{return `translate(${(CAT_HISTOGRAM_LAYOUT.height- self.scale_x(d.val))-2*CAT_HISTOGRAM_LAYOUT.inner_padding}, ${0})`})
                                    .on('mouseover', function (e,d){
                                        d3.select(this).attr('fill', DEEP_LIGHT_BLUE);
                                        self.model.filter_data_by_category([d.key], self.facet, self.id_token, update_targets);
                                        // self.model.update_row_counts(self.token, `${self.facet}_right_histogram`, self.facet, []);
                                    })
                                    .on('mouseout', function (e,d){
                                        if(!self.model.is_category_pinned(self.facet, d.key)){
                                            d3.select(this).attr('fill', LIGHT_BLUE);
                                        }

                                    })
                                    .on('click', function(e,d){
                                        self.model.pin_unpin_clicked_category(self.id_token, self.facet, d.key);
                                    });
                            }
                        );
            }
        }
    }
}

export {CategoricalBarChart};