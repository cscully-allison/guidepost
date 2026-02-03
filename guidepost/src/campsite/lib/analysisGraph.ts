import { StateGraph, END, START } from "@langchain/langgraph";
import { AnalysisState, AnalysisStateType, llm, log } from "../utils.js";
import { hypothesisNode } from "./base_hypothesis_node.js";
import { array, json } from "zod";

async function vaugenessCheck(original: string, clarifications: Array<string> = [], dataSummary: any): Promise<number> {
    log("\n---------------------------\n");
    log("Evaluating Vaugeness\n");

    const response = await llm.invoke(
      `Report your confidence in the following statement: 
      This research question and the provided clarifications, if present, poses a meaningful analytical question; even if it is underspecified right now.
      The research question: ${original}

      Additional Contextual Information:
      ${clarifications.length ? 'Clarifications: ' + clarifications.join("; ") : ''}
      
      Answer with json formatted with the following two fields:
        confidence: An integer between 0-4 representing your confidence level, where 4 is "very high", 3 is "high", 2 is "medium", 1 is "low", and 0 "very low"
        reasoning: a brief explanation of your reasoning.`
    );
    log( `Vagueness Response: ${response.content}\n`);
    return JSON.parse(String(response.content)).confidence;
}



async function addressedClarificationsCheck(clarificationQuestions: Array<string> = [], clarifications: string): Promise<Array<string>> {
  log("Evaluating Addressed Clarifications\n");

  const response = await llm.invoke(`I will provide you with a list of questions and natural language response that may answer all, some or none of these questions. 
    
    Please compare the natural language response against this list of questions and return any questions which have not been addressed by the response. Ensure that returned questions are phrased exactly how you recieved them. 
    
    Questions: ${clarificationQuestions.join("; ")}
    Clarifications: ${clarifications}

    Return the unaddressed questions as a json formatted list.
    
    `)

  let unclarifiedQuestions = JSON.parse(String(response.content))

  //return all claritifcation questions that have not been addressed in the hypothesis
  return unclarifiedQuestions;
}

