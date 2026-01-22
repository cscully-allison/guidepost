import * as d3 from "d3";
import {animate, stagger} from "animejs";
import type { AnyModel } from "@anywidget/types";
import { en } from "zod/locales";

const padding = 10;

class CSModel{
    data:any;
    response: any;
    views:any[];

    constructor(data:any){
        this.data = data;
        this.response = null;

        this.views = [];
    }

    update_response(resp:any){
        this.response =  resp;
        this.update();
    }

    add_view(view:any){
        this.views.push(view);
    }

    update(){
        for(let view of this.views){
            view.render();
        }
    }

}





// class LLMInterface{
//     llm:ChatOpenAI;
//     chain:any;
//     route:any;
//     analysisAssistant:any;

//     constructor(model:any, prompt_text:any){
//         this.llm = new ChatOpenAI(GPTConfig);

//         const AnalysisState = z.object({
//             userQuestion: z.string(),
//             clarifiedQuestion: z.string().nullable(),
//             hypothesis: z.string().nullable(),
//             code: z.string().nullable(),
//             stage: z.enum(["conversation", "hypothesis", "codegen", "done"])
//         });

//         type AnalysisStateType = z.infer<typeof AnalysisState>;

//         const conversationNode = async (state: AnalysisStateType) => {
//             const prompt = `
//             You are a research assistant.

//             User question:
//             ${state.userQuestion}

//             If the question is underspecified, rewrite it in a clarified form.
//             If it is already precise, return it unchanged.
//             `;

//             const response = await this.llm.invoke(prompt);

//             return {
//                 clarifiedQuestion: response.content,
//                 stage: "hypothesis"
//             };
//         };


//         const hypothesisNode = async (state: AnalysisStateType) => {
//             const prompt = `
//             Translate the following research question into a formal,
//             testable statistical hypothesis.

//             Research question:
//             ${state.clarifiedQuestion}

//             Return a null and alternative hypothesis.
//             `;

//             const response = await this.llm.invoke(prompt);

//             return {
//                 hypothesis: response.content,
//                 stage: "codegen"
//             };
//         };

//         const codegenNode = async (state: AnalysisStateType) => {
//             const prompt = `
//                 Generate JavaScript or Python analysis code to test the following hypothesis.

//                 Hypothesis:
//                 ${state.hypothesis}

//                 Use appropriate statistical methods and include comments.
//             `;

//             const response = await this.llm.invoke(prompt);

//             return {
//                 code: response.content,
//                 stage: "done"
//             };
//         };


//         const graph = new StateGraph(AnalysisState);

//         graph.addNode("conversation", conversationNode);
//         graph.addNode("hypothesis", hypothesisNode);
//         graph.addNode("codegen", codegenNode);

//         graph.setEntryPoint("conversation");

//         graph.addConditionalEdges(
//         "conversation",
//         this.route,
//         {
//             hypothesis: "hypothesis"
//         }
//         );

//         graph.addConditionalEdges(
//         "hypothesis",
//         this.route,
//         {
//             codegen: "codegen"
//         }
//         );

//         graph.addConditionalEdges(
//         "codegen",
//         this.route,
//         {
//             done: END
//         }
//         );

//         this.analysisAssistant = graph.compile();
//     }   

//     query_llm(){
//         this.analysisAssistant.invoke({
//             userQuestion: "Does increasing memory allocation reduce HPC job runtime?",
//             clarifiedQuestion: null,
//             hypothesis: null,
//             code: null,
//             stage: "conversation"
//         });
//     }
// }

class ChatInterface {
    model: CSModel;
    svg: d3.selection<SVGSVGElement, unknown, HTMLElement, any>;
    session_info: any;

    constructor(
        model: CSModel,
        svg: d3.selection<SVGSVGElement, unknown, HTMLElement, any>,
        session_info: Object
    ) {
        this.model = model;
        this.svg = svg;
        this.session_info = session_info;
        this.createChatInterface();
    }

    // async routeMessages(user_msg: Object | null = null): Promise<{ target: string; response: string } | string> {
    //     const self = this;

    //     if (user_msg) {
    //         this.conversation_context.push(`user:${user_msg}`);
    //         user_msg = { context: this.conversation_context, content: user_msg };
    //         this.communication_stack.push(
    //             JSON.stringify({ target: "analysis_agent", source: "user", message: user_msg })
    //         );
    //     }

