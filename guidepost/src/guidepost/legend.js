import * as d3 from "https://esm.sh/d3@7";
import { animate, Timeline } from "animejs";
import { LEGEND_LAYOUT, OVERVIEW_LAYOUT } from "./consts";

class Legend {
    constructor(model, parent, facet, color_scale, width, height) {
        // Initialize the Legend with model, parent element, facet, color scale, width, and height
        this.parent = parent;
        this.color_scale = color_scale;
        this.model = model;
        this.width = width;
        this.height = height;
        this.facet = facet;
        this.id_token = `${facet}_legend`

        this.bar_width = 20;
        this.bar_height = this.height-2*LEGEND_LAYOUT.inner_padding;

        if(color_scale.domain().length > 2){
            this.ticks_scale = d3.scaleDiverging().domain(color_scale.domain().reverse()).range([0, this.bar_height/2, this.bar_height]);
        } 
        else{
            if(color_scale.domain()[1] > 2){
                this.ticks_scale = d3.scaleSymlog().domain([color_scale.domain()[0]+1, color_scale.domain()[1]].reverse()).range([0, this.bar_height]);
            }
            else{
                this.ticks_scale = d3.scaleSymlog().domain([color_scale.domain()[0], color_scale.domain()[1]].reverse()).range([0, this.bar_height]);
            }
        }

    }

    /**
     * Performs the initial rendering of the legend.
     */
    inital_render(){
        
        // let x_offset = OVERVIEW_LAYOUT.width + VERT_HISTOGRAM_LAYOUT.width + OVERVIEW_LAYOUT.outer_margin;
        // let y_offset = OVERVIEW_LAYOUT.outer_margin+OVERVIEW_LAYOUT.inner_padding;


        let x_offset = OVERVIEW_LAYOUT.outer_margin;
        let y_offset = OVERVIEW_LAYOUT.outer_margin+OVERVIEW_LAYOUT.inner_padding;


        let legend_grp = this.parent.append('g')
                            .attr('height', this.height)
                            .attr('width', this.width)
                            .attr('transform', `translate(${x_offset},${y_offset})`);


        // Create a linear gradient
        const gradient = legend_grp.append('defs')
            .append('linearGradient')
            .attr('id', 'linear-gradient')
            .attr('x1', '0%')
            .attr('y1', '100%')
            .attr('x2', '0%')
            .attr('y2', '0%');
    
        // Define color stops for the gradient
        this.color_scale.range().forEach((color, index) => {
            gradient.append('stop')
                .attr('offset', `${(index / (this.color_scale.range().length - 1)) * 100}%`)
                .attr('stop-color', color);
        });
    
        // Create a rectangle for the gradient bar
        legend_grp.append('rect')
            .attr('width', this.bar_width)
            .attr('height', this.bar_height)
            .style('fill', 'url(#linear-gradient)')
            .attr('transform', `translate(${LEGEND_LAYOUT.width-LEGEND_LAYOUT.right_padding},${0})`);
        
        let axis = legend_grp.append('g')
            .attr('class', 'right-axis');

        let ticks = this.model.logScale(this.ticks_scale.domain()[0], this.ticks_scale.domain()[this.ticks_scale.domain().length-1], 5)
        
        axis.append('g')
            .attr('class', 'right-axis')
            .call(d3.axisLeft().scale(this.ticks_scale).tickValues(ticks).tickFormat(d3.format(".2s")))  
            .attr('transform', `translate(${LEGEND_LAYOUT.width-LEGEND_LAYOUT.right_padding},${0})`);


        // legend_grp.append('text')
        //         .text(`Legend`)
        //         .attr('transform', `translate(${LEGEND_LAYOUT.left_padding}, ${LEGEND_LAYOUT.top_padding-25})`);

        legend_grp.append('text')
                .text(`${this.model.vars.color} (${this.model.vars.color_agg})`)
                .attr('text-anchor', 'middle')
                .attr('transform', `translate(${LEGEND_LAYOUT.width-LEGEND_LAYOUT.right_padding-40}, ${this.bar_height/2}), rotate(270)`);
        
        legend_grp.append('text')
            .attr('class', 'num-records-label')
            .text(`No. of Records Selected for Export:`)
            .attr('transform', `translate(${0}, ${-20})`);;
        
        legend_grp.append('text')
            .attr('class', 'text-number')
            .style('font-weight', 'bold')
            .text(` ${this.model.brushed_data[this.facet].length}`)
            .attr('transform', `translate(${210}, ${-20})`);

        this.legend_grp = legend_grp;

        this.textFlashAnimation = null;

    }

    flashText() {
        if (this.textFlashAnimation) {
            this.textFlashAnimation.pause();
        }

        this.textFlashAnimation = animate('.text-number', {
            keyframes: [
                { fill: '#ff6200ff', duration: 500, easing: 'easeOutQuad' },
                { fill: '#444', duration: 800, easing: 'easeOutQuad' }
            ]
        });
    }


    /**
     * Renders the legend by updating the DOM elements based on the current data.
     */
    render(){
        this.legend_grp.selectAll('.text-number')
            .text(`${this.model.brushed_data[this.facet].length}`);
        this.flashText();
    }

}

export {Legend};
