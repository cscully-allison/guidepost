import * as d3 from "https://esm.sh/d3@7";
// import * as d3 from "d3";


//layout vars
const FACET_LAYOUT = {
    outer_margin: 30
}

const OVERVIEW_LAYOUT = {
    width: 1000,
    height: 300,
    outer_margin: 10,
    inner_padding: 30
}

const HISTOGRAM_LAYOUT = {
    width: OVERVIEW_LAYOUT.width,
    height: 100,
    outer_margin: 10,
    inner_padding: 30
}


const VERT_HISTOGRAM_LAYOUT = {
    width: 200,
    height: OVERVIEW_LAYOUT.height,
    outer_margin: 10,
    inner_padding: 0
}

const CAT_HISTOGRAM_LAYOUT = {
    width: VERT_HISTOGRAM_LAYOUT.width+20,
    height: HISTOGRAM_LAYOUT.height,
    outer_margin: 0,
    inner_padding: 30,
    top_padding: 45,
    left_padding: 0,
    bottom_title_margin: 25
}

const LEGEND_LAYOUT = {
    width: 100,
    height: OVERVIEW_LAYOUT.height,
    outer_margin: 10,
    inner_padding: 30,
    top_padding: 45,
    left_padding: 20,
    right_padding: 50
}

const X_VARIABLE_OFFSET = LEGEND_LAYOUT.width;
const Y_VARIABLE_OFFSET = 0;

const num_rows = 50;
const num_cols = 150;

const MIN_BAR_WIDTH = 45;

const SHARED_X_SCALE = false

// COLORS
const BLUE = 'rgba(32, 61, 192, 0.7)';
const RICH_BLUE = 'rgb(32, 61, 192)';

const TAN = 'rgb(215, 194, 191)';
const RICH_TAN = 'rgb(180, 144, 139)';

let draw_width = OVERVIEW_LAYOUT.width-2*OVERVIEW_LAYOUT.inner_padding;
let draw_height = OVERVIEW_LAYOUT.height - 2*OVERVIEW_LAYOUT.inner_padding;
let total_hist_height = HISTOGRAM_LAYOUT.height + HISTOGRAM_LAYOUT.outer_margin;
let zoom_factor_h = 3;
let zoom_factor_v = 10;



class JSModel{
    constructor(data, var_specifications, anywidget_model){
        this.data = this.list_major(data);
        this.data = this.facet(this.data, var_specifications['facet_by']);
        this.facets = Object.keys(this.data);
        this.vars = var_specifications;
        this.anywidget_model = anywidget_model;
        this.views = {};
        this.color_scale_range = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
        this.log_values_floor = 1;
        this.y_axis_thresholds = {};
        this.x_axis_thresholds = {};
        this.scale_types = {};

        this.faceted_states = {};
        this.brushed_ranges = {};
        this.brushed_data = {};
        for(let facet of this.facets){
            this.brushed_ranges[facet] = {
                x_range: [],
                y_range: []
            }
            this.brushed_data[facet] = [];
            this.faceted_states[facet] = {
                filter: [], 
                original_bins: "",
                pinned_category: {}
            };
        }



        //faceted derived data
        this.faceted_sum_stats = {};
        this.faceted_bins = {};
        
        this.row_major_counts = {};
        this.total_row_major_counts = {};
        
        this.categorical_bins = {};
        this.total_categorical_bins = {};

        this.x_axis_time_window_ticks = d3.utcWeek.every(1);
        this.x_axis_time_window = d3.utcDay.every(1);

        this.sanitize_and_intialize_data(this.data);

        for(let facet of this.facets){
            this.faceted_states[facet].original_bins = JSON.stringify(this.faceted_bins[facet]);        
        }

    }

    /**
     * Adds a specified number of days to a date. (Copied from stackoverflow)
     * @param {Date} date - The original date.
     * @param {number} days - The number of days to add.
     * @returns {Date} - The new date with the added days.
     */
    addDays(date, days){
        const newDate = new Date(date);
        newDate.setDate(date.getDate()+days);
        return newDate;
    }

    /**
     * Converts a dictionary to a list-major format.
     * @param {Object} dict - The dictionary to convert.
     * @returns {Array} - The list-major formatted data.
     */
    list_major(dict){
        var list = [];

        let record_indexes = Object.keys(dict[Object.keys(dict)[0]])
        let records = record_indexes.length;
        for(let i of record_indexes){
            let list_major_record = {};
            for(let key of Object.keys(dict)){
                list_major_record[key] = dict[key][i];
            }
            list_major_record["index"] = i;
            list.push(list_major_record);
        }
        return list
    }

    /**
     * Facets the data based on a specified column.
     * @param {Array} data - The data to facet.
     * @param {string} col - The column to use for faceting.
     * @returns {Object} - The faceted data.
     */
    facet(data, col){
        // facets the data based on passed column
        var facets = Object.groupBy(data, function(e){return e[col]})
        return facets
    }

    /**
     * Converts a specified column in the data to date format.
     * @param {Array} data - The data to convert.
     * @param {string} col - The column to convert to date format.
     * @returns {Array} - The data with the column converted to date format.
     */
    convert_to_date(data, col){
        for(let r in data){
            data[r][col] = new Date(data[r][col]);
        }
        
        return data;
    }
    
    /**
     * Sanitizes data for log scale by replacing zero values with one.
     * @param {Array} data - The data to sanitize.
     * @param {string} col - The column to sanitize.
     * @returns {Array} - The sanitized data.
     */
    sanitize_data_for_log(data, col){
        data.forEach((element, i, arr) => {
            //setting to 1 in this context is ok at
            // the resolution of analysis we are doing
            // diff 1 sec vs. 0 sec is functionally
            // the same
            if (element[col] == 0){
                arr[i][col] = 1;
            }
        });
    
        return data; 
    }

    /**
     * Sets the x-axis variable for the model.
     * @param {string} x - The x variable to set.
     */
    set_x_var(x){
        this.vars.x = x;
    }

    /**
     * Sets the y-axis variable for the model.
     * @param {string} y - The y variable to set.
     */
    set_y_var(y){
        this.vars.y = y;
    }

    /**
     * Sets the color variable for the model.
     * @param {string} color - The color variable to set.
     */
    set_color_by_var(color){
        this.vars.color = color;
    }

    /**
     * Gets summary statistics for a specified column in the data.
     * @param {Array} data - The data to analyze.
     * @param {string} col - The column to get summary statistics for.
     * @returns {Object} - The summary statistics for the column.
     */
    get_summary_stats(data, col, index){
        let sum_stats = {};

        if(data.length > 0){
            sum_stats.min = data.reduce((prev, curr) => prev[col] < curr[col] ? prev : curr)[col];
            sum_stats.max = data.reduce((prev, curr) => prev[col] > curr[col] ? prev : curr)[col];
            if(typeof(data[col]) != typeof("")){
                sum_stats.sum = data.reduce((acc, current) => {
                    if (isNaN(current[col])){
                        return 0;
                    }
                    return acc + current[col];
                }, 0);
                sum_stats.avg = sum_stats.sum / data.length;
                let var_std = this.calculateStandardDeviation(data, sum_stats.avg, col);
                sum_stats.variance = var_std[0];
                sum_stats.std = var_std[1];
            }
    
            // get an array of just the y property values
            var keyArray = data.map(function(item) { return item[col]; });
            keyArray.sort(d3.ascending);
    
            // calculate a lower quantile of this array
            sum_stats.q1 = d3.quantile(keyArray, 0.25);
            sum_stats.q2 = d3.quantile(keyArray, 0.50);
            sum_stats.q3 = d3.quantile(keyArray, 0.75);

            //aliases

            sum_stats.median = sum_stats.q2;
            sum_stats.med = sum_stats.median;
            sum_stats.var = sum_stats.variance;
            sum_stats.average = sum_stats.avg;
            sum_stats.mean = sum_stats.avg;
            sum_stats.count = data.length;
        }
        else{
            sum_stats.sum = 0;
            sum_stats.avg = 0;
            sum_stats.average = 0;
            sum_stats.mean = 0;
            sum_stats.std = 0;
            sum_stats.variance = 0;
            sum_stats.var = 0;
            sum_stats.std = 0;
            sum_stats.median = 0;
            sum_stats.med = 0;
            sum_stats.count = 0;
        }

        
        sum_stats.index = index;

    
        return sum_stats;
    }

