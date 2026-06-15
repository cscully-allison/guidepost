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
        if (this.domain.every(d => d instanceof Date)) {
            // Target a tick COUNT that fits the available pixel width rather than
            // a fixed per-span interval. The old span buckets returned weekly
            // ticks for any 30–365 day facet — which overlapped badly on
            // multi-month spans and differed facet-to-facet (since each facet
            // scales to its own date range). A fixed target count gives a
            // consistent label density across facets, while d3's time scale
            // still snaps to human-friendly intervals (day / week / month /
            // year) appropriate to each facet's span.
            const px = Math.abs(this.range[1] - this.range[0]);
            const LABEL_PX = 90;   // comfortable spacing for a formatted date label
            return Math.max(2, Math.floor(px / LABEL_PX));
        } else if (this.domain.every(d => typeof d === 'number')) {
            return 20;
        } else {
            throw new Error("Unsupported domain type");
        }
    }

}

export {SmartScale};