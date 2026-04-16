

class Validator{

    constructor(svg, data={}, vis_configs={}){
        this.svg = svg;
        this.data = data;
        this.vis_configs = vis_configs;
    
    }

    /**
     * Ensures that all values in vis_configs are in the keys of data.
     * @param {Object} vis_configs - The variable specifications.
     * @param {Object} data - The data object.
     * @returns {Array} - An array of missing keys and their associated values.
     */
    validate_vis_configs() {
        let missing = [];
        for (let key in this.vis_configs) {
            if (key !== 'color_agg' && !this.data.hasOwnProperty(this.vis_configs[key])) {
                missing.push({ key: key, value: this.vis_configs[key], message: `Configuration Error: "${key}": The variable "${this.vis_configs[key]}" is missing from the data. Please verify that the variable name exists in the dataset columns or is spelled correctly.` });
            }
        }
        return missing;
    }


    /**
     * Checks if a string is a valid date.
     * @param {string} dateString - The string to check.
     * @returns {boolean} - True if the string is a valid date, false otherwise.
     */
    isValidDate(dateString) {
        const date_time = new Date(dateString);
        return !isNaN(date_time.getTime());
    }

    validate_data_loaded(){
        if(Object.keys(this.data).length == 0){
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


    // Function to coerce an entire column’s values to strings (preserving null/undefined)
    coerceColumnToString(columnData) {
        return Object.keys(columnData).reduce((result, key) => {
            const v = columnData[key];
            result[key] = (v == null) ? null : String(v);
            return result;
        }, {});
    }

    // Returns the first non-null value in a column dict, or undefined if all null.
    firstNonNull(columnData) {
        for (const k of Object.keys(columnData)) {
            const v = columnData[k];
            if (v != null) return v;
        }
        return undefined;
    }

    /**
     * Ensures that all values in this.vis_configs are logically appropriate
     * @param {Object} this.vis_configs - The variable specifications.
     * @param {Object} this.data - The data object.
     * @returns {Array} - An array of missing keys and their associated values.
     */
    validate_variable_semantics() {
        let incorrect = [];
        let valid_aggs = ['avg', 'variance', 'std', 'median', 'sum']

        for (let key in this.vis_configs) {
            if(key === 'color_agg'){
                if(!valid_aggs.includes(this.vis_configs['color_agg'])){
                    incorrect.push({key:key, value: this.vis_configs[key], message: 'Invalid aggregation specified. Acceptable aggregations are: "avg", "variance", "std", "median", "sum"'});
                }
            }
            else if (key === 'x') {
                let test_val = this.firstNonNull(this.data[this.vis_configs[key]]);
                if (typeof test_val !== 'number'){
                    if(typeof test_val == 'string'){
                        if(!this.isValidDate(test_val)){
                            incorrect.push({ key: key, value: this.vis_configs[key], message: 'The x-axis only supports floats, integers and dates. Please specify a different variable or verify that the datetime is properly formatted.' });
                        }
                    }
                    else {
                        incorrect.push({ key: key, value: this.vis_configs[key], message: 'The x-axis only supports floats, integers and dates. Please specify a different variable or verify that the datetime is properly formatted.' });
                    }
                }
            }
            else if (key === 'y') {
                let test_val = this.firstNonNull(this.data[this.vis_configs[key]]);
                if (typeof test_val !== 'number'){
                        incorrect.push({ key: key, value: this.vis_configs[key], message: 'The y-axis only supports floats and integers. Please specify a different variable.' });
                }
            }
            else if (key === 'color') {
                let test_val = this.firstNonNull(this.data[this.vis_configs[key]]);
                if (typeof test_val !== 'number'){
                    incorrect.push({ key: key, value: this.vis_configs[key], message: 'The color variable only supports floats and integers. Please specify a different column on your dataset or verify the datatype of this column.' });
                }
            }
            else if (key === 'categorical'){
                let test_val = this.firstNonNull(this.data[this.vis_configs[key]]);
                // For categorical variables, coerce data to strings if necessary.
                if(typeof test_val !== 'string'){
                    // Coerce the column data at this.data[this.vis_configs[key]]
                    this.data[this.vis_configs[key]] = this.coerceColumnToString(this.data[this.vis_configs[key]]);
                    // Re-check the data type after coercion
                    test_val = this.firstNonNull(this.data[this.vis_configs[key]]);
                    if(test_val !== undefined && typeof test_val !== 'string'){
                        incorrect.push({ key: key, value: this.vis_configs[key], message: 'The categorical view only supports categorical variables formatted as strings. Please specify a different column on your dataset or reformat an existing column.' });
                    }
                }
            }
        }
        return incorrect;
    }

}

export {Validator};