    /**
     * Generates an array of linear scale values between a minimum and maximum value.
     * @param {number} min - The minimum value.
     * @param {number} max - The maximum value.
     * @param {number} numValues - The number of values to generate.
     * @returns {Array<number>} - The generated array of values.
     */
    linearScale(min, max, numValues) {
        if (typeof min !== 'number' || typeof max !== 'number' || typeof numValues !== 'number') {
            throw new Error("All arguments must be numbers");
        }
        if (numValues <= 1) {
            throw new Error("The number of intervals must be greater than 1");
        }

        const step = (max - min) / (numValues - 1);
        const values = [];

        for (let i = 0; i < numValues; i++) {
            values.push(min + i * step);
        }

        return values;
    }

    /**
     * Generates an array of log scale values between a minimum and maximum value.
     * @param {number} min - The minimum value.
     * @param {number} max - The maximum value.
     * @param {number} numValues - The number of values to generate.
     * @returns {Array} - The generated log scale values.
     */
    logScale(min, max, numValues) {
        const values = [];
        const logMin = Math.log10(min);
        const logMax = Math.log10(max);
        const step = (logMax - logMin) / (numValues - 1);
        
        for (let i = 0; i < numValues; i++) {
            const logValue = logMin + step * i;
            const value = Math.pow(10, logValue); // Convert back to linear scale
            values.push(value);
        }
    
        return values;
    }

    /**
     * Calculates the standard deviation for a specified column in the data.
     * @param {Array} data - The data to analyze.
     * @param {number} mean - The mean value of the column.
     * @param {string} key - The column to calculate standard deviation for.
     * @returns {Array} - The variance and standard deviation of the column.
     */
    calculateStandardDeviation(data, mean, key) {
        const n = data.length;
        if (n === 0) return 0; // Avoid division by zero
    
        const squaredDiffs = data.map(item => {
            const value = item[key];
            const diff = value - mean;
            return diff * diff;
        });
    
        const variance = squaredDiffs.reduce((sum, value) => sum + value, 0) / n;
        return [variance, Math.sqrt(variance)];
    }

    /**
     * Tests if two input variables, min and max, are different by more than two orders of magnitude.
     * @param {number} min - The minimum value.
     * @param {number} max - The maximum value.
     * @param {number} order - Order of mangintude to test difference against
     * @returns {boolean} - True if the difference is more than two orders of magnitude, false otherwise.
     */
    is_more_than_n_orders_of_magnitude(min, max, order) {
        if (typeof min !== 'number' || typeof max !== 'number') {
            throw new Error("Both min and max must be numbers");
        }
        return Math.log10(max) - Math.log10(min) > order;
    }

  
    //box bins for a column
    binValues(values, thresholds, accessor) {
        const bins = [];
        // Create an empty bin for each interval between consecutive thresholds
        for (let i = 0; i < thresholds.length - 1; i++) {
            bins.push([]);
        }
        // Place each value in the appropriate bin
        values.forEach(d => {
            const val = accessor(d);
            for (let i = 0; i < thresholds.length - 1; i++) {
                // For the last bin, include values equal to the upper bound
                if (val >= thresholds[i] && (i === thresholds.length - 2 || val < thresholds[i + 1])) {
                    bins[i].push(d);
                    break;
                }
            }
        });
        return bins;
    }


    /**
     * Calculates metrics for the rectangles of the summary view for a specified facet. Bins come into this function already oragnized 
     * into columns delinated by the x_axis_thresholds. It's a user specified datetime variable.
     * @param {string} fac - The facet to calculate metrics for.
     * @param {Array} x_axis_thresholds - The time values that delinate individual columns in the final visualization.
     * @param {Array} y_axis_thresholds - The thresholds that delinate individual rows in the final visualization
     */
    calculate_box_metrics(fac, x_axis_thresholds, y_axis_thresholds){
        let current_bins = this.faceted_bins[fac].column;
        let sum_stats = this.faceted_sum_stats[fac];

        // console.log("CALC BOX METRICS: ", fac, current_bins, x_axis_thresholds, y_axis_thresholds);

        // Iterate over the columns that divide the data along the x axis
        
        let col_indx = 0;
        for(let bin in current_bins){
            let filtered_bin;
            
            //Do not filter if no filter is specified currently
            if(this.faceted_states[fac].filter.length > 0){
                filtered_bin = current_bins[bin].column_values.filter((d)=>{return this.faceted_states[fac].filter.includes(d[this.vars.categorical])});
            }else{
                if(current_bins[bin].column_values){
                    filtered_bin = current_bins[bin].column_values;
                }
                else{
                    filtered_bin = current_bins[bin];
                }
            }

            // Get summary statistics for the entire column of data before it is split into rows
            let temp_box_stats = this.get_summary_stats(filtered_bin, this.vars.y, col_indx);
            temp_box_stats.threshold = x_axis_thresholds[bin];

            temp_box_stats.bins = [];
          
            const customBins = this.binValues(filtered_bin, y_axis_thresholds, d => d[this.vars.y]);

            // Process each bin's summary statistics and update color scale range
            temp_box_stats.bins = customBins.map((bin, index) => {
                const stats = this.get_summary_stats(bin, this.vars.color);
                stats.values = bin;
                stats.std_ratio = stats.std / this.faceted_sum_stats[fac].color.std;
                stats.threshold = y_axis_thresholds[index];
                this.color_scale_range[0] = Math.min(this.color_scale_range[0], stats[this.vars.color_agg] ? stats[this.vars.color_agg] : this.color_scale_range[0]);
                this.color_scale_range[1] = Math.max(this.color_scale_range[1], stats[this.vars.color_agg]);
                return stats;
            });


            temp_box_stats.column_values = filtered_bin;
            this.faceted_bins[fac].column[bin] = temp_box_stats;
            col_indx += 1;
        }

    }

