import * as d3 from "https://esm.sh/d3@7";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { hypothesis_agent_system_prompt, code_agent_system_prompt, analysis_agent_system_prompt } from "./prompt_engineering"; 
import {GPTConfig} from "./local_configs";
import anime from "https://esm.sh/animejs@3.2.1";


const padding = 10;


class CSModel{
    constructor(data){
        this.data = data;
        this.response = null;

        this.views = [];
    }

    update_response(resp){
        this.response =  resp;
        this.update();
    }

    add_view(view){
        this.views.push(view);
    }

    update(){
        for(let view of this.views){
            view.render();
        }
    }

}

class LLMInterface{
    constructor(model, prompt_text){
        this.model = model;
        this.llm_model = new ChatOpenAI(GPTConfig);

        this.prompt = ChatPromptTemplate.fromMessages([
            ["system", prompt_text],
            ["human", "{input}"]
        ]);

        this.chain = this.prompt.pipe(this.llm_model);
    }   
    
    async queryLLM(question){
        
        const reply = await this.chain.invoke({
            data_summary: JSON.stringify(this.model.data),
            input: question
        });

        return reply;
    }
}


class ChatInterface{
    constructor(model, svg, agents){
        this.model = model;
        this.svg = svg;
        this.createChatInterface();
        this.hyp_agent = agents.hyp_agent;
        this.code_agent = agents.code_agent;
        this.analysis_agent = agents.analysis_agent;

        console.log("SUMMARIES", model.data);        
    }   
    

