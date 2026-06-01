

class Validator{

    constructor(svg, summary_stats={}, vis_configs={}){
        this.svg = svg;
        // The validator used to inspect column-major raw data directly. Now
        // that `_vis_data` is an opaque Arrow bytes payload, this field holds
        // the `_summary_stats` dict instead — same column-name keys, with
        // per-column semantic_type/dtype/n_unique that's sufficient for every
        // shape and type check below.
        this.summary_stats = summary_stats;
        this.vis_configs = vis_configs;
    }

    /**
     * Ensures every column referenced in vis_configs exists in the dataset.
     */
    validate_vis_configs() {
        let missing = [];
        for (let key in this.vis_configs) {
            if (key !== 'color_agg' && !this.summary_stats.hasOwnProperty(this.vis_configs[key])) {
                missing.push({ key: key, value: this.vis_configs[key], message: `Configuration Error: "${key}": The variable "${this.vis_configs[key]}" is missing from the data. Please verify that the variable name exists in the dataset columns or is spelled correctly.` });
            }
        }
        return missing;
    }


    /**
     * Checks if a string is a valid date.
     */
    isValidDate(dateString) {
        const date_time = new Date(dateString);
        return !isNaN(date_time.getTime());
    }

    validate_data_loaded(){
        if(Object.keys(this.summary_stats).length == 0){
            return [{key:'data', value:'data', message:"No data detected. Please load data into <objectname>.records"}];
        }

        return [];
    }


    render_errors(errors){
        this.svg.selectAll("*").remove();
        
        let err_view = this.svg.append('text')
            .text('Errors were found in the visualization specification. See below for more details or check the console output.')
            .attr('transform', `translate(${20}, ${20})`);

        let err_list = this.svg.append('g')
            .attr('transform', `translate(${30}, ${40})`);

        err_list.append('rect')
            .attr('height', 20*errors.length)
            .attr('width', 1300)
            .attr('fill', 'rgba(240,240,240)')
            .attr('stroke', 'black');
        
        for(let error of errors){
            err_list.append('text')
                .text(`· ${error.message}`)
                .attr('transform', `translate(${10}, ${15 + 20*errors.indexOf(error)})`);
        }

        this.svg.attr('height', 20*errors.length + 40)
            .attr('width', 1340);
    }

    validate(){
        let errors = [];
         
        errors = this.validate_data_loaded();
        errors = errors.concat(this.validate_config_fields());
        errors = errors.concat(this.validate_vis_configs());

        //CONDITION WHERE ALL OTHER PARTS OF DATA ARE VALID
        // SO THERE WILL NOT BE OBJECT/KEY ACCESS ERRORS
        if(errors.length <= 0){
            errors = this.validate_variable_semantics();
        }

        if(errors.length > 0){
            this.render_errors(errors);
            return false;
        }

        return true;
    }

    validate_config_fields(){
        //ensure that all keys in vis_configs are in the set of required keys x, y, color, categorical, facet_by, and color_agg
        let required_keys = ['x', 'y', 'color', 'categorical'];
        let missing = [];
        for (let key of required_keys) {
            if (!this.vis_configs.hasOwnProperty(key)) {
                missing.push({ key: key, value: '', message: `Configuration Error: "${key}": This key is required for the visualization configuration. Please specify this key and a column name as the value for this configuration.` });
            }
        }


        //attempt to resolve a missing facet_by
        if(!this.vis_configs.hasOwnProperty('facet_by')){
            // if (this.data.hasOwnProperty('partition')) {
            //     this.vis_configs['facet_by'] = 'partition';
            // } else if (this.data.hasOwnProperty('queue')) {
            //     this.vis_configs['facet_by'] = 'queue';
            // } else {
            missing.push({ key: 'facet_by', value: '', message: `Configuration Error: No column was selected to partition the data into and no "queue" or "partition" column was found in the dataset. 
                Please specify the "facet_by" configuration and a categorical column on your data.` });
            // }
        }

        //set color_agg to average by default
        // if(!this.vis_configs.hasOwnProperty('color_agg')){
        //     this.vis_configs.color_agg = 'avg';
        // }


        return missing;
    }


    /**
     * Type-checks each configured column against its pandas-derived semantic
     * type. summary_stats[col] carries semantic_type ∈ {continuous, ordinal,
     * categorical} and dtype (e.g. 'datetime64[ns]') — sufficient to validate
     * x/y/color/categorical without sampling raw values.
     */
    validate_variable_semantics() {
        let incorrect = [];
        let valid_aggs = ['avg', 'variance', 'std', 'median', 'sum'];

        const is_datetime = (col) => {
            const dt = (this.summary_stats[col] && this.summary_stats[col].dtype) || '';
            return dt.indexOf('datetime') !== -1;
        };
        // Datetime columns have semantic_type='continuous' in pandas, so the
        // numeric check must also exclude datetimes — y and color refuse
        // datetime columns, x accepts them via the separate is_datetime branch.
        const is_numeric = (col) => {
            const t = this.summary_stats[col] && this.summary_stats[col].semantic_type;
            if(t !== 'continuous' && t !== 'ordinal') return false;
            return !is_datetime(col);
        };
        const is_categorical = (col) => {
            return !!(this.summary_stats[col] && this.summary_stats[col].semantic_type === 'categorical');
        };

        for (let key in this.vis_configs) {
            const col = this.vis_configs[key];
            if(key === 'color_agg'){
                if(!valid_aggs.includes(this.vis_configs['color_agg'])){
                    incorrect.push({key:key, value: col, message: 'Invalid aggregation specified. Acceptable aggregations are: "avg", "variance", "std", "median", "sum"'});
                }
            }
            else if (key === 'x') {
                if(!is_numeric(col) && !is_datetime(col) && !is_categorical(col)){
                    incorrect.push({ key: key, value: col, message: 'The x-axis supports floats, integers, dates, and categorical columns. Please specify a different variable or verify that the datetime is properly formatted.' });
                }
            }
            else if (key === 'y') {
                if(!is_numeric(col)){
                    incorrect.push({ key: key, value: col, message: 'The y-axis only supports floats and integers. Please specify a different variable.' });
                }
            }
            else if (key === 'color') {
                if(!is_numeric(col)){
                    incorrect.push({ key: key, value: col, message: 'The color variable only supports floats and integers. Please specify a different column on your dataset or verify the datatype of this column.' });
                }
            }
            else if (key === 'categorical'){
                // Numeric columns selected as categorical are tolerated — the
                // JSModel coerces values to strings during record decoding.
                // Only reject if the column is missing entirely (caught by
                // validate_vis_configs).
            }
        }
        return incorrect;
    }

}

export {Validator};