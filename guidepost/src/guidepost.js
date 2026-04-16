import * as d3 from "https://esm.sh/d3@7";
import * as globals from "./guidepost/consts";

import { JSModel } from "./guidepost/js_model";
import { Validator } from "./guidepost/validator";

import { Heatmap } from "./guidepost/heatmap";
import { Histogram } from "./guidepost/histogram";
import { CategoricalBarChart } from "./guidepost/barchart";
import { Legend } from "./guidepost/legend";
import { ConfigurationInterface } from "./guidepost/config_interface";



// //layout vars


const OVERVIEW_LAYOUT = globals.OVERVIEW_LAYOUT;
const HISTOGRAM_LAYOUT = globals.HISTOGRAM_LAYOUT;
const VERT_HISTOGRAM_LAYOUT = globals.VERT_HISTOGRAM_LAYOUT;
const CAT_HISTOGRAM_LAYOUT = globals.CAT_HISTOGRAM_LAYOUT;
const LEGEND_LAYOUT = globals.LEGEND_LAYOUT;
const CONFIGURATION_LAYOUT = globals.CONFIGURATION_LAYOUT;
const VIS_HEADER_HEIGHT = globals.VIS_HEADER_HEIGHT;
const HEADER_HEIGHT = globals.HEADER_HEIGHT;
const FULL_SVG_WIDTH = globals.FULL_SVG_WIDTH;
const num_rows = globals.num_rows;
const FACET_LAYOUT = globals.FACET_LAYOUT;

// COLORS
const GUIDEPOST_MAIN_COLOR = globals.GUIDEPOST_MAIN_COLOR;
const BACKGROUND_COLOR = globals.BACKGROUND_COLOR;

let total_hist_height = globals.total_hist_height;



