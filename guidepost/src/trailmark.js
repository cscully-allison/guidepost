import * as d3 from "https://esm.sh/d3@7";

const padding = 10;
const margin = 10;

class TMModel{
    constructor(data){
        this.data = data;
    }
}

class SummaryViews{
    constructor(model, svg){
        this.model = model;
        this.svg = svg;
    }   
}

function render({model, el}){
    let data = model.get("_vis_data");
    console.log("Trailmark render called with data:", model.get("_vis_data"));
    model.save_changes();
    
    console.log(el.parentNode);

    let svg = d3.select(el).append('svg').attr('width', window.innerWidth-50).attr('height', 300).attr('transform', `translate(${margin}, ${margin})`) ;
    svg.style("border", "1px solid black");

    svg.append("text").text("Initial render!").attr("x", 10).attr("y", 25);

    // model.on("change:vis_configs", ()=>{

    //     if(first_text){
    //         first_text.remove();
    //         first_text=null;
    //     }

    //     var_specs = model.get("vis_configs");
    //     data = model.get("vis_data");

    //     validator.var_specs = var_specs;
    //     validator.data = data;
    //     is_valid = validator.validate();

    //     if(is_valid){
    //         let jsmodel = new JSModel(data, var_specs, model);
    //         create_views(jsmodel, svg);
    //     }
    // })

    model.on("change:_vis_data", ()=>{
        data = model.get("_vis_data");

        console.log("RE RENDER:", data);
    })

}




export default{ render };