    //     const last_message_raw = this.communication_stack.pop();
    //     if (!last_message_raw) return "";

    //     const last_message = JSON.parse(last_message_raw);
    //     const target = last_message.target;

    //     let response: any = null;

    //     console.log("Most recent message:", last_message);

    //     switch (target) {
    //         case "analysis_agent":
    //             response = await self.analysis_agent.queryLLM(last_message_raw);
    //             this.communication_stack.push(response.content);

    //             const parsed_response = JSON.parse(response.content);

    //             console.log("Analysis agent route:", parsed_response);

    //             this.conversation_context.push(`${"analysis_agent"}:${parsed_response.response}`);

    //             return {
    //                 target: parsed_response.target,
    //                 response: parsed_response.response,
    //             };
    //         case "hypothesis_agent":
    //             response = await self.hyp_agent.queryLLM(last_message_raw);
    //             this.communication_stack.push(response.content);

    //             console.log("Hypothesis agent route:", JSON.parse(response.content));

    //             return {
    //                 target: JSON.parse(response.content).target,
    //                 response: "",
    //             };
    //         case "code_agent":
    //             // Placeholder for code_agent logic
    //             break;
    //         case "vis_agent":
    //             break;
    //         default:
    //             return "";
    //     }

    //     return "";
    // }

    createChatInterface(): void {
        const self = this;

        const buttonHeight = 30;
        const width = +this.svg.attr("width") / 2;
        const height = +this.svg.attr("height") - buttonHeight;

        const dimensions = {
            chatWidth: width - 2 * padding,
            chatHeight: height - 2 * padding,
            messagesHeight: height - 6 * padding,
            textAreaWidth: width - 4 * padding,
            inputHeight: padding * 2,
            buttonHeight: buttonHeight,
        };

        const chatGroup = this.svg.append("g").attr("class", "chat-interface");

        chatGroup
            .append("rect")
            .attr("x", padding)
            .attr("y", padding)
            .attr("width", dimensions.chatWidth)
            .attr("height", dimensions.chatHeight)
            .attr("fill", "#f9f9f9")
            .attr("stroke", "#ccc");

        chatGroup
            .append("foreignObject")
            .attr("x", padding * 2)
            .attr("y", padding * 2)
            .attr("width", dimensions.textAreaWidth - padding)
            .attr("height", dimensions.messagesHeight)
            .append("xhtml:div")
            .style("overflow-y", "auto")
            .style("height", `${dimensions.messagesHeight}px`)
            .style("width", `${dimensions.textAreaWidth - padding}px`)
            .style("font-family", "Arial, sans-serif")
            .style("font-size", "12px")
            .style("color", "#333")
            .attr("class", "chat-messages");

        chatGroup
            .append("foreignObject")
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

        chatGroup
            .append("foreignObject")
            .attr("x", padding * 2)
            .attr("y", height - padding)
            .attr("width", width - 4 * padding)
            .attr("height", buttonHeight)
            .append("xhtml:button")
            .style("width", `${width - 4 * padding}px`)
            .style("height", `${buttonHeight}px`)
            .text("Send")
            .on("click", async (this_evnt:any) => {
                const this_node = this_evnt.currentTarget;
                const inputBox = document.querySelector(".chat-input") as HTMLInputElement;
                const messagesDiv = document.querySelector(".chat-messages") as HTMLDivElement;
                const userMessage = inputBox.value;
                if (userMessage.trim() === "") return;

                const userMsgElem = document.createElement("div");
                userMsgElem.style.textAlign = "right";
                userMsgElem.style.marginBottom = "5px";
                userMsgElem.textContent = `You: ${userMessage}`;
                messagesDiv.appendChild(userMsgElem);

                inputBox.value = "";
                const placeholder = document.createElement("div");
                placeholder.style.textAlign = "left";
                placeholder.style.marginBottom = "5px";
                placeholder.style.height = "40px";
                messagesDiv.appendChild(placeholder);

                const loading = d3.select("#loading");
                loading.attr("visibility", "visible");

                d3.select(this_node).attr("disabled", true);
                
                const response = await fetch(self.session_info["endpoint"] + "/analyze", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        sessionId: self.session_info["session_id"],
                        question: userMessage,
                    }),
                }).then(res => {return res.json()});