    createChatInterface() {
        const self = this;

        const buttonHeight = 30;
        const width = +this.svg.attr("width")/2;
        const height = +this.svg.attr("height") - buttonHeight;

        const chatStyles = {
            fontFamily: "Arial, sans-serif",
            fontSize: "12px",
            color: "#333",
            border: "1px solid #ccc",
            padding: "2px",
        };

        const dimensions = {
            chatWidth: width - 2 * padding,
            chatHeight: height - 2 * padding,
            messagesHeight: height - 6 * padding,
            textAreaWidth: width - 4 * padding,
            inputHeight: padding * 2,
            buttonHeight: buttonHeight,
        };


        // Create a group for the chat interface
        const chatGroup = this.svg.append("g").attr("class", "chat-interface");

        // Create a rectangle for the chat background
        chatGroup.append("rect")
            .attr("x", padding)
            .attr("y", padding)
            .attr("width", dimensions.chatWidth)
            .attr("height", dimensions.chatHeight)
            .attr("fill", "#f9f9f9")
            .attr("stroke", "#ccc");

        // Create a text area for chat messages
        chatGroup.append("foreignObject")
            .attr("x", padding * 2)
            .attr("y", padding * 2)
            .attr("width", dimensions.textAreaWidth-padding)
            .attr("height", dimensions.messagesHeight)
            .append("xhtml:div")
            .style("overflow-y", "auto")
            .style("height", `${dimensions.messagesHeight}px`)
            .style("width", `${dimensions.textAreaWidth-padding}px`)
            .style("font-family", "Arial, sans-serif")
            .style("font-size", "12px")
            .style("color", "#333")
            .attr("class", "chat-messages");

        // Create an input box for user messages
        chatGroup.append("foreignObject")
            .attr("x", padding * 2)
            .attr("y", height - padding * 4)
            .attr("width", width - 4 * padding)
            .attr("height", padding * 2)
            .append("xhtml:input")
            .attr("type", "text")
            .style("width", `${width - 4 * padding}px`)
            .style("height", `${padding * 2}px`)
            .style("font-family", "Arial, sans-serif")
            .style("font-size", "12px")
            .style("border", "1px solid #ccc")
            .style("padding", "2px")
            .attr("class", "chat-input")
            .attr("placeholder", "ex. What can you tell me about my data?");

        chatGroup.append("foreignObject")
            .attr("x",padding * 2)
            .attr("y", height - padding)
            .attr("width", width - 4 * padding)
            .attr("height", buttonHeight)
            .append("xhtml:button")
            .style("width", `${width - 4 * padding}px`)
            .style("height", `${buttonHeight}px`)
            .text("Send")
            .on("click", async function(){
                const inputBox = document.querySelector(".chat-input");
                const messagesDiv = document.querySelector(".chat-messages");
                const userMessage = inputBox.value;
                if (userMessage.trim() === "") return;

                // Display user message
                const userMsgElem = document.createElement("div");
                userMsgElem.style.textAlign = "right";
                userMsgElem.style.marginBottom = "5px";
                userMsgElem.textContent = `You: ${userMessage}`;
                messagesDiv.appendChild(userMsgElem);

                // Clear input box
                inputBox.value = "";
                const placeholder = document.createElement("div");
                placeholder.style.textAlign = "left";
                placeholder.style.marginBottom = "5px";
                placeholder.style.height = "40px";
                messagesDiv.appendChild(placeholder);

    
                // makes room for a loading animation
                loading.attr('visibility', 'visible');
                loading.attr('transform-origin', 'center');  
                loading.attr('transform',`translate(${(dimensions.textAreaWidth-padding)/2}, ${dimensions.messagesHeight-padding})`);
                console.log("SCROLL HEIGHT:", messagesDiv.scrollHeight);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;

                d3.select(this).attr('disabled', true);

                // Query LLM and display response
                let assistantResponse = await self.analysis_agent.queryLLM(userMessage);
                console.log("Analysis Agent Resp:", assistantResponse);

                const llmMsgElem = document.createElement("div");
                llmMsgElem.style.textAlign = "left";
                llmMsgElem.style.marginBottom = "5px";
                llmMsgElem.textContent = `LLM: ${JSON.parse(assistantResponse.content)['response']}`;
                messagesDiv.appendChild(llmMsgElem);


                let hypResponse = await self.hyp_agent.queryLLM(JSON.parse(assistantResponse.content)['discussion_context']);
                console.log("Hyp Agent Resp:", hypResponse);

                
                let codeResponse = await self.code_agent.queryLLM(JSON.parse(hypResponse.content));
                console.log("Hyp Agent Resp:", codeResponse);
                let resp_content = JSON.parse(codeResponse.content)



                // let resp_content = `{\n  "response": "Your hypotheses have been generated. I’ve provided Python code snippets that evaluate each hypothesis using a pandas DataFrame named 'df'. If you have questions or need adjustments, feel free to ask.",\n  "hypotheses": [\n    {\n      "natural_language": "There is a negative correlation between memory efficiency and average power consumption across all jobs.",\n      "code_snippet": "import pandas as pd\\n\\ndef evaluate(df):\\n    # Compute Pearson correlation between avg_mem_eff and avg_power across all jobs\\n    corr = df['avg_mem_eff'].corr(df['avg_power'])\\n    # Return True if correlation is less than -0.3\\n    return corr < -0.3\\n",\n      "explanation": "The snippet computes the Pearson correlation between the two per-job metrics avg_mem_eff and avg_power across all rows in df and checks if it is below -0.3.",\n      "assumptions": "avg_mem_eff and avg_power are per-job metrics present as columns in df. There are no (or properly handled) missing values in these columns."\n    },\n    {\n      "natural_language": "Quantum Espresso jobs have higher average memory efficiency than all other job types.",\n      "code_snippet": "import pandas as pd\\n\\ndef evaluate(df):\\n    # Average memory efficiency for Quantum Espresso jobs\\n    avg_qe = df[df['job_type'] == 'quantum-espresso']['avg_mem_eff'].mean()\\n    # Average memory efficiency for all other jobs\\n    avg_other = df[df['job_type'] != 'quantum-espresso']['avg_mem_eff'].mean()\\n    # Return True if QE average is greater than others\\n    return avg_qe > avg_other\\n",\n      "explanation": "The snippet filters the DataFrame by job_type to compute the mean of avg_mem_eff for Quantum Espresso and for all other jobs, then compares the two means.",\n      "assumptions": "avg_mem_eff is a valid measure of memory efficiency and present for all job types. The predicate correctly partitions data by job_type."\n    },\n    {\n      "natural_language": "Among Quantum Espresso jobs, memory efficiency and power usage are strongly negatively correlated.",\n      "code_snippet": "import pandas as pd\\n\\ndef evaluate(df):\\n    # Subset to Quantum Espresso jobs\\n    sub = df[df['job_type'] == 'quantum-espresso']\\n    # Correlation between avg_mem_eff and avg_power within this subset\\n    corr = sub['avg_mem_eff'].corr(sub['avg_power'])\\n    # Return True if correlation is less than -0.5\\n    return corr < -0.5\\n",\n      "explanation": "The snippet filters to Quantum Espresso jobs, computes the correlation between avg_mem_eff and avg_power within that subset, and checks if it is below -0.5.",\n      "assumptions": "Predicates correctly filter to Quantum Espresso jobs. There are enough samples to estimate correlation reliably."\n    }\n  ]\n}`
                // resp_content = JSON.parse(resp_content)

                // const llmResponse = "[\n  {\n    \"natural_language\": \"Is the average wallclock time of jobs submitted by user 'kwangrae' greater than 1 hour?\",\n    \"code_snippet\": \"import pandas as pd\\n\\n# Filter for the specific user\\nfiltered_df = df[df['user'] == 'kwangrae']\\n\\n# Compute the average wallclock duration\\naverage_wallclock = filtered_df['wallclock_req_seconds'].mean()\\n\\n# Compare against 1 hour (3600 seconds)\\nresult = average_wallclock > 3600\",\n    \"explanation\": \"The snippet filters the data to only include jobs submitted by user 'kwangrae', computes the mean of the wallclock_req_seconds column, and checks if that mean exceeds 3600 seconds (1 hour).\"\n  },\n  {\n    \"natural_language\": \"Is there a positive correlation between power usage (avg_power) and wallclock duration (wallclock_req_seconds) across jobs?\",\n    \"code_snippet\": \"import pandas as pd\\n\\n# Use only rows with non-missing values in both columns\\nvalid = df[['avg_power', 'wallclock_req_seconds']].dropna()\\n\\n# Compute the Pearson correlation between avg_power and wallclock_req_seconds\\ncorrelation = valid['avg_power'].corr(valid['wallclock_req_seconds'])\\nresult = correlation > 0\",\n    \"explanation\": \"The snippet removes rows with missing data for the two variables, computes the Pearson correlation between avg_power and wallclock_req_seconds, and checks if the correlation is positive.\"\n  }\n]";
                
                self.model.update_response(resp_content['hypotheses']);
                // self.model.update_response(resp_content);

                d3.select(this).attr('disabled', null);

                messagesDiv.removeChild(placeholder);
                loading.attr('visibility', 'hidden');
            


                // Scroll to bottom
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            });

        const loading = chatGroup.append("g")
            .attr('id', 'loading')
            .attr('transform',`translate(${0}, ${0})`);
        
        let dots = [];
        for(let x=0; x<3; x++){
            let dot = loading.append("circle")
                    .attr("class", "loading-dot")
                    .attr("cx", 0 + x * 30)
                    .attr("cy", 0)
                    .attr("r", 8)
                    .attr("fill", "grey");
            dots.push(dot.node())
        }

        anime({
            targets: dots,
            translateY: [
                { value: -10, duration: 500 },
                { value: 0, duration: 500 }
            ],
            easing: 'easeInOutSine',
            delay: anime.stagger(200), // Delay each dot animation
            loop: true
        });
        
        loading.attr('visibility', 'hidden');
        
    }

