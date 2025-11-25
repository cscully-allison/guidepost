import * as d3 from "https://esm.sh/d3@7";

function render({model, el}){
    let data = model.get("vis_data");

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