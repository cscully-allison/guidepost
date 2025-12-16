import * as d3 from "https://esm.sh/d3@7";


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

export {SmartScale};