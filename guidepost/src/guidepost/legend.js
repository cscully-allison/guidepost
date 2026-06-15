import * as d3 from "https://esm.sh/d3@7";
import { animate, Timeline } from "animejs";
import { LEGEND_LAYOUT, OVERVIEW_LAYOUT, TOP_MARGIN } from "./consts";

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

        // Invertible value<->pixel scale for the color brush, matching the
        // gradient orientation (top = max, bottom = min). ticks_scale is a symlog
        // (invertible) for the sequential case; d3.scaleDiverging (std_ratio) has
        // NO .invert, so build a dedicated symlog over [max, min] -> [0, bar_height].
        const dom = color_scale.domain();
        if(dom.length > 2){
            this.brush_value_scale = d3.scaleSymlog().domain([dom[dom.length - 1], dom[0]]).range([0, this.bar_height]);
        } else {
            this.brush_value_scale = this.ticks_scale;
        }
    }

    /**
     * Performs the initial rendering of the legend.
     */
    inital_render(){
        
        // let x_offset = OVERVIEW_LAYOUT.width + VERT_HISTOGRAM_LAYOUT.width + OVERVIEW_LAYOUT.outer_margin;
        // let y_offset = OVERVIEW_LAYOUT.outer_margin+OVERVIEW_LAYOUT.inner_padding;


        let x_offset = OVERVIEW_LAYOUT.outer_margin;
        // + TOP_MARGIN keeps the gradient bar aligned with the heatmap plot,
        // which shifted down by the same amount (bug 1.a).
        let y_offset = OVERVIEW_LAYOUT.outer_margin+OVERVIEW_LAYOUT.inner_padding+TOP_MARGIN;


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

        // Vertical brush over the gradient bar: selects records whose heatmap
        // cell color-agg value falls in the brushed color band (for export +
        // highlight). Appended into legend_grp with NO extra transform, so brush
        // pixels equal the bar's local y == brush_value_scale.range().
        const self = this;
        const bx0 = LEGEND_LAYOUT.width - LEGEND_LAYOUT.right_padding;
        const bx1 = bx0 + this.bar_width;
        this.color_brush = d3.brushY()
            .extent([[bx0, 0], [bx1, this.bar_height]])
            // Ignore programmatic moves (sourceEvent null) so reflecting the
            // current band onto the brush can't re-fire the selection loop.
            .on('end', function(event){ if(!event.sourceEvent) return; self.on_color_brush_end(event.selection); });
        this.brush_g = legend_grp.append('g')
            .attr('class', 'color-brush')
            .call(this.color_brush);

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
        
        // Lift the records-export label up into the header band (legend_grp now
        // sits TOP_MARGIN lower, at the plot top) so it no longer overlaps the
        // pinned-column hover labels (bug 1.a).
        legend_grp.append('text')
            .attr('class', 'num-records-label')
            .text(`No. of Records Selected for Export:`)
            .attr('transform', `translate(${0}, ${-(TOP_MARGIN + 4)})`);;

        legend_grp.append('text')
            .attr('class', 'text-number')
            .style('font-weight', 'bold')
            .text(` ${this.model.brushed_data[this.facet].length}`)
            .attr('transform', `translate(${210}, ${-(TOP_MARGIN + 4)})`);

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
     * Color-brush end handler: maps the brushed pixel span to a color-value range
     * (via the invertible brush_value_scale) and selects the records of displayed
     * cells in that band. An empty/cleared brush clears the band + selection.
     */
    on_color_brush_end(selection){
        const f = this.facet;
        const targets = [`${f}_heatmap`, `${f}_bottom_histogram`, `${f}_right_histogram`, `${f}_legend`];
        if(!selection){
            this.model.select_by_color_range(f, null, null, targets);
            return;
        }
        const [py0, py1] = selection;
        const v_a = this.brush_value_scale.invert(py0);
        const v_b = this.brush_value_scale.invert(py1);
        this.model.select_by_color_range(f, v_a, v_b, targets);
    }

    /**
     * Renders the legend by updating the DOM elements based on the current data.
     */
    render(){
        this.legend_grp.selectAll('.text-number')
            .text(`${this.model.brushed_data[this.facet].length}`);
        this.flashText();

        // Reflect the current color band onto the brush (programmatic move is
        // ignored by the end handler, so no loop), so the brush survives renders
        // triggered by other selections and clears when the band is cleared.
        if(this.color_brush && this.brush_g){
            const cr = this.model.brushed_ranges[this.facet].color_range;
            if(cr && cr.length === 2){
                const p_lo = this.brush_value_scale(cr[0]);
                const p_hi = this.brush_value_scale(cr[1]);
                this.brush_g.call(this.color_brush.move, [Math.min(p_lo, p_hi), Math.max(p_lo, p_hi)]);
            } else {
                this.brush_g.call(this.color_brush.move, null);
            }
        }
    }

}

export {Legend};
