import * as d3 from "https://esm.sh/d3@7";
import { OVERVIEW_LAYOUT } from "./consts";

class ConfigurationInterface{
    constructor(model, jsmodel, parent){
        this.anywidget_model = model;
        this.model = jsmodel;
        this.parent = parent;

        this.title_padding = 30;

        this.dropdown_w =  200;
        this.dropdown_h = 30;

        this.dropdown_cum_l_offset = 20;
        this.dropdown_cum_t_offset = 50;
    
        this.max_config_width = OVERVIEW_LAYOUT.width;

        this.order = 0;


        console.log("Config Variables", this.model.vars);

        this.initial_render();
    }

    createDropdown(config, onChangeCallback) {
        const self = this;
        const dropdownGroup = this.parent.append('g')
            .attr('class', 'dropdown-group')
            .attr('transform', `translate(${this.dropdown_cum_l_offset}, ${this.dropdown_cum_t_offset})`);

        
        dropdownGroup.append('text')
                    .text(config.title)

        const dropdown = dropdownGroup.append('foreignObject')
            .attr('transform', `translate(${0},${15})`)
            .attr('width', this.dropdown_w)
            .attr('height', this.dropdown_h)
            .append('xhtml:select')
            .style('width', '100%')
            .style('height', '100%')
            .on('change', function () {
                const selectedValue = d3.select(this).property('value');
                onChangeCallback(selectedValue);
            });

        let options = dropdown.selectAll('option')
            .data(config.options)
            .enter()
            .append('xhtml:option')
            .attr('value', d => d)
            .text(d => d)
        
        options.each(function(d, i){
            // console.log(this, d, i);
            if(self.model.vars[config.name] == d){
                d3.select(this).attr('selected', 'true');
            }
            else{
                d3.select(this).attr('selected', null)
            }
        });        


        this.dropdown_cum_l_offset += this.dropdown_w + 10;
    }

    initial_render(){
        const sum_stats = this.model.feature_summary_stats;
        const valid_configs = this.model.valid_config_fields;
        const self = this;

        let semantic_feature_map = {
        'categorical': [],
        'ordinal':[],
        'continuous': []
        }

        for(let feature in sum_stats){
            semantic_feature_map[sum_stats[feature]['semantic_type']].push(feature)
        }

        for(let config of valid_configs){
            let potential_options = [];
            if(!config['name'].includes('color_agg')){
                for(let dt of config['valid_semantic_data_types']){
                    potential_options = potential_options.concat(semantic_feature_map[dt])
                }
                this.model.set_config_options(config['name'], potential_options);
            }  
        }

        this.parent
            .append('text')
            .text('Configurations')
            .attr('transform', `translate(${10},${this.title_padding})`)
            .attr('font-size', '13pt')
        
        for(let config of valid_configs){
            this.createDropdown(config, 
                                (v)=>{
                                    let vis_configs = self.model.vars
                                    vis_configs[config.name] = v;
                                    // vis_configs["new"] = "new";
                                    self.anywidget_model.set('_vis_configs', JSON.stringify(vis_configs));
                                    // self.anywidget_model.save_changes();
                                    
                                    console.log("SELECTION MADE", vis_configs, self.anywidget_model);

                                    console.log(self.anywidget_model.get('_vis_configs'));
                                })
        }
        
        // this.parent;

    }
}

export {ConfigurationInterface};