    /**
     * Sanitizes and initializes the data for the model.
     * @param {Array} data - The data to sanitize and initialize.
     * @returns {Array} - The sanitized and initialized data.
     */
    sanitize_and_intialize_data(data){
        this.global_sum_stats = {
            x:{
                max: Number.MIN_SAFE_INTEGER,
                min: Number.MAX_SAFE_INTEGER
            },
            y:{
                max: Number.MIN_SAFE_INTEGER,
                min: Number.MAX_SAFE_INTEGER
            },
            color:{
                max: Number.MIN_SAFE_INTEGER,
                min: Number.MAX_SAFE_INTEGER
            },
            num_cols: 0
        };
        for(let fac of this.facets){
            //store data about what types of scales x and y are
            this.scale_types[fac] = {
                'x':{
                   'log': false,
                   'linear': false,
                   'datetime': false 
                },
                'y':{
                   'log': false,
                   'linear': false,
                   'datetime': false
                }
            };

            if(typeof(data[fac][0][this.vars.x]) === 'string'){
                data[fac] = this.convert_to_date(data[fac], this.vars.x);
            }else{
                data[fac] = this.sanitize_data_for_log(data[fac], this.vars.x);
            }



            data[fac] = this.sanitize_data_for_log(data[fac], this.vars.y);

            this.faceted_sum_stats[fac] = {};
            this.faceted_sum_stats[fac].x = this.get_summary_stats(data[fac], this.vars.x);
            this.faceted_sum_stats[fac].y = this.get_summary_stats(data[fac], this.vars.y);
            this.faceted_sum_stats[fac].color = this.get_summary_stats(data[fac], this.vars.color);

            let sum_stats = this.faceted_sum_stats[fac];

            this.global_sum_stats.x.max = Math.max(this.faceted_sum_stats[fac].x.max, this.global_sum_stats.x.max);
            this.global_sum_stats.y.max = Math.max(this.faceted_sum_stats[fac].y.max, this.global_sum_stats.y.max);
            this.global_sum_stats.color.max = Math.max(this.faceted_sum_stats[fac].color.max, this.global_sum_stats.color.max);

            this.global_sum_stats.x.min = Math.min(this.faceted_sum_stats[fac].x.min, this.global_sum_stats.x.min);
            this.global_sum_stats.y.min = Math.min(this.faceted_sum_stats[fac].y.min, this.global_sum_stats.y.min);
            this.global_sum_stats.color.min = Math.min(this.faceted_sum_stats[fac].color.min, this.global_sum_stats.color.max);

            
            this.faceted_bins[fac] = {}
            


            // console.log("SUM STATS: ", fac, sum_stats, "blahaj");

            //conditional x axis thresholds based on time or numbers
            // important for calculating the scales which layout the columns
            // of the "heatmap"
            if(sum_stats.x.min instanceof Date){
                this.scale_types[fac].x.datetime = true;
                this.x_axis_thresholds[fac] = d3.scaleUtc().domain([new Date(sum_stats.x.min), this.addDays(new Date(sum_stats.x.max),1)]).ticks(this.x_axis_time_window);
                this.faceted_bins[fac].column = d3.bin()
                                                    .value(d => d[this.vars.x])
                                                    .domain([new Date(sum_stats.x.min), new Date(sum_stats.x.max)])
                                                    .thresholds(this.x_axis_thresholds[fac])(data[fac])
            } 
            else if(typeof sum_stats.x.max === 'number'){
                //Set thresholds used for defining columns based off of whether the data is wide enough to merit a log scale
                // just do linerats if not
                if(this.is_more_than_n_orders_of_magnitude(sum_stats.x.min, sum_stats.x.max, 3)){
                    this.scale_types[fac].x.log = true;
                    this.x_axis_thresholds[fac] = this.logScale(this.log_values_floor, sum_stats.x.max+1, num_cols-1);
                    this.faceted_bins[fac].column = d3.bin()
                                                    .value(d => d[this.vars.x])
                                                    .domain([this.log_values_floor, sum_stats.x.max])
                                                    .thresholds(this.x_axis_thresholds[fac])(data[fac]);

                }
                else{
                    this.scale_types[fac].x.linear = true;
                    this.x_axis_thresholds[fac] = this.linearScale(sum_stats.x.min, sum_stats.x.max+1, num_cols-1);
                    this.faceted_bins[fac].column = d3.bin()
                                                    .value(d => d[this.vars.x])
                                                    .domain([sum_stats.x.min, sum_stats.x.max])
                                                    .thresholds(this.x_axis_thresholds[fac])(data[fac]);
                }
            }
            
            //check if y is log or linear based on spread of data
            if(this.is_more_than_n_orders_of_magnitude(sum_stats.y.min, sum_stats.y.max, 3)){
                this.scale_types[fac].y.log = true;
                this.y_axis_thresholds[fac] = this.logScale(this.log_values_floor, sum_stats.y.max, num_rows);
            } else {
                this.scale_types[fac].y.linear = true;
                this.y_axis_thresholds[fac] = this.linearScale(sum_stats.y.min, sum_stats.y.max, num_rows);
            }

            sum_stats.col_counts = {
                min: Number.MAX_SAFE_INTEGER,
                max: Number.MIN_SAFE_INTEGER
            };

            for(let bin of this.faceted_bins[fac].column){
                sum_stats.col_counts.max = Math.max(sum_stats.col_counts.max, bin.length);
                sum_stats.col_counts.min = Math.min(sum_stats.col_counts.min, bin.length);
            }
            
            this.global_sum_stats.num_cols = Math.max(this.faceted_bins[fac].column.length, this.global_sum_stats.num_cols);

            this.calculate_box_metrics(fac, this.x_axis_thresholds[fac], this.y_axis_thresholds[fac]);
            this.calc_row_major_counts(fac);

            let cat_counts = {};
            for(let record of data[fac]){
                if( !cat_counts[record[this.vars.categorical]] ){
                    cat_counts[record[this.vars.categorical]] = 0;
                }
                cat_counts[record[this.vars.categorical]] += 1;
            }

            this.categorical_bins[fac] = Object.keys(cat_counts).map((key) => { return {"key": key, "val":cat_counts[key]} }).sort((a, b) => b['val'] - a['val']);
        }


        return data;
    }

    /**
     * Calculates row major counts for a specified facet.
     * @param {string} fac - The facet to calculate row major counts for.
     */
    calc_row_major_counts(fac){
        let row_counts = Array(this.faceted_bins[fac].column[0].bins.length).fill(0);
        for(let column of this.faceted_bins[fac].column){
            for(let row in column.bins){
                row_counts[row] += column.bins[row].values.length;
            }
        }

        this.row_major_counts[fac] = row_counts;
        this.total_row_major_counts[fac] = row_counts;
    }

    /**
     * Filters data by a specified category.
     * @param {Array} filter - The filter to apply.
     * @param {string} facet - The facet to filter.
     * @param {string} source - The source of the filter.
     * @param {Array} targets - The targets to update.
     */
    filter_data_by_category(filter, facet, source, targets){

        this.faceted_states[facet].filter = filter;

        // is anything pinned
        // if so iterate through all pinned items
        // and if they are pinned push them on
        // if they are not already in this list
        if(this.is_any_category_pinned(facet)){
            for(let cat of Object.keys(this.faceted_states[facet].pinned_category)){
                if(this.faceted_states[facet].pinned_category[cat]){
                    filter.indexOf() === -1 ? filter.push(cat) : null 
                }
            }
        }


        this.faceted_bins[facet] = JSON.parse(this.faceted_states[facet].original_bins);

        if(filter.length > 0){
            // this.faceted_states[facet].original_bins = JSON.stringify(this.faceted_bins[facet]);
            this.calculate_box_metrics(facet, this.x_axis_thresholds[facet], this.y_axis_thresholds[facet]);
        }

        this.update_subselected_data(facet, targets, [], "", true);
        this.calc_row_major_counts(facet);

        for(let target of targets){
            this.manage_render(target);
        }
    }

