import * as d3 from "https://esm.sh/d3@7";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";

const padding = 10;
const margin = 10;



class CSModel{
    constructor(data){
        this.data = data;
    }
}

class LLMInterface{
    constructor(model){
        this.model = model;
        this.llm_model = new ChatOpenAI({
            apiKey: 'sk-proj-2iPfzwxhG9F4Pfw98Gczg2SYpYkrawCWKQzUg8laitdOluXahzCehAnvgki2DIuxf6dSTD99FIJT3BlbkFJ7IDUfbkG9Wmxz_yog3eCL1AF3gVsqmEqQ3R0VE4iI3SjJgubGu7S0dhGNkhJ4zoFo8sVY1MUMA',
            model: "gpt-5-nano",
        });

        this.prompt = ChatPromptTemplate.fromMessages([
            ["system", "You are {persona}. {style}. Context: {context}"],
            ["human", "{input}"]
        ]);

        this.chain = this.prompt.pipe(this.llm_model);
    }   
    
    async queryLLM(question){
        
        const reply = await this.chain.invoke({
            persona: "an expert software engineer",
            style: 'Answer the user\'s question using ONLY the provided context. If the answer is not in the context, say "I don\'t know."',
            context: `The user has provided summary statistics about their dataset. It is organized as a dictonary where keys in the first level are column names
            and the values are dictonaries with summary statistics about that column. Here is the data:
            ${JSON.stringify(this.model.data)}`,
            input: question
        });

        return reply;
    }
}

class ChatInterface{
    constructor(model, svg, llmInterface){
        this.model = model;
        this.svg = svg;
        this.createChatInterface();
        this.llm = llmInterface;

        console.log("SUMMARIES", model.data);        
    }   
    

    createChatInterface() {

        const buttonHeight = 30;
        const width = +this.svg.attr("width");
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
            .attr("width", dimensions.textAreaWidth)
            .attr("height", dimensions.messagesHeight)
            .append("xhtml:div")
            .style("overflow-y", "auto")
            .style("height", `${dimensions.messagesHeight}px`)
            .style("width", `${dimensions.textAreaWidth}px`)
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
            .on("click", async () => {
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

                // Query LLM and display response
                const llmResponse = await this.llm.queryLLM(userMessage);
                const llmMsgElem = document.createElement("div");
                llmMsgElem.style.textAlign = "left";
                llmMsgElem.style.marginBottom = "5px";
                llmMsgElem.textContent = `LLM: ${llmResponse.content}`;
                messagesDiv.appendChild(llmMsgElem);

                // Scroll to bottom
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            });
    }



    render(){

    }
}

function render({model, el}){
    let data = model.get("_summary_stats");
    console.log("Breeep BOOP render called with data:", model.get("_vis_data"));
    model.save_changes();


    let svg = d3.select(el).append('svg').attr('width', 300).attr('height', 300) ;
    svg.style("border", "1px solid black");
    

    var data_model = new CSModel(data);
    var llmInterface = new LLMInterface(data_model);
    var CI = new ChatInterface(data_model, svg, llmInterface);
    


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