    render(){

    }
}


class CodeDisplayInterface{
    constructor(model, svg){
        this.model = model;
        this.svg = svg;
        this.createDisplay();   
    }

    toHash(string) {
        return string.split('').reduce((hash, char) => {
            return char.charCodeAt(0) + (hash << 6) + (hash << 16) - hash;
        }, 0);
    }


    createDisplay(){
        const self = this;
        const width = +this.svg.attr("width")/2 - padding;
        const height = +this.svg.attr("height");

        
        const dimensions = {
            codeWindowWidth: width - 2 * padding,
            codeWindowHeight: height - 2 * padding,
            textAreaWidth: width - 4 * padding,
            textAreaHeight: height - 4 * padding
        };

        this.dimensions = dimensions;

        this.disp_grp = this.svg.append('g')
                                .attr('class', 'display-grp')
                                .attr('transform', `translate(${width+2*padding},${0})`);

    
        
        this.disp_grp.append("rect")
                .attr("x", padding)
                .attr("y", padding)
                .attr("width", dimensions.codeWindowWidth)
                .attr("height", dimensions.codeWindowHeight)
                .attr("fill", "#f9f9f9")
                .attr("stroke", "#ccc");

        this.text_area = this.disp_grp.append("foreignObject")
                            .attr("x", padding * 2)
                            .attr("y", padding * 2)
                            .attr("width", dimensions.textAreaWidth-padding)
                            .attr("height", dimensions.textAreaHeight)
                            .append("xhtml:div")
                            .style("overflow-y", "auto")
                            .style("height", `${dimensions.textAreaHeight}px`)
                            .style("width", `${dimensions.textAreaWidth-padding}px`)
                            .style("font-family", "Arial, sans-serif")
                            .style("font-size", "12px")
                            .style("color", "#333")
                            .attr("class", "chat-messages");

        this.disp_grp.append('text')
                .text('The agents will output code here for you to copy and paste. :)')
                .attr('transform', `translate(${padding*2},${padding*4})`)

    }