    /**
     * Updates the subselection data based on brush selection. Most of the code is to catch edge cases where one histogram is not
     * brushed.
     * @param {string} facet - The facet to update.
     * @param {Array} targets - The targets to update.
     * @param {Array} selection - The selection range.
     * @param {string} range - The range type ("x" or "y").
     * @param {Boolean} no_render - prevent double renders when called from a function which will also render
     */
    update_subselected_data(facet, targets, selection, range, no_render){
        this.brushed_data[facet] = [];
        if(range == "x"){
            this.brushed_ranges[facet].x_range = selection;
        }
        else if(range == "y"){
            this.brushed_ranges[facet].y_range = selection;
        }
        else{

        }


        if(this.brushed_ranges[facet].x_range.length != 0){
            for(let bin of this.faceted_bins[facet].column){
                let test_threshold = bin.threshold;
                if(this.scale_types[facet].x.datetime){
                    test_threshold = new Date(test_threshold);
                }
                if(test_threshold >= this.brushed_ranges[facet].x_range[0] && 
                    test_threshold <= this.brushed_ranges[facet].x_range[1]){
                        if (this.brushed_ranges[facet].y_range.length == 0){
                            this.brushed_data[facet] = this.brushed_data[facet].concat(bin.column_values);
                        }
                        else{
                            for(let row in bin.bins){
                                if(row >= this.brushed_ranges[facet].y_range[1] &&
                                    row < this.brushed_ranges[facet].y_range[0]
                                ){
                                    this.brushed_data[facet] = this.brushed_data[facet].concat(bin.bins[row].values);
                                }
                            }
                        }
                    }
            }
        }
        else if(this.brushed_ranges[facet].y_range.length != 0){
            for(let bin of this.faceted_bins[facet].column){
                for(let row in bin.bins){
                    if(row >= this.brushed_ranges[facet].y_range[1] &&
                        row < this.brushed_ranges[facet].y_range[0]
                    ){
                        this.brushed_data[facet] = this.brushed_data[facet].concat(bin.bins[row].values);
                    }
                }
            }
        }

        let return_ids = [];
        let test = [];
        for(let fac of this.facets){
            for(let d of this.brushed_data[fac]){
                return_ids.push(d.gp_idx);
                test.push({'idx':d.gp_idx, 'content':d});
            }
        }

        this.anywidget_model.set("selected_records", JSON.stringify(return_ids));
        this.anywidget_model.save_changes();

        if(!no_render){
            for(let target of targets){
                this.manage_render(target);
            }
        }
    }

    /**
     * Updates the data for the model.
     * @param {Array} data - The new data to update.
     */
    update_data(data){
        this.data = this.list_major(data);
        this.data = this.facet(this.data, this.var_specifications['facet_by']);
        this.facets = Object.keys(data);
    }

    /**
     * Adds a view to the model.
     * @param {string} token - The token for the view.
     * @param {Object} view - The view to add.
     */
    add_view(token, view){
        this.views[token] = view;
    }

    /**
     * Updates row counts for a specified facet for the purposes of drawing the rows of the
     * summary view of the histogram 
     * @param {string} source_token - The source token.
     * @param {string} target_token - The target token.
     * @param {string} facet - The facet to update.
     * @param {Array} new_bins - The new bins to update.
     */
    update_row_counts(source_token, target_token, facet, new_bins){
        if(Object.keys(new_bins).length != 0){
            let bin_counts = new Array(new_bins[Object.keys(new_bins)[0]].length).fill(0);
            for(let column in new_bins){
                for(let bin in new_bins[column]){
                    bin_counts[bin] += new_bins[column][bin].values.length;
                }
            }
            this.row_major_counts[facet] = bin_counts;
        }
        else{
            this.row_major_counts[facet] = this.total_row_major_counts[facet];
        }

        this.manage_render(target_token);
    }

    /**
     * Manages rendering of a specified view based on the views associated "token".
     * This is functionally a MVVM architecture that cuts out the controller compared to a traditional
     * MVC approach
     * @param {string} token - The token for the view to render.
     */
    manage_render(token){
        this.views[token].render();
    }

    /**
     * Pins or unpins a clicked category.
     * @param {string} source_token - The source token.
     * @param {string} facet - The facet to update.
     * @param {string} category - The category to pin or unpin.
     */
    pin_unpin_clicked_category(source_token, facet, category){
        if(!Object.keys(this.faceted_states[facet].pinned_category).includes(category)){
            this.faceted_states[facet].pinned_category[category] = false;
        }
        this.faceted_states[facet].pinned_category[category] = !this.faceted_states[facet].pinned_category[category];
    }

    /**
     * Checks if a category is pinned.
     * @param {string} facet - The facet to check.
     * @param {string} category - The category to check.
     * @returns {boolean} - True if the category is pinned, false otherwise.
     */
    is_category_pinned(facet, category){
        if(!(Object.keys(this.faceted_states[facet].pinned_category).includes(category))){
            return false
        }
        return this.faceted_states[facet].pinned_category[category];
    }

    /**
     * Checks if any category is pinned.
     * @param {string} facet - The facet to check.
     * @returns {boolean} - True if any category is pinned, false otherwise.
     */
    is_any_category_pinned(facet){
        if(Object.keys(this.faceted_states[facet].pinned_category).length == 0){
            return false;
        }

        for(let cat in this.faceted_states[facet].pinned_category){
            if(this.faceted_states[facet].pinned_category[cat] == true){
                return true
            }
        }

        return false;
    }

}

class SmartScale {
    constructor(domain, range, model) {
        this.domain = domain;
        this.range = range;
        this.model = model;
        this.scale = this.get_scale();
    }

    /**
     * Determines the appropriate d3 scale based on the data type of the domain.
     * @returns {d3.Scale} - The appropriate d3 scale.
     */
    get_scale() {
        if (this.domain.every(d => d instanceof Date)) {
            return d3.scaleUtc().domain([this.domain[0], this.model.addDays(this.domain[1],1)]).range(this.range);
        } else if (this.domain.every(d => typeof d === 'number')) {
            if(this.model.is_more_than_n_orders_of_magnitude(this.domain[0], this.domain[1], 3)){
                return d3.scaleLog().domain([this.model.log_values_floor, this.domain[1]]).range(this.range);
            } else {
                return d3.scaleLinear().domain(this.domain).range(this.range);
            }
        } else {
            throw new Error("Unsupported domain type");
        }
    }

    /**
     * Gets the difference between two dates and returns if the difference is less than or equal to 1 year, less than 1 month, or less than 1 week.
     * @returns {string} - The difference category.
     */
    get_date_difference() {
        if (!this.domain.every(d => d instanceof Date)) {
            throw new Error("Domain values are not dates");
        }

        const [start, end] = this.domain;
        const diffInMs = end - start;
        const diffInDays = diffInMs / (1000 * 60 * 60 * 24);

        return diffInDays;
    }

    get_ticks(){
        // need conditionally sensitive ticks
        if (this.domain.every(d => d instanceof Date)) {
            let diffInDays = this.get_date_difference();
            if (diffInDays <= 7) {
                return d3.utcDay.every(1);
            } else if (diffInDays <= 30) {
                return d3.utcDay.every(1);
            } else if (diffInDays <= 365) {
                return d3.utcWeek.every(1);
            } else {
                return d3.utcMonth.every(1);
            }
        } else if (this.domain.every(d => typeof d === 'number')) {
            return 20;
        } else {
            throw new Error("Unsupported domain type");
        }
    }

}

class Heatmap{
    constructor(model, parent, facet, height, width, num_rows){
        // Initialize the Heatmap with model, parent element, facet, height, width, and number of rows
        this.model = model;
        this.parent = parent;
        this.facet = facet;
        this.height = height;
        this.width = width;
        this.view = parent.append('g').attr('class', 'heatmap');
        this.num_rows = num_rows;
        this.id_token = `${facet}_heatmap`;
        this.pinned_cols = [];
        this.cached_bins = {};

        this.scale_x = null;
        this.scale_x_utc = null;
        this.scale_y = null;
        this.scale_y_inverse = null;
        this.scale_color = null;

        this.update_scales();
        this.initial_render();
    }

