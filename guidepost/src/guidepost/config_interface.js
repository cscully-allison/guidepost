import * as d3 from "https://esm.sh/d3@7";
import { OVERVIEW_LAYOUT } from "./consts";

class ConfigurationInterface{
    constructor(model, jsmodel, parent){
        this.anywidget_model = model;
        this.model = jsmodel;
        this.parent = parent;

        this.title_padding = 30;

        this.dropdown_w =  190;
        this.dropdown_h = 30;

        this.dropdown_cum_l_offset = 20;
        this.dropdown_cum_t_offset = 65;
    
        this.max_config_width = OVERVIEW_LAYOUT.width;

        this.order = 0;

        this.initial_render();
    }

    // Builds the option label, appending "(N missing)" when the column has nulls.
    _option_label(col){
        const stats = this.model.feature_summary_stats[col];
        const n = stats && stats.n_missing ? stats.n_missing : 0;
        return n > 0 ? `${col} (${n.toLocaleString()} missing)` : col;
    }

    _missing_text_for(col){
        const stats = this.model.feature_summary_stats[col];
        if(!stats || !stats.n_missing) return '';
        const pct = stats.pct_missing != null ? ` (${(stats.pct_missing * 100).toFixed(1)}%)` : '';
        return `${stats.n_missing.toLocaleString()} missing${pct}`;
    }

    createDropdown(config, onChangeCallback) {
        const self = this;
        const dropdownGroup = this.parent.append('g')
            .attr('class', 'dropdown-group')
            .attr('transform', `translate(${this.dropdown_cum_l_offset}, ${this.dropdown_cum_t_offset})`);

        const compositional_rect = dropdownGroup.append('rect');

        console.log("Creating dropdown for config:", config['human_readable']);
        dropdownGroup.append('text')
                    .text(config['human_readable'] + ":")
                    .style('font-size', '11pt')
                    .attr('text-baseline', 'hanging');

        const dropdown = dropdownGroup.append('foreignObject')
            .attr('transform', `translate(${0},${15})`)
            .attr('width', this.dropdown_w)
            .attr('height', this.dropdown_h)
            .append('xhtml:select')
            .style('width', '100%')
            .style('height', '100%')
            .on('change', function () {
                const selectedValue = d3.select(this).property('value');
                missing_label.text(self._missing_text_for(selectedValue));
                onChangeCallback(selectedValue);
            });

        let options = dropdown.selectAll('option')
            .data(config.options)
            .enter()
            .append('xhtml:option')
            .attr('value', d => d)
            .text(d => self._option_label(d))

        options.each(function(d, i){
            // Use .property('selected', ...) — the `selected` attribute is only
            // honored at parse time, so attr() won't change the displayed value
            // on a select that's already been created.
            d3.select(this).property('selected', self.model.vars[config.name] == d);
        });
        // Belt-and-suspenders: also set the select's value directly so the
        // displayed option matches model.vars even if no option matched above.
        if(self.model.vars[config.name] != null){
            dropdown.property('value', self.model.vars[config.name]);
        }

        // Size the bounding rect from the dropdown content only — measure before
        // appending the missing annotation so the rect doesn't grow to include it.
        compositional_rect.attr('x', -5)
            .attr('y', -20)
            .attr('width', dropdownGroup.node().getBBox().width+3)
            .attr('height', dropdownGroup.node().getBBox().height)
            .attr('fill', 'white')
            .attr('stroke', 'black');

        // Inline annotation showing missing-count for the currently selected column.
        const missing_label = dropdownGroup.append('text')
            .attr('class', 'missing-annotation')
            .attr('transform', `translate(${0},${this.dropdown_h + 32})`)
            .style('font-size', '9pt')
            .style('fill', '#a04040')
            .text(this._missing_text_for(self.model.vars[config.name]));

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

        // Detect datetime-ish columns (incl. object/string columns whose values
        // parse as dates) so we can offer them as x-axis options even though
        // pandas may classify them as "categorical".
        const sample_data = this.model.list_major_data || [];
        const looks_like_datetime_value = (v) => {
            // JSModel mutates string date columns into Date instances in place,
            // so by the time we sample list_major_data the values may be Dates.
            if(v instanceof Date) return !isNaN(v.getTime());
            if(typeof v !== 'string') return false;
            if(/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
            return !isNaN(Date.parse(v));
        };
        const is_datetime_col = (col) => {
            const dt = (sum_stats[col] && sum_stats[col]['dtype']) || '';
            if(dt.indexOf('datetime') !== -1) return true;
            let checked = 0, ok = 0;
            for(const row of sample_data){
                const v = row[col];
                if(v == null) continue;
                checked++;
                if(looks_like_datetime_value(v)) ok++;
                if(checked >= 5) break;
            }
            return checked > 0 && ok === checked;
        };
        const datetime_cols = Object.keys(sum_stats).filter(is_datetime_col);

        for(let config of valid_configs){
            let potential_options = [];
            if(!config['name'].includes('color_agg')){
                for(let dt of config['valid_semantic_data_types']){
                    potential_options = potential_options.concat(semantic_feature_map[dt])
                }
                if(config['name'] === 'x'){
                    for(const c of datetime_cols){
                        if(!potential_options.includes(c)) potential_options.push(c);
                    }
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