const conversationNode = async (state: AnalysisStateType) => {
  log("Conversation Node Start\n");
  // Ask for a more course evaluation at this stage?
  // Vaugeness checker?
  // Asking for confidence level
  // High, medium, low confidence in how confident you are that this can be translated into working analysis code, poses a meaningful analytical question; even if that question is under 
  // specified right now
  
  if(state.substage === "none"){
    log(`clarification turns: ${state.clarificationTurns}\n`);
    if(state.clarificationTurns > 1){
      log("Max Clarification Turns Reached\n-------------------------\n");
      return {
        ...state,
        stage: "break",
        clarificationNeeded: false,
        waitingForUser: false
      };
    }

    const confidence = await vaugenessCheck(state.initialUserQuestion, state.clarifications, state.dataSummary);

    log(`Vagueness score: ${confidence}\n`);

    const needsMore = confidence < 2; // threshold for whether the question is meaningful

    if (needsMore) {
      
      log("Clarification Required"+"\n-------------------------\n");

      //this should come from the llm
      const response = await llm.invoke(`
        Please respond only with a prompt to the user that asks them to clarify their question, do not mention that you are providing a clarification prompt.
        Original Question: 
        ${state.initialUserQuestion} 
        and keep in mind previous clarifications: 
        ${state.clarifications?.join("; ")}
        and the provided data summary:
        ${JSON.stringify(state.dataSummary)}
        ${state.waitingForUser ? `and the question you last asked the user: ${state.userPrompt}`:''}
      `);
      
      return {
        ...state,
        stage: "pause",
        waitingForUser: true,
        userPrompt: response.content,
        clarificationTurns: state.clarificationTurns + 1,
        turns: state.turns + 1
      };
    }
  
    log("No Clarification Needed"+"\n-------------------------\n");

    return {
      ...state,
      stage: "hypothesis",
      clarificationNeeded: needsMore,
      waitingForUser: false
    };
  
  }
  else if(state.substage === "refinement"){

    log("Clarification Refinement Start\n")
    // let unaddressed_clarifications = [];

    // if(state.refinementClarifications.length > 0 && state.refinementQuestions.length > 0){
    // //check which clarifications have been addressed
    //   // remove addressed clarifications from clarifications list
    //   let provided_clarifications = state.refinementClarifications[state.refinementClarifications.length-1];
    //   unaddressed_clarifications = await addressedClarificationsCheck(state.refinementQuestions, provided_clarifications);
    // }else{
    //   unaddressed_clarifications = state.refinementQuestions;
    // }

    // log(""+JSON.stringify(unaddressed_clarifications)+"\n")

    log("Refinement Convo Context:"+JSON.stringify(state.refinementClarifications)+"\n")

    // ask user to address clarification requests presented as an enumerated list
      const response = await llm.invoke(`
        You are an assistant that is conveying potential issues with formalizing a user's provided research question. 
        
        The following points of ambiguity have been raised by a hypothesis translation component: ${state.refinementQuestions.join("; ")}. ${ state.refinementClarifications.length ? `Only tell the user what issues remain to be resolved from the list if they ask or if the conversation context is getting long.`:`Convey these issues to the user in a nicely formatted list.` }

        If a user asks you a question, respond with concise and focused answers to their questions, keeping in mind their original research question and the conversation context.

        If the user asks you to provide initial specifications or handle unresolved points of ambiguity, you may suggest specifications for any element which needs disambiguation. Explicitly tell the user what assumptions you will make. 

        Once you identify that most, or all of the ambiguities have been resolved by your discussion, ask the user to confirm that they would like to develop a formal hypothesis. Only respond with a true for "resolved" if the user has confirmed that they would like you to proceed.

        YOU DO NOT FORMALIZE HYPOTHESES YET. YOUR SOLE PURPOSE IS TO RESOLVE AMBIGUITIES.

        Current conversation context:
        ${state.refinementClarifications.join("; ")}
        Their original research question: 
        ${state.initialUserQuestion}
        and a summary of the data:
        ${JSON.stringify(state.dataSummary)}

        Respond with a json object with three elements:
          {
            "resolved": <a boolean that indicates if ambiguities have been sufficently resolved>, 
            "user_response": <A text based response to the user that addresses the most recent response from the user in the provided conversation context; use markdown formatting where appropriate>,
            "clarifications": <A summary of how the conversation context has clarified points of ambiguity in the hypothesis translation>
          }
      `);

    log("\nClarification Refinement conversation: "+JSON.stringify(response.content)+"\n-------------------------\n")

    if(!JSON.parse(String(response.content)).resolved){
      return {
        ...state,
        stage: "pause",
        waitingForUser: true,
        userPrompt: JSON.parse(String(response.content)).user_response,
        refinementClarifications: [...state.refinementClarifications, JSON.parse(String(response.content)).user_response],
        clarificationTurns: state.clarificationTurns + 1,
        turns: state.turns + 1
      };
    }

    log("Clarification Refinement Done\n"+"-------------------------\n")
    return {
      ...state,
      stage: "hypothesis",
      clarificationNeeded: false,
      waitingForUser: false,
      refinementReport: JSON.parse(String(response.content)).clarifications,
      substage: "refined"
    }

  }

};



const artifactGenNode = async (state: AnalysisStateType) => {
  log("Artifact Node Start\n");
  const resp = await llm.invoke(`
    Generate a function that outputs a single visualization which enables users to test the hypothesis expressed here: ${state.hypothesis}, 
    using the data summarized as: ${JSON.stringify(state.dataSummary)}.

    THe visualization should visualize the models primary quantity of interest and may (when appropriate) annotate the visualization with threshold(s) that may show comparisions necessary for testing a hypothesis visually.

    Model code and data trasnformations should be in Python and use common data science libraries such as statsmodels, pandas, numpy. Visualization code should use the Altair library and pass in vega-lite-based specifications where necessary`);
  log("Code Node End"+JSON.stringify(resp.content)+"\n-------------------------\n");
  return { code: resp.content, stage: "done" };
};



export const analysisAssistant = new StateGraph(AnalysisState)
  .addNode("conversation_manager", conversationNode)
  .addNode("hypothesis_manager", hypothesisNode)
  .addNode("artifact_gen_manager", artifactGenNode)
  .addEdge(START, "conversation_manager")
  .addConditionalEdges(
    "conversation_manager", 
    s => s.stage, 
    { 
      hypothesis: "hypothesis_manager",
      pause: END,
      break: END
    }
  )
  .addConditionalEdges(
    "hypothesis_manager", 
    s => s.stage, 
    {
      conversation: "conversation_manager", // clarification loop
      artifactgen: "artifact_gen_manager"
    }
  )
  .addConditionalEdges("artifact_gen_manager", s => s.stage, { done: END })
  .compile();
