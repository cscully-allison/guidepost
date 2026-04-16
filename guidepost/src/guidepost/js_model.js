import * as d3 from "d3";
import { num_rows, num_cols, VALID_CONFIG_FIELDS } from "./consts.js";

const MISSING_LABEL = "(missing)";

class JSModel{
    constructor(data, vars, feature_summary_stats, anywidget_model){
        this.list_major_data = this.list_major(data);
        this.data = this.facet(this.list_major_data, vars['facet_by']);
        this.facets = Object.keys(this.data);
        this.vars = vars;
        this.anywidget_model = anywidget_model;
        // sort feature_summary_stats by key (alphabetical) so insertion order is predictable
        feature_summary_stats = Object.fromEntries(
            Object.entries(feature_summary_stats).sort((a, b) => a[0].localeCompare(b[0]))
        );
        this.feature_summary_stats = feature_summary_stats;
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

        this.valid_config_fields = VALID_CONFIG_FIELDS;

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

    set_config_options(config_name, options){
        for(let config in this.valid_config_fields){
            if(config_name == this.valid_config_fields[config]['name']){
                this.valid_config_fields[config]['options'] = options;
                break;
            }
        }

        // this.render_all();
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
            if(data[r][col] == null) continue;
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
        let sum_stats;
        if(data.length === 0){
            sum_stats = this._empty_summary_stats();
        } else {
            // Find first non-null sample to detect type; nulls are skipped per-axis downstream.
            let sample;
            for(const row of data){
                if(row[col] != null){ sample = row[col]; break; }
            }
            if(sample === undefined){
                sum_stats = this._empty_summary_stats();
            } else if(typeof sample === 'string'){
                sum_stats = this._categorical_summary_stats(data, col);
            } else {
                sum_stats = this._numeric_summary_stats(data, col);
            }
        }
        sum_stats.index = index;
        return sum_stats;
    }

    /**
     * Returns a summary-stats object with every numeric field zeroed. Used for
     * empty input so downstream code never sees `undefined` from min/max/etc.
     */
    _empty_summary_stats(){
        const stats = {
            min: 0, max: 0,
            sum: 0,
            avg: 0, average: 0, mean: 0,
            variance: 0, var: 0, std: 0,
            q1: 0, q2: 0, q3: 0,
            median: 0, med: 0,
            count: 0
        };
        return stats;
    }

    /**
     * Stats for categorical (string) columns: min/max are the lexicographic
     * extremes; numeric aggregates are zeroed (kept on the object so the shape
     * matches the numeric branch).
     */
    _categorical_summary_stats(data, col){
        const stats = this._empty_summary_stats();
        const filtered = data.filter(d => d[col] != null);
        if(filtered.length === 0){
            return stats;
        }
        stats.min = filtered.reduce((prev, curr) => prev[col] < curr[col] ? prev : curr)[col];
        stats.max = filtered.reduce((prev, curr) => prev[col] > curr[col] ? prev : curr)[col];
        stats.count = filtered.length;
        return stats;
    }

    /**
     * Stats for numeric columns: min, max, sum, mean, variance, std, quartiles.
     * Aliases (avg/average/mean, var/variance, med/median) are kept for
     * backwards-compatible callers.
     */
    _numeric_summary_stats(data, col){
        const filtered = data.filter(d => d[col] != null && !(typeof d[col] === 'number' && isNaN(d[col])));
        if(filtered.length === 0){
            const empty = this._empty_summary_stats();
            empty.count_total = data.length;
            return empty;
        }
        const stats = {};
        stats.min = filtered.reduce((prev, curr) => prev[col] < curr[col] ? prev : curr)[col];
        stats.max = filtered.reduce((prev, curr) => prev[col] > curr[col] ? prev : curr)[col];

        stats.sum = filtered.reduce((acc, current) => acc + current[col], 0);
        stats.avg = stats.sum / filtered.length;

        const [variance, std] = this.calculateStandardDeviation(filtered, stats.avg, col);
        stats.variance = variance;
        stats.std = std;

        const sorted = filtered.map(item => item[col]).sort(d3.ascending);
        stats.q1 = d3.quantile(sorted, 0.25);
        stats.q2 = d3.quantile(sorted, 0.50);
        stats.q3 = d3.quantile(sorted, 0.75);

        // aliases
        stats.median = stats.q2;
        stats.med = stats.median;
        stats.var = stats.variance;
        stats.average = stats.avg;
        stats.mean = stats.avg;
        stats.count = filtered.length;
        stats.count_total = data.length;
        return stats;
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
        if (numValues < 1) {
            throw new Error("The number of intervals must be at least 1");
        }
        if (numValues === 1) {
            return [min];
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
        if (n === 0) return [0, 0]; // Avoid division by zero
    
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
        // Place each value in the appropriate bin (skip null/NaN)
        values.forEach(d => {
            const val = accessor(d);
            if(val == null || (typeof val === 'number' && isNaN(val))) return;
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
                const agg_val = stats[this.vars.color_agg];
                if (agg_val != null) {
                    this.color_scale_range[0] = Math.min(this.color_scale_range[0], agg_val);
                    this.color_scale_range[1] = Math.max(this.color_scale_range[1], agg_val);
                }
                return stats;
            });


            temp_box_stats.column_values = filtered_bin;
            this.faceted_bins[fac].column[bin] = temp_box_stats;
            col_indx += 1;
        }

    }

    /**
     * Sanitizes and initializes the data for the model. Acts as an orchestrator
     * over a small pipeline of per-facet helpers; each helper owns one concern
     * (type coercion, summary stats, scale/threshold detection, binning,
     * categorical counts) so that the heatmap-layout shape this function
     * produces is built up in clearly named steps.
     * @param {Object} data - Faceted data, keyed by facet name.
     * @returns {Object} - The sanitized and initialized data.
     */
    sanitize_and_intialize_data(data){
        this.global_sum_stats = this._init_global_stats_accumulator();

        for(let fac of this.facets){
            this.scale_types[fac] = this._empty_scale_types();
            this.faceted_bins[fac] = {};

            this._coerce_facet_types(data, fac);
            this._compute_facet_summary_stats(data, fac);
            this._accumulate_global_stats(fac);

            // Build the x axis (thresholds + d3 bins) and the y axis (thresholds only).
            // _build_axis is allowed to mutate data[fac] when it needs to sanitize zeros
            // for a log scale.
            this._build_axis(data, fac, 'x');
            this._build_axis(data, fac, 'y');

            this._compute_column_count_stats(fac);
            this.global_sum_stats.num_cols = Math.max(
                this.faceted_bins[fac].column.length,
                this.global_sum_stats.num_cols
            );

            this.calculate_box_metrics(fac, this.x_axis_thresholds[fac], this.y_axis_thresholds[fac]);
            this.calc_row_major_counts(fac);
            this._build_categorical_bins(data, fac);
        }

        return data;
    }

    /**
     * Builds the {x, y, color, num_cols} skeleton used to track stats across all facets.
     */
    _init_global_stats_accumulator(){
        const empty = () => ({ max: Number.MIN_SAFE_INTEGER, min: Number.MAX_SAFE_INTEGER });
        return { x: empty(), y: empty(), color: empty(), num_cols: 0 };
    }

    /**
     * Returns a fresh per-facet scale_types object with all flags off.
     */
    _empty_scale_types(){
        return {
            x: { log: false, linear: false, datetime: false },
            y: { log: false, linear: false, datetime: false }
        };
    }

    /**
     * Coerces string x values into Date objects. Log-scale zero sanitization is
     * intentionally deferred to _build_axis so it only runs for axes that
     * actually use a log scale.
     */
    _coerce_facet_types(data, fac){
        let sample;
        for(const row of data[fac]){
            if(row[this.vars.x] != null){ sample = row[this.vars.x]; break; }
        }
        if(typeof sample === 'string'){
            data[fac] = this.convert_to_date(data[fac], this.vars.x);
        }
    }

    /**
     * Populates faceted_sum_stats[fac] with summary stats for x, y, and color.
     */
    _compute_facet_summary_stats(data, fac){
        this.faceted_sum_stats[fac] = {
            x: this.get_summary_stats(data[fac], this.vars.x),
            y: this.get_summary_stats(data[fac], this.vars.y),
            color: this.get_summary_stats(data[fac], this.vars.color)
        };
    }

    /**
     * Folds this facet's summary stats into the running global_sum_stats accumulator.
     */
    _accumulate_global_stats(fac){
        const facet_stats = this.faceted_sum_stats[fac];
        for(const axis of ['x', 'y', 'color']){
            this.global_sum_stats[axis].max = Math.max(facet_stats[axis].max, this.global_sum_stats[axis].max);
            this.global_sum_stats[axis].min = Math.min(facet_stats[axis].min, this.global_sum_stats[axis].min);
        }
    }

    /**
     * Detects the scale type for a single axis on a single facet, computes its
     * thresholds, and (for the x axis) runs the d3.bin pass that produces the
     * column structure consumed by the heatmap. May mutate data[fac] when log
     * scaling requires zero values to be promoted to one.
     * @param {Object} data - Faceted data.
     * @param {string} fac - Facet name.
     * @param {'x'|'y'} axis - Which axis to build.
     */
    _build_axis(data, fac, axis){
        const stats = this.faceted_sum_stats[fac][axis];
        const var_name = this.vars[axis];
        const is_x = axis === 'x';
        const num_thresholds = is_x ? num_cols - 1 : num_rows;

        if(is_x && stats.min instanceof Date){
            this.scale_types[fac].x.datetime = true;
            const ticks = d3.scaleUtc()
                .domain([new Date(stats.min), this.addDays(new Date(stats.max), 1)])
                .ticks(this.x_axis_time_window);
            // Ensure the first threshold is the true data min so column[0].threshold
            // maps to scale(min) == left edge of the chart.
            if(ticks.length === 0 || +ticks[0] !== +stats.min){
                ticks.unshift(new Date(stats.min));
            }
            this.x_axis_thresholds[fac] = ticks;
            this.faceted_bins[fac].column = this._bin_column(data[fac], var_name,
                [new Date(stats.min), new Date(stats.max)], this.x_axis_thresholds[fac]);
            return;
        }

        if(typeof stats.max !== 'number'){
            return;
        }

        // Numeric axis: pick log vs linear based on spread
        const use_log = this.is_more_than_n_orders_of_magnitude(stats.min, stats.max, 3);
        const thresholds_target = is_x ? this.x_axis_thresholds : this.y_axis_thresholds;

        if(use_log){
            this.scale_types[fac][axis].log = true;
            data[fac] = this.sanitize_data_for_log(data[fac], var_name);
            // logScale's max is bumped by 1 on x to mirror prior behavior
            thresholds_target[fac] = this.logScale(
                this.log_values_floor,
                is_x ? stats.max + 1 : stats.max,
                num_thresholds
            );
            if(is_x){
                this.faceted_bins[fac].column = this._bin_column(data[fac], var_name,
                    [this.log_values_floor, stats.max], thresholds_target[fac]);
            }
        } else {
            this.scale_types[fac][axis].linear = true;
            thresholds_target[fac] = this.linearScale(
                stats.min,
                is_x ? stats.max + 1 : stats.max,
                num_thresholds
            );
            if(is_x){
                this.faceted_bins[fac].column = this._bin_column(data[fac], var_name,
                    [stats.min, stats.max], thresholds_target[fac]);
            }
        }
    }

    /**
     * Thin wrapper around d3.bin so the three call sites in _build_axis read uniformly.
     */
    _bin_column(records, var_name, domain, thresholds){
        // Records with null/NaN x are excluded from x-binning only; they remain
        // in the dataset and still contribute to non-x views.
        const filtered = records.filter(d => {
            const v = d[var_name];
            return v != null && !(typeof v === 'number' && isNaN(v));
        });
        return d3.bin()
            .value(d => d[var_name])
            .domain(domain)
            .thresholds(thresholds)(filtered);
    }

    /**
     * Records the min/max number of records per column on the facet's summary stats.
     */
    _compute_column_count_stats(fac){
        const sum_stats = this.faceted_sum_stats[fac];
        sum_stats.col_counts = { min: Number.MAX_SAFE_INTEGER, max: Number.MIN_SAFE_INTEGER };
        for(const bin of this.faceted_bins[fac].column){
            sum_stats.col_counts.max = Math.max(sum_stats.col_counts.max, bin.length);
            sum_stats.col_counts.min = Math.min(sum_stats.col_counts.min, bin.length);
        }
    }

    /**
     * Builds the {key, val}[] categorical-count list used by the bar chart, sorted descending.
     */
    _build_categorical_bins(data, fac){
        const cat_counts = {};
        for(const record of data[fac]){
            let key = record[this.vars.categorical];
            if(key == null) key = MISSING_LABEL;
            cat_counts[key] = (cat_counts[key] || 0) + 1;
        }
        this.categorical_bins[fac] = Object.keys(cat_counts)
            .map(key => ({ key, val: cat_counts[key] }))
            .sort((a, b) => b.val - a.val);
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
                    filter.indexOf(cat) === -1 ? filter.push(cat) : null
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
        // NOTE: y_range is stored in DESCENDING order ([upper, lower]) because the y axis
        // is screen-inverted. Row comparisons below read as `row >= y_range[1] && row < y_range[0]`
        // for that reason — do not "fix" the comparison without also normalizing the range.
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
        this.list_major_data = this.list_major(data);
        this.data = this.facet(this.list_major_data, this.vars['facet_by']);
        this.facets = Object.keys(this.data);
        this.sanitize_and_intialize_data(this.data);
        for(let facet of this.facets){
            this.faceted_states[facet].original_bins = JSON.stringify(this.faceted_bins[facet]);
        }
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

    render_all(){
        for(let view in this.views){
            this.views[view].render();
        }
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

export {JSModel, MISSING_LABEL}