    /**
     * Updates the scales for the heatmap based on the current data state defined by the model.
     */
    update_scales(){
        let sum_stats = this.model.faceted_sum_stats[this.facet];

        // this.scale_x = d3.scaleBand()
        //                             .domain(this.model.faceted_bins[this.facet].column.keys())
        //                             .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.width - OVERVIEW_LAYOUT.inner_padding]);
        

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


        //Determine if y scale is log or linear based on input data
        if(this.model.scale_types[this.facet].y.log){

            this.scale_y = d3.scaleLog()
                            .domain([this.model.log_values_floor, sum_stats.y.max])
                            .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);

            this.scale_y_inverse = d3.scaleLog()
                            .domain([sum_stats.y.max, this.model.log_values_floor])
                            .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);
        }
        else if(this.model.scale_types[this.facet].y.linear){
            this.scale_y = d3.scaleLinear()
                        .domain([sum_stats.y.min, sum_stats.y.max])
                        .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);

            this.scale_y_inverse = d3.scaleLinear()
                        .domain([sum_stats.y.max, sum_stats.y.min])
                        .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);
        }

        if(this.model.vars.color_agg != 'std_ratio'){
            this.scale_color = d3.scaleSequentialSymlog().interpolator(t=>d3.interpolatePurples(t+.2));
            this.scale_color.domain(this.model.color_scale_range);

            this.highlighted_scale_color = d3.scaleSequentialSymlog().interpolator(t=>d3.interpolateOranges(t+.2));
            this.highlighted_scale_color.domain(this.model.color_scale_range);
        }
        else{
            this.scale_color = d3.scaleDiverging().interpolator(t=>d3.interpolateRdYlBu((1-t) - .1));
            this.scale_color.domain([this.model.color_scale_range[0], 1, this.model.color_scale_range[1]]);
        }

        this.scale_y_blocks = d3.scaleLinear()
                        .domain([num_rows-2, -1])
                        .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);

    }

    /**
     * Performs the initial rendering of the heatmap.
     */
    initial_render(){
        const self = this;

        let x_offset = X_VARIABLE_OFFSET + OVERVIEW_LAYOUT.outer_margin;
        let y_offset = Y_VARIABLE_OFFSET + OVERVIEW_LAYOUT.outer_margin;
        
        let view = this.parent.append('g')
                    .attr('class', 'faceted_view')
                    .attr('transform', (d, i)=>`translate(${x_offset},${y_offset})`)
                    .attr('width', this.width)
                    .attr('height', this.height);


        let axis_left = d3.axisLeft().scale(this.scale_y_inverse);
        if(this.model.scale_types[this.facet].y.linear){
            axis_left.tickFormat(d3.format(".2s"));
        }

        view.append('g')
            .attr('class', 'left-axis')
            .call(axis_left)   
            .attr('transform', `translate(${OVERVIEW_LAYOUT.inner_padding},${0})`);

        view.append('g')
            .attr('class', 'bottom-axis')
            .call(d3.axisBottom().scale(this.scale_x.scale).ticks(this.scale_x.get_ticks())) 
            .attr('transform', `translate(${0},${OVERVIEW_LAYOUT.height-OVERVIEW_LAYOUT.inner_padding})`)

        
        view.append('text')
            .text(`Group: ${this.facet}`)
            .attr('baseline', 'bottom')
            .attr('anchor', 'middle')
            .attr('x', (draw_width)/2)
            .attr('y', OVERVIEW_LAYOUT.inner_padding - 10);


        view.append('text')
                .text(()=>{
                    if(this.model.scale_types[this.facet].y.linear){
                        return this.model.vars.y;
                    }
                    return this.model.vars.y+'(log)'
                })
                .attr('text-anchor', 'middle')
                .attr('transform', `translate(${-10},${this.height/2}) rotate(270)`);

        this.view = view;
    }

    /**
     * Draws sparklines (placeholder function).
     * @param {Event} e - The event object.
     * @param {Object} d - The data object.
     */
    draw_sparklines(e, d){
        // console.log(e, d);
    }

    manage_highlight(col_data, row_num){
        const self = this;

        //fill row if only y axis is brushed
        if(self.model.brushed_ranges[self.facet].y_range.length != 0 
            && self.model.brushed_ranges[self.facet].x_range.length == 0){
            if(parseInt(row_num) >= self.model.brushed_ranges[self.facet].y_range[1] 
                && parseInt(row_num) < self.model.brushed_ranges[self.facet].y_range[0]){
                return self.highlighted_scale_color(col_data.bins[row_num][self.model.vars.color_agg]);
            }
        }

        let test_threshold = col_data.threshold;
        if(self.model.scale_types[self.facet].x.datetime){
            test_threshold = new Date(test_threshold);
        }
        //fill columns only if x axis is brushed
        if(self.model.brushed_ranges[self.facet].x_range.length != 0
            && self.model.brushed_ranges[self.facet].y_range.length == 0){
            if(test_threshold >= self.model.brushed_ranges[self.facet].x_range[0] 
                && test_threshold <= self.model.brushed_ranges[self.facet].x_range[1]){
                    return self.highlighted_scale_color(col_data.bins[row_num][self.model.vars.color_agg]);
            }
        }

        else if(self.model.brushed_ranges[self.facet].y_range.length != 0 
            && self.model.brushed_ranges[self.facet].x_range.length != 0){
            if(parseInt(row_num) >= self.model.brushed_ranges[self.facet].y_range[1] 
                && parseInt(row_num) < self.model.brushed_ranges[self.facet].y_range[0]
                && test_threshold >= self.model.brushed_ranges[self.facet].x_range[0] 
                && test_threshold <= self.model.brushed_ranges[self.facet].x_range[1]){
                return self.highlighted_scale_color(col_data.bins[row_num][self.model.vars.color_agg]);
            }
        }


        


        return self.scale_color(col_data.bins[row_num][self.model.vars.color_agg]);
    }

    /**
     * Raises and zooms on a column slightly
     */
    focus_col(update_element){
        let self = this;
        let base_width;
        if(SHARED_X_SCALE){
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.global_sum_stats.num_cols))
        }
        else{
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.faceted_bins[self.facet].column.length))
        }
       
        self.scale_y_blocks.range([OVERVIEW_LAYOUT.inner_padding-(zoom_factor_v/2), OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding + (zoom_factor_v/2)]);

        update_element.raise();
        
        update_element.selectAll('.row')
                .attr('width', ()=>{return base_width + zoom_factor_h})
                .attr('height', ()=>{return ( (OVERVIEW_LAYOUT.height + zoom_factor_v) - 2*OVERVIEW_LAYOUT.inner_padding) / self.model.faceted_bins[self.facet].column[0].bins.length})
                .attr('y', (d, i)=>{return self.scale_y_blocks(i) - OVERVIEW_LAYOUT.inner_padding});
            
        update_element.selectAll('.col-bg')
            .attr('width', ()=>{return base_width + zoom_factor_h})
            .attr('height', ()=>{return ( (OVERVIEW_LAYOUT.height + zoom_factor_v) - 2*OVERVIEW_LAYOUT.inner_padding)})
            .attr('y', -(zoom_factor_v/2));
            
    
        update_element.attr('transform', (d)=>{
                if(typeof(d.threshold) === 'string'){
                    return `translate(${self.scale_x.scale(new Date(d.threshold))}, ${OVERVIEW_LAYOUT.inner_padding})`
                }
                return `translate(${self.scale_x.scale(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`;
            });
    }

    /**
     * Resets a column back to original dimensions
     */
    unfocus_col(update_element){
        let self = this;
        let base_width;
        if(SHARED_X_SCALE){
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.global_sum_stats.num_cols))
        }
        else{
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.faceted_bins[self.facet].column.length))
        }
       
        self.scale_y_blocks.range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);


        update_element.selectAll('.col-bg')
            .attr('width', base_width)
            .attr('height', ()=>{return draw_height})
            .attr('y', 0);


        update_element.selectAll('.row')  
            .attr('width', base_width)
            .attr('height', (d)=>{return draw_height / self.model.faceted_bins[self.facet].column[0].bins.length})
            .attr('y', (d,i)=>{return self.scale_y_blocks(i) - OVERVIEW_LAYOUT.inner_padding});

        update_element.attr('transform', (d)=>{       
                if(typeof(d.threshold) === "string"){
                    return `translate(${self.scale_x.scale(new Date(d.threshold))}, ${OVERVIEW_LAYOUT.inner_padding})`
                }
                return `translate(${self.scale_x.scale(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`
            });
    }

    /**
     * Formats a number with commas every three digits.
     * @param {number} num - The number to format.
     * @returns {string} - The formatted number.
     */
    format_number_with_commas(num) {
        if (typeof num !== 'number') {
            throw new Error("Input must be a number");
        }
        return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /**
     * Formats the output of Date.toUTCString() to remove the time.
     * @param {Date} date - The date to format.
     * @returns {string} - The formatted date string without the time.
     */
    format_utc_date(date) {
        if (!(date instanceof Date)) {
            throw new Error("Input must be a Date object");
        }
        return date.toUTCString().split(' ').slice(0, 4).join(' ');
    }

    /**
     * Renders the heatmap by updating the DOM elements based on the current data.
     */
    render(){
        const self = this;


        let base_width = 0;
        if(SHARED_X_SCALE){
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.global_sum_stats.num_cols))
        }
        else{
            base_width = Math.min(MIN_BAR_WIDTH, (draw_width / self.model.faceted_bins[self.facet].column.length))
        }

        

        if(self.model.row_major_counts[self.facet].length < 2){
            this.view
                .append('text')
                .text(`There are too few datapoints in this category: ${self.facet}. To remove this chart, please filter this category from the original dataset.`)
                .attr('text-anchor', 'middle')
                .attr('transform', `translate(${draw_width/2},${draw_height/2})`)
        }   
        else{

            this.view
            .selectAll('.column')
            .data(this.model.faceted_bins[this.facet].column)
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
                        .attr('class', 'col-bg')
                        .attr('height', OVERVIEW_LAYOUT.height - 2*OVERVIEW_LAYOUT.inner_padding)
                        .attr('width', base_width)
                        .attr('fill', '#ffffff');

                    let date  = col.append('g')
                        .attr('class', 'text-field')
                        .attr('transform', `translate(${0}, ${-20})`)
                        .style('visibility', (d)=>{
                            if(self.pinned_cols.includes(String(new Date(d.threshold)))){
                                return 'visible';
                            }
                            return 'hidden';
                        });
                        
                    date.append('rect')
                        .attr('class', 'text-bg')
                        .attr('height', 15)
                        .attr('width', 150)
                        .attr('fill', 'white');
                        
                    date.append('text')
                        .attr('fill', 'black')
                        .text((data)=>{
                            if(self.model.scale_types[self.facet].x.datetime){
                                return `${self.format_utc_date(new Date(data.threshold))} (Local: ${new Date(data.threshold).toLocaleDateString()})`;
                            }
                            else{
                                let current_threshold_index = self.model.x_axis_thresholds[self.facet].indexOf(data.threshold);
                                return `Records for '${self.model.vars.x}' range: (${self.format_number_with_commas(Math.floor(data.threshold))} - ${self.format_number_with_commas(Math.floor(self.model.x_axis_thresholds[self.facet][current_threshold_index+1]))})`;
                            }
                        })
                        .attr('text-anchor', 'middle');

                    col.each(
                        function (column){
                            for(let row in column.bins){
                                d3.select(this)
                                    .append('rect')
                                    .attr('class', 'row')
                                    .attr('width', base_width)
                                    .attr('height', (d)=>{return draw_height / column.bins.length})
                                    .attr('y', ()=>{return self.scale_y_blocks(row) - OVERVIEW_LAYOUT.inner_padding})
                                    .attr('x', ()=>{return 0})
                                    .attr('fill', (d)=>{
                                        if(column.bins[row].values.length == 0){
                                            return 'rgba(240,240,240)'
                                        }
                                        return self.scale_color(column.bins[row][self.model.vars.color_agg])
                                    })
                            }
                        }
                    )
                    col.on('mouseenter', function (e, d){
                        delete self.cached_bins['hover'];

                        console.log("HOVERING OVER: ", d);

                        self.focus_col(d3.select(e.target));
                        if(!Object.keys(self.cached_bins).includes(String(d.threshold))){
                            let dt_text_selection = d3.select(e.target).select('.text-field');
                            dt_text_selection.style('visibility', 'visible')
                                .select('text')
                                .text((data)=>{
                                    if(self.model.scale_types[self.facet].x.datetime){
                                        return `${self.format_utc_date(new Date(data.threshold))} (Local: ${new Date(data.threshold).toLocaleDateString()})`;
                                    }
                                    else{
                                        let current_threshold_index = self.model.x_axis_thresholds[self.facet].indexOf(data.threshold);
                                        return `Records for '${self.model.vars.x}' range: (${self.format_number_with_commas(Math.floor(data.threshold))} - ${self.format_number_with_commas(Math.floor(self.model.x_axis_thresholds[self.facet][current_threshold_index+1]))})`;
                                    }
                                });

                            d3.select(e.target)
                                .select('.text-bg')
                                .attr('width', ()=>{
                                    return d3.select(e.target).select('.text-field').select('text').node().getBBox().width + 10;
                                }).attr('transform', `translate(${-(d3.select(e.target).select('.text-field').select('text').node().getBBox().width/2)},${0})`)
                            
                            self.cached_bins['hover'] = d.bins
                        }

                        
                        self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, self.cached_bins);
                    })
                    .on('mouseleave', function(e,d){
                        if(!Object.keys(self.cached_bins).includes(String(new Date(d.threshold)))){
                            self.unfocus_col(d3.select(e.target));
                            d3.select(e.target)
                                .select('.text-field')
                                .style('visibility', 'hidden');
                        }
            
                        delete self.cached_bins['hover'];
                        self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, self.cached_bins);
                    })
                    // CUTTING PIN FUNCTIONALITY FOR NOW! Its a QOL Improvement we don't need but may come back later.
                    // .on('click', function(e, d){
                    //     if(self.pinned_cols.includes(String(new Date(d.threshold)))){
                    //         self.pinned_cols = self.pinned_cols.filter((item) => item !== d.threshold);
                    //         delete self.cached_bins[d.threshold];
                    //     }else{
                    //         self.pinned_cols.push(String(new Date(d.threshold)));
                    //         self.cached_bins[String(new Date(d.threshold))] = d.bins;
                    //     }

                    //     if (self.pinned_cols.length == 0){
                    //         self.model.update_row_counts(self.id_token, `${self.facet}_right_histogram`, self.facet, {});
                    //     } else {
                    //         self.model.update_subselected_data(self.facet, [`${self.facet}_right_histogram`, `${self.facet}_bottom_histogram`, `${self.facet}_legend`], [], "");
                    //     }

                    // })
                },
                function(update){
                    update.attr('transform', (d, i)=>{
                            if(typeof(d.threshold) === 'string'){
                                return `translate(${self.scale_x.scale(new Date(d.threshold))}, ${OVERVIEW_LAYOUT.inner_padding})`
                            }
                            return `translate(${self.scale_x.scale(d.threshold)}, ${OVERVIEW_LAYOUT.inner_padding})`
                        });

                    update.select('.col-bg')
                            .style('visibility', (d)=>{
                                return 'hidden';
                            })

                    update.select('.text-field')
                            .style('visibility', (d)=>{
                                if(self.pinned_cols.includes(String(new Date(d.threshold)))){
                                    return 'visible';
                                }
                                return 'hidden';
                            })
                            .select('text')
                            .text((d)=>{
                                return `${new Date(d.threshold).toUTCString()} (${new Date(d.threshold).toLocaleDateString()})`;
                            });

                    //calling this as a .each so that we have access to
                    // column data for each row
                    update.each(
                        function(col_data){
                            d3.select(this).selectAll('.row').each(
                                function(row_data, row_num){
                                    d3.select(this)
                                        .transition()
                                        .attr('fill', ()=>{
                                            if(col_data.bins[row_num].values.length > 0){
                                                return self.manage_highlight(col_data, row_num);
                                            }
                                            else{
                                                return 'rgba(240,240,240)';
                                            }
                                        })
                                }          
                            )
            
                            // if(!self.pinned_cols.includes(String(new Date(col_data.threshold)))){
                            //     self.unfocus_col(d3.select(this));
                            // }else{
                            //     self.focus_col(d3.select(this));
                            // }
                    })
                    
                },
                function(end){
                    end.remove();
                }

            );
        }
    }


}

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
                        .data(self.model.faceted_bins[self.facet].column, function(d){console.log("INDEX", d.index); return d.index} )
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
            let y_offset = Y_VARIABLE_OFFSET + HISTOGRAM_LAYOUT.outer_margin + OVERVIEW_LAYOUT.height ;

            let h_hist = this.parent.append('g')
                    .attr('class', 'faceted-h-hist')
                    .attr('transform', `translate(${x_offset},${y_offset})`);

            h_hist.append('g')
                    .attr('class', 'left-axis')
                    .call(d3.axisLeft().scale(this.scale_y_inverse).ticks(5))  
                    .attr('transform', `translate(${HISTOGRAM_LAYOUT.inner_padding},${0})`);

            h_hist.append('g')
                    .attr('class', 'bottom-axis')
                    .call(d3.axisBottom().scale(this.scale_x))  
                    .attr('transform', `translate(${0},${this.height-HISTOGRAM_LAYOUT.inner_padding})`);

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

            let v_hist = this.parent.append('g')
                .attr('class', 'faceted-v-hist')
                .attr('transform', `translate(${OVERVIEW_LAYOUT.width},${VERT_HISTOGRAM_LAYOUT.outer_margin})`);

            v_hist.append('g')
                .attr('class', 'bot-axis')
                .call(d3.axisBottom().scale(this.scale_x).ticks(5))  
                .attr('transform', `translate(${VERT_HISTOGRAM_LAYOUT.inner_padding*4},${VERT_HISTOGRAM_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding})`);

            // v_hist.append('g')
            //         .attr('class', 'left-axis')
            //         .call(d3.axisLeft().scale(this.scale_y_inverse))  
            //         .attr('transform', `translate(${VERT_HISTOGRAM_LAYOUT.inner_padding},${0})`);

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
        this.drawable_width = (this.width-2*CAT_HISTOGRAM_LAYOUT.inner_padding);
        this.calc_bar_width = Math.min(this.max_bar_width, this.drawable_width/this.n);

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

            //references OVERVIEW LAYOUT SIZES
            //BE CAREFUL
            this.scale_x = d3.scaleBand()
                            .domain(top_n_cats.map((obj)=>{
                                return obj.key;
                            }))
                            .range([CAT_HISTOGRAM_LAYOUT.inner_padding, this.width - CAT_HISTOGRAM_LAYOUT.inner_padding])
                            .padding(0.1);
        }
        
        else if(this.orientation == 'right'){

            this.scale_y = d3.scaleLinear()
                .domain([num_rows-2, -1])
                .range([OVERVIEW_LAYOUT.inner_padding, OVERVIEW_LAYOUT.height - OVERVIEW_LAYOUT.inner_padding]);

            this.scale_x = d3.scaleLinear() 
                .domain([0, Math.max(...this.model.row_major_counts[this.facet])])
                .range([0, VERT_HISTOGRAM_LAYOUT.width - VERT_HISTOGRAM_LAYOUT.inner_padding]);
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
                                    .attr('fill', TAN)
                                    .attr(`transform`, (d)=>{return `translate(${0}, ${(CAT_HISTOGRAM_LAYOUT.height- self.scale_y(d.val))-2*CAT_HISTOGRAM_LAYOUT.inner_padding})`})
                                    .on('mouseover', function (e,d){
                                        d3.select(this).attr('fill', RICH_TAN);
                                        self.model.filter_data_by_category([d.key], self.facet, self.id_token, update_targets);
                                        // self.model.update_row_counts(self.token, `${self.facet}_right_histogram`, self.facet, []);
                                    })
                                    .on('mouseout', function (e,d){
                                        if(!self.model.is_category_pinned(self.facet, d.key)){
                                            d3.select(this).attr('fill', TAN);
                                        }

                                    })
                                    .on('click', function(e,d){
                                        self.model.pin_unpin_clicked_category(self.id_token, self.facet, d.key);
                                    });
                            }
                        );
            }


            if(this.orientation == "right"){
                this.view
                    .selectAll('.row')
                    .data(self.model.row_major_counts[self.facet])
                    .join(
                        function(enter){
                            let row = enter.append('g')
                                            .attr('class', 'row')
                                            .attr('transform', (d, i)=>{return `translate(${VERT_HISTOGRAM_LAYOUT.inner_padding},${self.scale_y(i)})`});

                            row.append('rect')
                                .attr('class', 'bar')
                                .attr('width', (d)=>{return self.scale_x(d)})
                                .attr('height', (d)=>{return draw_height / self.model.faceted_bins[self.facet].column[0].bins.length})
                                .attr('fill', '#aabbdd');
                            
                            return enter;
                        },
                        function(update){
                            update.select('.bar')
                                .transition()
                                .attr('width', (d)=>{return self.scale_x(d)});
                        },
                        function(exit){
                            exit.remove();
                        }
                    )
            }
        }
    }
}

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
        } else{
            console.log("DOMAIN at LEGEND CREATE", color_scale.domain());
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
            .attr('class', 'num_records')
            .text(`No. of Records Selected for Export: ${this.model.brushed_data[this.facet].length}`)
            .attr('transform', `translate(${0}, ${-10})`);;

        this.legend_grp = legend_grp;

    }

    /**
     * Renders the legend by updating the DOM elements based on the current data.
     */
    render(){
        this.legend_grp.selectAll('.num_records')
            .text(`No. of Records Selected for Export: ${this.model.brushed_data[this.facet].length}`);
    }

}

