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
        validator: new Validator(d3.create("svg")),
        // Single persistent JSModel across config/data changes.
        // Replaces the prior pattern of constructing a new JSModel inside
        // every reload_vis call (which re-ran list_major + the full
        // sanitize pipeline on every dropdown selection).
        jsmodel: null
    };
  
    // (Re)builds the configuration dropdowns. Removes any prior `.configs_grp`
    // (tearing down its DOM + handlers — ConfigurationInterface registers no
    // anywidget_model listeners, so nothing leaks) and constructs a fresh
    // interface from the current jsmodel. Called on initial render and after a
    // data swap so the dropdown OPTIONS track the new dataset's columns (the
    // interface reads them from jsmodel.feature_summary_stats / list_major_data,
    // which update_data has already refreshed by the time we call this).
    function create_config_interface(model, jsmodel, svg){
        svg.selectAll('.configs_grp').remove();
        let config_grp = svg.append('g')
                            .attr('class','configs_grp')
                            .attr('transform', `translate(${0},${HEADER_HEIGHT})`);
        return new ConfigurationInterface(model, jsmodel, config_grp);
    }

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

                    
            // The bottom histogram shows the x-distribution and owns the x-range
            // brush — both meaningless for a categorical x. Skip it; its vertical
            // space is reused by the heatmap's rotated labels + count strip.
            let x_categorical = model.x_is_categorical();

            let h_histogram = x_categorical
                ? null
                : new Histogram(model, parent, model.facets[i], HISTOGRAM_LAYOUT.height, HISTOGRAM_LAYOUT.width, "bottom");
            let v_histogram = new Histogram(model, parent, model.facets[i], VERT_HISTOGRAM_LAYOUT.height, VERT_HISTOGRAM_LAYOUT.width, "right");
            let cat_histogram = new CategoricalBarChart(model, parent, model.facets[i], CAT_HISTOGRAM_LAYOUT.height, CAT_HISTOGRAM_LAYOUT.width, "right");
            let heatmap = new Heatmap(model, parent, model.facets[i], OVERVIEW_LAYOUT.height, OVERVIEW_LAYOUT.width, num_rows);
            let legend = new Legend(model, parent, model.facets[i], heatmap.scale_color, LEGEND_LAYOUT.width, LEGEND_LAYOUT.height);

            legend.inital_render();
            if(h_histogram) h_histogram.render();
            v_histogram.render();
            cat_histogram.render();
            heatmap.render();

            if(h_histogram) model.add_view(h_histogram.id_token, h_histogram);
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


        // When the grouping column has more distinct values than MAX_FACETS, the
        // JSModel renders only the largest groups. Surface the remainder as a
        // notice below the last panel so the elision is explicit, not silent.
        let elided_height = 0;
        if(model.elided_facet_count > 0){
            const msg_y = (FACET_LAYOUT.height * model.facets.length)
                + VIS_HEADER_HEIGHT + FACET_LAYOUT.outer_margin + 24;
            const n = model.elided_facet_count;
            vis_group.append('text')
                .attr('class', 'facet-elision-msg')
                .text(`+ ${n} more group${n > 1 ? 's' : ''} not shown — `
                    + `displaying the ${model.facets.length} largest of `
                    + `${model.total_facet_count} groups in "${model.vars['facet_by']}". `
                    + `Filter this column in your data to inspect the others.`)
                .attr('transform', `translate(${OVERVIEW_LAYOUT.outer_margin},${msg_y})`)
                .attr('font-size', '11pt')
                .attr('fill', '#a04040');
            elided_height = 40;
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
                + FACET_LAYOUT.bottom_padding
                + elided_height,
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

    function reload_vis(model, svg, validator, jsmodel){
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
            // _vis_data is now an opaque Arrow bytes payload — the validator
            // can't introspect column names/types from it. Hand it the
            // summary_stats dict instead, which carries per-column
            // semantic_type/dtype keyed by column name.
            validator.summary_stats = _summary_stats;

            if(validator.validate()){
                if(!jsmodel){
                    jsmodel = new JSModel(data, vis_configs, _summary_stats, model);
                }
                extra_state.jsmodel = jsmodel;
                create_views(jsmodel, svg);
            }
            return jsmodel;
    }


  return {
    initialize({ model }) {
        // Set up shared state or event handlers
        model.on("change:_vis_configs", ()=>{
            // Config changes (axis swap, color agg, etc.) used to rebuild the
            // entire JSModel — list_major + sanitize_and_intialize_data — which
            // is O(N) and dominated dropdown latency above ~100k rows. The
            // persistent JSModel handles config diffing incrementally and
            // only re-renders.
            //
            // No-op if the initial render hasn't constructed the JSModel yet
            // (the smart-default config setter inside render() fires this
            // synchronously before the model exists; render() then picks up
            // the updated vis_configs on its own).
            if(!extra_state.jsmodel) return;
            let vis_configs = JSON.parse(model.get("_vis_configs"));
            extra_state.jsmodel.apply_config(vis_configs);
            extra_state.svg.selectAll(".visualization_group").remove();
            create_views(extra_state.jsmodel, extra_state.svg);
        })

        model.on("change:_vis_data", ()=>{
            // Data change must rebuild. Reuse the existing JSModel via
            // update_data so views and configs persist; only fall through to
            // a fresh reload if no model has been built yet.
            if(!extra_state.jsmodel) return;
            extra_state.svg.selectAll(".visualization_group").remove();

            const data = model.get("_vis_data");
            const summary_stats = model.get("_summary_stats");

            // Swapping to a frame whose columns no longer satisfy the current
            // config (e.g. entirely different column names) would leave the old
            // config referencing missing columns and crash the rebuild. Reset to
            // smart defaults — but ONLY when the config is actually invalid, so
            // reloading a same-schema frame (filtered rows, etc.) preserves the
            // user's manual axis selections. reset_config adopts the new vars
            // WITHOUT rebuilding against the still-loaded old frame; update_data
            // below does the rebuild against the new one.
            extra_state.validator.summary_stats = summary_stats;
            let vis_configs = JSON.parse(model.get("_vis_configs"));
            extra_state.validator.vis_configs = vis_configs;
            const config_invalid = extra_state.validator.validate_vis_configs().length > 0;
            if(config_invalid){
                vis_configs = globals.load_smart_default_configs(summary_stats, data);
                extra_state.jsmodel.reset_config(vis_configs);
            }

            extra_state.jsmodel.update_data(data, summary_stats);
            create_views(extra_state.jsmodel, extra_state.svg);
            // Rebuild the dropdowns so their options track the new columns (the
            // selected values still come from the now-updated config). Always —
            // columns can change even when the prior config stays valid.
            create_config_interface(model, extra_state.jsmodel, extra_state.svg);

            // Persist regenerated defaults so Python `vis_configs` and the config
            // dropdowns reflect them. Done after the rebuild so the synchronous
            // change:_vis_configs this fires diffs to zero (reset_config already
            // synced _applied_vars) and stays a cheap no-op re-render.
            if(config_invalid){
                model.set("_vis_configs", JSON.stringify(vis_configs));
                model.save_changes();
            }
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
        // Validator now consumes _summary_stats instead of raw row data — see
        // reload_vis() for the rationale (Arrow payload is opaque bytes).
        extra_state.validator.summary_stats = _summary_stats;
        extra_state.validator.vis_configs = vis_configs;

        let jsmodel = null;

        if(extra_state.validator.validate()){
            // Construct the JSModel exactly once on initial render and hand
            // the same instance to reload_vis. The prior code instantiated
            // here AND inside reload_vis, doubling the cost of first load.
            jsmodel = new JSModel(data, vis_configs, _summary_stats, model);
            reload_vis(model, extra_state.svg, extra_state.validator, jsmodel);
        }

        create_config_interface(model, jsmodel, extra_state.svg);

        return () => {
        // Optional: Called when the view is destroyed.
        }
    }
  }
}







// export default{ render };