                console.log("Fetch response:", response);


                // let resp = await self.routeMessages(userMessage);
                // console.log(resp);

                const llmMsgElem = document.createElement("div");
                llmMsgElem.style.textAlign = "left";
                llmMsgElem.style.marginBottom = "5px";
                llmMsgElem.textContent = `LLM: ${response["userPrompt"]}`;
                messagesDiv.appendChild(llmMsgElem);

                d3.select(this_node).attr("disabled", null);

                messagesDiv.removeChild(placeholder);
                loading.attr("visibility", "hidden");

                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            });

        const loading = chatGroup.append("g").attr("id", "loading").attr("transform", `translate(${0}, ${0})`);

        const dots: SVGCircleElement[] = [];
        for (let x = 0; x < 3; x++) {
            const dot = loading
                .append("circle")
                .attr("class", "loading-dot")
                .attr("cx", 0 + x * 30)
                .attr("cy", 0)
                .attr("r", 8)
                .attr("fill", "grey");
            dots.push(dot.node() as SVGCircleElement);
        }


        animate(dots, {
            translateY: [
                { value: -10, duration: 500 },
                { value: 0, duration: 500 },
            ],
            easing: "easeInOutSine",
            delay: stagger(200),
            loop: true,
        });

        loading.attr("visibility", "hidden");
    }

    render(): void {}
}


class CodeDisplayInterface{
    model:any;
    svg:any;
    dimensions:Object;
    disp_grp:any;
    text_area:any;


    constructor(model:any, svg:any, session_info:Object){
        this.model = model;
        this.svg = svg;
        this.dimensions = {};
        this.disp_grp = null;

        this.createDisplay();   
    }

    toHash(string:string) {
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
            .data(this.model.response, (d:any)=>{this.toHash(d.natural_language)})
            .join(
                (enter:any) => {
                    let response_grp = enter.append('g').attr('class', 'chat-text');
                    response_grp.append('div')
                         .attr('class', 'chat-text-natural')
                         .html((d:any)=>{return d.natural_language}); 

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
                        .data((d:any) => d.code_snippet.split('\n'))
                        .join('p')
                        .text((line:any) => line);

                    response_grp.append('div')
                        .attr('class', 'chat-text')
                        .html((d:any)=>{return d.explanation});

                    
                    response_grp.append('div')
                        .attr('class', 'assumptions-list')
                         .selectAll('p')
                        .data((d:any) => d.assumptions)
                        .join('p')
                        .text((line:any,i:any) => `${i+1}. ${line}`);

                    response_grp.append('br');
                    response_grp.append('br');
                    },
                (update:any) => {update},
                (exit:any) => {exit.remove()}
            )
    }
}

// Update the WidgetModel interface to match the expected signature of the 'on' method
interface WidgetModel extends AnyModel {
  get(key: "_summary_stats"): unknown;
  get(key: "_vis_data"): unknown;
  save_changes(): void;
  on<K extends `change:${string}`>(
    event: K,
    callback: K extends `change:${infer Key}`
      ? (msg: any, buffers: DataView<ArrayBufferLike>[]) => void
      : never
  ): void;
  on(event: "msg:custom", callback: (msg: any, buffers: DataView<ArrayBufferLike>[]) => void): void;
}
export function render({
  model,
  el,
}: {
  model: WidgetModel;
  el: HTMLElement;
}) {
  let data = model.get("_summary_stats");
  let session_info:{session_id:string|unknown, endpoint:string|unknown} = {
    session_id: model.get("_session_id"),
    endpoint: model.get("_node_server_endpoint")
  };
  model.save_changes();

  const svg = d3
    .select(el)
    .append("svg")
    .attr("width", 900)
    .attr("height", 400);

  svg.style("border", "1px solid black");

  const data_model = new CSModel(data);

  const CI = new ChatInterface(data_model, svg, session_info);
  const CDI = new CodeDisplayInterface(data_model, svg, session_info);

  data_model.add_view(CI);
  data_model.add_view(CDI);

  model.on("change:_vis_data", () => {
    const updated = model.get("_vis_data");
    console.log("RE RENDER:", updated);
  });
}


export default{ render };