class Validator{

    constructor(svg, data, var_specs){
        this.svg = svg;
        this.data = data;
        this.var_specs = var_specs;
    
    }

    /**
     * Ensures that all values in var_specs are in the keys of data.
     * @param {Object} var_specs - The variable specifications.
     * @param {Object} data - The data object.
     * @returns {Array} - An array of missing keys and their associated values.
     */
    validate_var_specs() {
        let missing = [];
        for (let key in this.var_specs) {
            if (key !== 'color_agg' && !this.data.hasOwnProperty(this.var_specs[key])) {
                missing.push({ key: key, value: this.var_specs[key], message: `Configuration Error: "${key}": The variable "${this.var_specs[key]}" is missing from the data. Please verify that the variable name exists in the dataset columns or is spelled correctly.` });
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
            return [{key:'data', value:'data', message:"No data detected. Please load data into <objectname>.vis_data"}];
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
        errors = errors.concat(this.validate_var_specs());

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
        //ensure that all keys in var_specs are in the set of required keys x, y, color, categorical, facet_by, and color_agg
        let required_keys = ['x', 'y', 'color', 'categorical'];
        let missing = [];
        for (let key of required_keys) {
            if (!this.var_specs.hasOwnProperty(key)) {
                missing.push({ key: key, value: '', message: `Configuration Error: "${key}": This key is required for the visualization configuration. Please specify this key and a column name as the value for this configuration.` });
            }
        }


        //attempt to resolve a missing facet_by
        if(!this.var_specs.hasOwnProperty('facet_by')){
            if (this.data.hasOwnProperty('partition')) {
                this.var_specs['facet_by'] = 'partition';
            } else if (this.data.hasOwnProperty('queue')) {
                this.var_specs['facet_by'] = 'queue';
            } else {
                missing.push({ key: 'facet_by', value: '', message: `Configuration Error: No column was selected to partition the data into and no "queue" or "partition" column was found in the dataset. 
                    Please specify the "facet_by" configuration and a categorical column on your data.` });
            }
        }

        //set color_agg to average by default
        if(!this.var_specs.hasOwnProperty('color_agg')){
            this.var_specs.color_agg = 'avg';
        }


        return missing;
    }


    // Function to coerce an entire column’s values to strings
    coerceColumnToString(columnData) {
        return Object.keys(columnData).reduce((result, key) => {
            result[key] = String(columnData[key]);
            return result;
        }, {});
    }

    /**
     * Ensures that all values in this.var_specs are logically appropriate
     * @param {Object} this.var_specs - The variable specifications.
     * @param {Object} this.data - The data object.
     * @returns {Array} - An array of missing keys and their associated values.
     */
    validate_variable_semantics() {
        let incorrect = [];
        let valid_aggs = ['avg', 'variance', 'std', 'median', 'sum']

        for (let key in this.var_specs) {
            if(key === 'color_agg'){
                if(!valid_aggs.includes(this.var_specs['color_agg'])){
                    incorrect.push({key:key, value: this.var_specs[key], message: 'Invalid aggregation specified. Acceptable aggregations are: "avg", "variance", "std", "median", "sum"'});
                }
            }
            else if (key === 'x') {
                let test_val = this.data[this.var_specs[key]][Object.keys(this.data[this.var_specs[key]])[0]];
                if (typeof test_val !== 'number'){
                    if(typeof test_val == 'string'){
                        if(!this.isValidDate(test_val)){
                            incorrect.push({ key: key, value: this.var_specs[key], message: 'The x-axis only supports floats, integers and dates. Please specify a different variable or verify that the datetime is properly formatted.' });
                        }
                    }
                    else {
                        incorrect.push({ key: key, value: this.var_specs[key], message: 'The x-axis only supports floats, integers and dates. Please specify a different variable or verify that the datetime is properly formatted.' });
                    }
                }
            }
            else if (key === 'y') {
                let test_val = this.data[this.var_specs[key]][Object.keys(this.data[this.var_specs[key]])[0]];
                if (typeof test_val !== 'number'){
                        incorrect.push({ key: key, value: this.var_specs[key], message: 'The y-axis only supports floats and integers. Please specify a different variable.' });
                }
            }
            else if (key === 'color') {
                let test_val = this.data[this.var_specs[key]][Object.keys(this.data[this.var_specs[key]])[0]];
                if (typeof test_val !== 'number'){
                    incorrect.push({ key: key, value: this.var_specs[key], message: 'The color variable only supports floats and integers. Please specify a different column on your dataset or verify the datatype of this column.' });
                }
            }
            else if (key === 'categorical'){
                let test_val = this.data[this.var_specs[key]][Object.keys(this.data[this.var_specs[key]])[0]];
                // For categorical variables, coerce data to strings if necessary.
                if(typeof test_val !== 'string'){
                    // Coerce the column data at this.data[this.var_specs[key]]
                    this.data[this.var_specs[key]] = coerceColumnToString(this.data[this.var_specs[key]]);
                    // Re-check the data type after coercion
                    test_val = this.data[this.var_specs[key]][Object.keys(this.data[this.var_specs[key]])[0]];
                    if(typeof test_val !== 'string'){
                        incorrect.push({ key: key, value: this.var_specs[key], message: 'The categorical view only supports categorical variables formatted as strings. Please specify a different column on your dataset or reformat an existing column.' });
                    }
                }
            }
        }
        return incorrect;
    }


}

function create_views(model, svg){
    svg.selectAll("*").remove();

    for(let i in model.facets){
        let parent = svg.append('g')
                        .attr('class', 'faceted_view')
                        .attr('transform', `translate(${OVERVIEW_LAYOUT.outer_margin},${(OVERVIEW_LAYOUT.height * i) + ((FACET_LAYOUT.outer_margin * i) + (total_hist_height*i))})`)
                        .attr('width', OVERVIEW_LAYOUT.width)
                        .attr('height', FACET_LAYOUT.height + HISTOGRAM_LAYOUT.height);

        
                        
        let h_histogram = new Histogram(model, parent, model.facets[i], HISTOGRAM_LAYOUT.height, HISTOGRAM_LAYOUT.width, "bottom");
        let v_histogram = new Histogram(model, parent, model.facets[i], VERT_HISTOGRAM_LAYOUT.height, VERT_HISTOGRAM_LAYOUT.width, "right");
        let cat_histogram = new CategoricalBarChart(model, parent, model.facets[i], CAT_HISTOGRAM_LAYOUT.height, CAT_HISTOGRAM_LAYOUT.width, "bottom");
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

    }


    svg.attr('height', (OVERVIEW_LAYOUT.height * model.facets.length) + (FACET_LAYOUT.outer_margin*(model.facets.length+1) + total_hist_height*model.facets.length))
        .attr('width', OVERVIEW_LAYOUT.width + (2 * OVERVIEW_LAYOUT.outer_margin) + (VERT_HISTOGRAM_LAYOUT.width+(2*VERT_HISTOGRAM_LAYOUT.outer_margin)) + LEGEND_LAYOUT.width)

}



function render({model, el}){
    let data = model.get("vis_data");
    let var_specs = model.get("vis_configs");

    model.set("selected_records", "");
    model.save_changes();

    let svg = d3.select(el).append('svg').attr('width', 500).attr('height', 50);
    let first_text = null;

    let validator = new Validator(svg, data, var_specs);
    let is_valid = validator.validate();

    if(is_valid){
        let jsmodel = new JSModel(data, var_specs, model);
        create_views(jsmodel, svg);
    }

    model.on("change:vis_configs", ()=>{

        if(first_text){
            first_text.remove();
            first_text=null;
        }

        var_specs = model.get("vis_configs");
        data = model.get("vis_data");

        validator.var_specs = var_specs;
        validator.data = data;
        is_valid = validator.validate();

        if(is_valid){
            let jsmodel = new JSModel(data, var_specs, model);
            create_views(jsmodel, svg);
        }
    })

    model.on("change:vis_data", ()=>{

        if(first_text){
            first_text.remove();
            first_text=null;
        }

        data = model.get("vis_data");

        validator.data = data;
        is_valid = validator.validate();
        
        if(is_valid){
            let jsmodel = new JSModel(data, var_specs, model);
            create_views(jsmodel, svg);
        }
    })

}




export default{ render };