    render(){
        const self = this;
        this.disp_grp.selectAll('text').remove();
        // console.log("rendercalled", this.model.response);

        console.log("This model updating in render:", this.model.response);

        this.text_area.selectAll('.chat-text')
            .data(this.model.response, (d)=>{this.toHash(d.natural_language)})
            .join(
                enter => {
                    let response_grp = enter.append('g').attr('class', 'chat-text');
                    response_grp.append('div')
                         .attr('class', 'chat-text-natural')
                         .html(d=>{return d.natural_language}); 

                    // response_grp.append('div')
                    //      .attr('class', 'chat-text-hyp')
                    //      .html(d=>{return d.hypothesis});
                    
                    let code_display_grp = response_grp.append('g').attr('class', 'code-grp');
                    
                    let container = code_display_grp.append('div')
                        .attr('class', 'chat-text-code-container')
                        .style('background-color', '#fff')
                        .style('border', '1px solid #ddd')
                        .style('padding', '10px')
                        .style('margin', '10px 0')
                        .style('white-space', 'pre-wrap')
                        .style('font-family', 'monospace')
                        .style('font-size', '12px');

                    container.append('div')
                        .attr('class', 'chat-text-code')
                        .selectAll('p')
                        .data(d => d.code_snippet.split('\n'))
                        .join('p')
                        .text(line => line);

                    response_grp.append('div')
                        .attr('class', 'chat-text')
                        .html(d=>{return d.explanation});

                    
                    response_grp.append('div')
                        .attr('class', 'assumptions-list')
                         .selectAll('p')
                        .data(d => d.assumptions)
                        .join('p')
                        .text((line,i) => `${i+1}. ${line}`);

                    response_grp.append('br');
                    response_grp.append('br');
                    },
                update => {update},
                exit => {exit.remove()}
            )
    }
}

function render({model, el}){
    let data = model.get("_summary_stats");
    model.save_changes();


    let svg = d3.select(el).append('svg').attr('width', 900).attr('height', 400) ;
    svg.style("border", "1px solid black");

    //
    
    


    var data_model = new CSModel(data);

    var agents = {
        analysis_agent: new LLMInterface(data_model, analysis_agent_system_prompt),
        hyp_agent: new LLMInterface(data_model, hypothesis_agent_system_prompt),
        code_agent: new LLMInterface(data_model, code_agent_system_prompt)
    };

    var CI = new ChatInterface(data_model, svg, agents);
    var CDI = new CodeDisplayInterface(data_model, svg);

    data_model.add_view(CI);
    data_model.add_view(CDI);
    


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