export default async () => {
    let extra_state = {
        svg:d3.create("svg"),
        validator: new Validator(d3.create("svg"))
    };
  
    function create_views(model, svg){
        let running_view_height = 0;
        let max_width = FULL_SVG_WIDTH;

        // let config_interface = new ConfigurationInterface(model, parent);
        let vis_group = svg.append('g')
                            .attr('class', 'visualization_group')
                            .attr('transform', `translate(0,${CONFIGURATION_LAYOUT.height + HEADER_HEIGHT})`);

        vis_group.append('text')
                    .text(`Views grouped by:`)
                    .attr('transform', `translate(${10},${10})`)
                    .attr('font-size', '13pt');


        vis_group.append('text')
                    .text(`\"${model.vars['facet_by']}\"`)
                    .attr('transform', `translate(${155},${10})`)
                    .attr('font-size', '13pt')
                    .attr('font-weight', 'bold');
        
        for(let i in model.facets){
            let parent = vis_group.append('g')
                            .attr('class', 'faceted_view')
                            .attr('transform', `translate(${OVERVIEW_LAYOUT.outer_margin},${(FACET_LAYOUT.height * i) + (i ? 0 : FACET_LAYOUT.outer_margin) + VIS_HEADER_HEIGHT})`)
                            .attr('width', OVERVIEW_LAYOUT.width)
                            .attr('height', FACET_LAYOUT.height);
            
            let compositional_rect = parent.append('rect')
                .attr('x', 0)
                .attr('y', 0);

                    
            let h_histogram = new Histogram(model, parent, model.facets[i], HISTOGRAM_LAYOUT.height, HISTOGRAM_LAYOUT.width, "bottom");
            let v_histogram = new Histogram(model, parent, model.facets[i], VERT_HISTOGRAM_LAYOUT.height, VERT_HISTOGRAM_LAYOUT.width, "right");
            let cat_histogram = new CategoricalBarChart(model, parent, model.facets[i], CAT_HISTOGRAM_LAYOUT.height, CAT_HISTOGRAM_LAYOUT.width, "right");
            let heatmap = new Heatmap(model, parent, model.facets[i], OVERVIEW_LAYOUT.height, OVERVIEW_LAYOUT.width, num_rows);
            let legend = new Legend(model, parent, model.facets[i], heatmap.scale_color, LEGEND_LAYOUT.width, LEGEND_LAYOUT.height);
                
            legend.inital_render();
            h_histogram.render();
            v_histogram.render();
            cat_histogram.render();
            heatmap.render();

            model.add_view(h_histogram.id_token, h_histogram);
            model.add_view(v_histogram.id_token, v_histogram);
            model.add_view(heatmap.id_token,heatmap);
            model.add_view(legend.id_token, legend);

            // NOTE: getBBox() on an unattached SVG (d3.create) returns 0 in most
            // browsers, so we size from FACET_LAYOUT.height (the same constant
            // used to position each facet at line 68) instead of measuring.
            running_view_height += FACET_LAYOUT.height;
            max_width = Math.max(max_width, FULL_SVG_WIDTH + HISTOGRAM_LAYOUT.outer_margin);

            compositional_rect.attr('width', max_width)
                .attr('height', FACET_LAYOUT.height)
                .attr('fill', 'white')
                .attr('stroke', 'black');
        }


        // running_view_height = FACET_LAYOUT.height * num_facets. Total SVG must
        // also include the vis_group's own translate (CONFIGURATION_LAYOUT.height
        // + HEADER_HEIGHT), the in-group VIS_HEADER_HEIGHT, the leading
        // FACET_LAYOUT.outer_margin used by the first facet at i=0, and
        // FACET_LAYOUT.bottom_padding so the last facet isn't flush with the edge.
        const total_height = Math.max(
            running_view_height
                + CONFIGURATION_LAYOUT.height
                + HEADER_HEIGHT
                + VIS_HEADER_HEIGHT
                + FACET_LAYOUT.outer_margin
                + FACET_LAYOUT.bottom_padding,
            1787
        );

        svg.select('#bg-mat').attr('height', total_height)
            .attr('width', max_width + HISTOGRAM_LAYOUT.outer_margin*2);

        svg.attr('height', total_height)
            .attr('width', max_width + HISTOGRAM_LAYOUT.outer_margin*2);


        // svg.select('#bg-mat').attr('height', (OVERVIEW_LAYOUT.height * model.facets.length) + (FACET_LAYOUT.outer_margin*(model.facets.length+1) + total_hist_height*model.facets.length) + CONFIGURATION_LAYOUT.height + VIS_HEADER_HEIGHT)
        //     .attr('width', OVERVIEW_LAYOUT.width + (2 * OVERVIEW_LAYOUT.outer_margin) + (VERT_HISTOGRAM_LAYOUT.width+(2*VERT_HISTOGRAM_LAYOUT.outer_margin)) + LEGEND_LAYOUT.width);
        
        // svg.attr('height', (OVERVIEW_LAYOUT.height * model.facets.length) + (FACET_LAYOUT.outer_margin*(model.facets.length+1) + total_hist_height*model.facets.length) + CONFIGURATION_LAYOUT.height + VIS_HEADER_HEIGHT)
        //     .attr('width', OVERVIEW_LAYOUT.width + (2 * OVERVIEW_LAYOUT.outer_margin) + (VERT_HISTOGRAM_LAYOUT.width+(2*VERT_HISTOGRAM_LAYOUT.outer_margin)) + LEGEND_LAYOUT.width);

    }

    function reload_vis(model, svg, validator){
            console.log("RELOAD VIS IN FUNCTIOn");
            let vis_configs = JSON.parse(model.get("_vis_configs"));
            let data = model.get("_vis_data");
            let _summary_stats = model.get("_summary_stats");

            svg.append('rect')
                .attr('id', 'bg-mat')
                .attr('fill', BACKGROUND_COLOR)
                .attr('stroke', GUIDEPOST_MAIN_COLOR)
                .attr('stroke-width', 1);

            let header = svg.append('g').attr('id', 'guidepost-header');
            header.append('rect')
                    .attr('width', FULL_SVG_WIDTH)
                    .attr('height', HEADER_HEIGHT)
                    .attr('fill', GUIDEPOST_MAIN_COLOR);

            header.append('text')
                    .text('Guidepost')
                    .attr('fill', '#ffffff')
                    .attr('transform', `translate(${10}, ${HEADER_HEIGHT/2})`)
                    .attr('font-size', '14pt')
                    .attr('dominant-baseline', 'middle');

            validator.vis_configs = vis_configs;
            validator.data = data;

            if(validator.validate()){
                let jsmodel = new JSModel(data, vis_configs, _summary_stats, model); 
                create_views(jsmodel, svg);
            }
    }


  return {
    initialize({ model }) {
        // Set up shared state or event handlers
        model.on("change:_vis_configs", ()=>{
            extra_state.svg.selectAll(".visualization_group").remove();
            reload_vis(model,extra_state.svg, extra_state.validator);
        })

        model.on("change:_vis_data", ()=>{
            extra_state.svg.selectAll(".visualization_group").remove();
            reload_vis(model,extra_state.svg, extra_state.validator);
        })

        return () => {
        // Optional: Called when the widget is destroyed.
        } 
    },
    render({ model, el }) {
        // Render the widget's view into the el HTMLElement.
        let data = model.get("_vis_data");
        let _summary_stats = model.get("_summary_stats");
        let vis_configs = JSON.parse(model.get("_vis_configs"));

        if(Object.entries(vis_configs).length <= 0){
            vis_configs = globals.load_smart_default_configs(_summary_stats, data);
            model.set("_vis_configs", JSON.stringify(vis_configs));
            model.save_changes();
        }

        // console.log("INITIAL RENDER CALL", vis_configs)

        model.set("selected_records", "");
        model.save_changes();


        d3.select(el).append(function(){return extra_state.svg.node()})
                                .attr('width', 500)
                                .attr('height', 50)
                                .style('font-family', 'sans-serif');
        
        extra_state.svg.append('rect')
            .attr('id', 'bg-mat')
            .attr('fill', BACKGROUND_COLOR)
            .attr('stroke', GUIDEPOST_MAIN_COLOR)
            .attr('stroke-width', 1);

        let header = extra_state.svg.append('g').attr('id', 'guidepost-header');
        header.append('rect')
                .attr('width', FULL_SVG_WIDTH)
                .attr('height', HEADER_HEIGHT)
                .attr('fill', GUIDEPOST_MAIN_COLOR);

        header.append('text')
                .text('Guidepost')
                .attr('transform', `translate(${10}, ${HEADER_HEIGHT/2})`)
                .attr('font-size', '14pt')
                .attr('fill', 'rgba(255, 255, 255, 0.85)')
                .attr('dominant-baseline', 'middle');
        

        extra_state.validator.svg = extra_state.svg;
        extra_state.validator.data =  data;
        extra_state.validator.vis_configs = vis_configs;

        let jsmodel = null;

        if(extra_state.validator.validate()){
            jsmodel = new JSModel(data, vis_configs, _summary_stats, model);
            reload_vis(model, extra_state.svg, extra_state.validator);
            // create_views(jsmodel, extra_state.svg, extra_state.validator);
        }

        let config_grp = extra_state.svg.append('g')
                        .attr('class','configs_grp')
                        .attr('transform', `translate(${0},${HEADER_HEIGHT})`);

        let config_interface = new ConfigurationInterface(model, jsmodel, config_grp);

        return () => {
        // Optional: Called when the view is destroyed.
        }
    }
  }
}







// export default{ render };