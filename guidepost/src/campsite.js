import * as d3 from "https://esm.sh/d3@7";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { hypothesis_agent_system_prompt, code_agent_system_prompt, analysis_agent_system_prompt } from "./prompt_engineering"; 
import {GPTConfig} from "./local_configs";
import anime from "https://esm.sh/animejs@3.2.1";
import { stackOrderNone } from "d3";


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
        this.cached_reponse = null;

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

        this.cached_reponse = reply.content;

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

        this.communication_stack = [];
        this.conversation_context = [];

        console.log("SUMMARIES", model.data);        
    }   
    
    async routeMessages(user_msg=null){
        const self = this;

        //stringified and pushed to conform to existing workflow
        if(user_msg){
            this.conversation_context.push(`user:${user_msg}`)
            user_msg = {context: this.conversation_context, content:user_msg}
            this.communication_stack.push(JSON.stringify({target: "analysis_agent", source: "user", message: user_msg}));
        }

        let last_message_raw = this.communication_stack.pop();
        let last_message = JSON.parse(last_message_raw);
        let target = last_message.target;

        let response = null;
        
        console.log("Most recent message:", last_message);

        switch(target){
            case "analysis_agent":
                response = await self.analysis_agent.queryLLM(last_message_raw);
                this.communication_stack.push(response.content);

                let parsed_response = JSON.parse(response.content);

                console.log("Analysis agent route:", JSON.parse(response.content));

                this.conversation_context.push(`${"analysis_agent"}:${parsed_response.response}`)

                return {
                    target: parsed_response.target,
                    response: parsed_response.response
                }
            case "hypothesis_agent":
                

                response = await self.hyp_agent.queryLLM(last_message_raw);
                this.communication_stack.push(response.content);

                console.log("Hypothesis agent agent route:", JSON.parse(response.content));

                return {
                    target: JSON.parse(response.content).target,
                    response: ""
                };
            case "code_agent":
                // console.log("DONT GO HERE");
                // response = await self.code_agent.queryLLM(last_message['hypotheses']);
                // this.communication_stack.push(response.content);
                
                // console.log("Code agent agent route:", JSON.parse(response.content));

                // return {
                //     target: JSON.parse(response.content).target,
                //     response: ""
                // };
                break;
            case "vis_agent":
                break;
            defualt:
                return "";
                break;
        }




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

                let resp = await self.routeMessages(userMessage);
                console.log(resp);

                let llmMsgElem = document.createElement("div");
                llmMsgElem.style.textAlign = "left";
                llmMsgElem.style.marginBottom = "5px";
                llmMsgElem.textContent = `LLM: ${resp['response']}`;
                messagesDiv.appendChild(llmMsgElem);

                let i = 0;
                while(resp.target !== "user" && i < 2){
                    resp = await self.routeMessages();
                    console.log(resp.target, resp.response);
                    i++;

                    if(resp.target && resp.target === "user"){
                        llmMsgElem = document.createElement("div");
                        llmMsgElem.style.textAlign = "left";
                        llmMsgElem.style.marginBottom = "5px";
                        llmMsgElem.textContent = `LLM: ${resp['response']}`;
                        messagesDiv.appendChild(llmMsgElem);
                    }
                }
                


                // // Query LLM and display response
                // let hypResponse, codeResponse, assistantResponse;


                // //here we need routing logic that skips assisstant if target is not user
                // assistantResponse = await self.analysis_agent.queryLLM(userMessage);


                // if(assistantResponse != ){
                //     hypResponse = await self.hyp_agent.queryLLM(JSON.parse(assistantResponse.content)['discussion_context']);
                //     console.log("Hyp Agent Resp:", JSON.parse(hypResponse.content));

                
                //     codeResponse = await self.code_agent.queryLLM(JSON.parse(hypResponse.content)['hypotheses']);
                //     console.log("Code Agent Resp:", JSON.parse(codeResponse.content));
                //     let resp_content = JSON.parse(codeResponse.content)
                //     self.model.update_response(resp_content['hypotheses']);
                // }

 
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