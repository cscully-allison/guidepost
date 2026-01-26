import { boolean, z } from "zod";
import { StateGraph, END, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import {GPTConfig} from "../../local_configs.js";
import fs from "fs/promises";
import { stat } from "fs";
const logfile = './log.txt';

const llm = new ChatOpenAI(GPTConfig);

export const AnalysisState = z.object({
  stage: z.enum(["conversation", "hypothesis", "refinement", "artifactgen", "done", "pause", "break"]),
  dataSummary: z.any(),

  initialUserQuestion: z.string(),
  clarifications: z.array(z.string()),
  clarificationQuestions: z.array(z.string()),

  hypothesis: z.string().optional(),
  code: z.string().optional(),

  clarificationNeeded: z.boolean().optional(),
  userPrompt: z.string().optional(),

  turns: z.number(),
  clarificationTurns: z.number(),

  waitingForUser: z.boolean().optional(),
  substage: z.enum(["none", "refinement"]).optional()
});

export type AnalysisStateType = z.infer<typeof AnalysisState>;

async function vaugenessCheck(original: string, clarifications: Array<string> = [], dataSummary: any): Promise<number> {
  fs.appendFile(logfile, "Evaluating Vaugeness\n");

    const response = await llm.invoke(
      `Rate the following research question based on whether it ${clarifications.length ? 'and the provided clarifications' : ''} could resonably be developed into a formal hypothesis, regardless of whether specific elements are underspecified?
      Original Question: ${original}
      ${clarifications.length ? 'Clarifications: ' + clarifications.join("; ") : ''}    
      Answer with json formatted with the following two fields:
        vaugeness: a likert-scale rating from 0 to 3 where 0 means "very vague," 1 means "somewhat vague," 2 means "somewhat clear" and 3 means "very clear".
        reasoning: a brief explanation of your reasoning.`
    );
    fs.appendFile(logfile, `Vagueness Response: ${response.content}\n`);
    return JSON.parse(String(response.content)).vaugeness;
}

async function addressedClarificationsCheck(clarificationQuestions: Array<string> = [], clarifications: Array<string> = [], hypothesis: string): Promise<Array<string>> {
  fs.appendFile(logfile, "Evaluating Addressed Clarifications\n");
  const response = await llm.invoke("")

  //ask llm to compare provided answers and with questions and identify which questions have not yet been addressed

  //return all claritifcation questions that have not been addressed in the hypothesis
  return clarificationQuestions;
}

const conversationNode = async (state: AnalysisStateType) => {
  fs.appendFile(logfile, "Conversation Node Start\n");
  // Ask for a more course evaluation at this stage?
  // Vaugeness checker?
  // Asking for confidence level
  // High, medium, low confidence in how confident you are that this can be translated into working analysis code, poses a meaningful analytical question; even if that question is under 
  // specified right now
  
  if(state.substage === "none"){
    fs.appendFile(logfile, `clarification turns: ${state.clarificationTurns}\n`);
    if(state.clarificationTurns > 2){
      fs.appendFile(logfile, "Max Clarification Turns Reached\n-------------------------\n");
      return {
        ...state,
        stage: "break",
        clarificationNeeded: false,
        waitingForUser: false
      };
    }

    const vagueness = await vaugenessCheck(state.initialUserQuestion, state.clarifications, state.dataSummary);

    fs.appendFile(logfile, `Vagueness score: ${vagueness}\n`);

    const needsMore = vagueness > 1; // threshold for whether the question is meaningful

    if (needsMore) {
      
      fs.appendFile(logfile, "Clarification Required"+"\n-------------------------\n");

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
  
    fs.appendFile(logfile, "No Clarification Needed"+"\n-------------------------\n");

    return {
      ...state,
      stage: "hypothesis",
      clarificationNeeded: needsMore,
      waitingForUser: false
    };
  
  }
  else if(state.substage === "refinement"){
    //check which clarifications have been addressed
        // remove addressed clarifications from clarifications list

    if( state.clarifications.length > 0 ){
      // ask user to address clarification requests presented as an enumerated list
      const response = await llm.invoke(`
        The hypothesis generation step indicated that the following clarifications were needed to create a formal hypothesis:
        ${state.clarificationQuestions.join("; ")}

        Please respond only with a prompt to the user that asks them to clarify their question based on these needed clarifications, do not mention that you are providing a clarification prompt.
        
        Original Question: 
        ${state.initialUserQuestion}
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
  }

};

const hypothesisNode = async (state: AnalysisStateType) => {
  fs.appendFile(logfile, "Hypothesis Node Start\n");

  let resp;
  if(state.clarifications.length === 0){
    resp = await llm.invoke(`
      Generate a formal statistical hypothesis from this question: ${state.initialUserQuestion}
      and this data summary: ${JSON.stringify(state.dataSummary)}

      If any clarifications are needed to make this into a formal hypothesis do not generate a hypothesis, instead respond with a list of specific clarifying questions that would need to be answered to create a formal hypothesis.
      Otherwise, respond with the formal hypothesis.

      Format your response as follows:
      If you are able to generate a formal hypothesis, respond with:
      {
        "type": "hypothesis",
        "content": "Your formal hypothesis here"
      }

      If you need more clarifications, respond with:
      {
        "type": "refinements",
        "content": ["Clarifying question 1", "Clarifying question 2"]
      }
    `);
  }
  else{
    resp = await llm.invoke(`
      Generate a formal statistical hypothesis from this question: ${state.initialUserQuestion}
      and this data summary: ${JSON.stringify(state.dataSummary)}
      and these clarifications: ${state.clarifications.join("; ")}

      Format your response as follows:
      If you are able to generate a formal hypothesis, respond with:
      {
        "type": "hypothesis",
        "content": "Your formal hypothesis here"
      }
    `);
  }
  
  fs.appendFile(logfile, "Hypothesis Node End"+JSON.stringify(resp.content)+"\n-------------------------\n");
  
  if(JSON.parse(String(resp.content)).type === "refinements"){
    state.stage = "conversation";
    return { ...state, clarificationQuestions: resp.content, substage: "refinement" };
  }else{
    return { ...state, hypothesis: resp.content, hypothesis_context: '', stage: "artifactgen" };
  }
};

const artifactGenNode = async (state: AnalysisStateType) => {
  fs.appendFile(logfile, "Artifact Node Start\n");
  const resp = await llm.invoke(`
    Generate a function that outputs a single visualization which enables users to test the hypothesis expressed here: ${state.hypothesis}, 
    using the data summarized as: ${JSON.stringify(state.dataSummary)}.
    The code should be in Python and use common data science libraries such as statsmodels, pandas, numpy, matplotlib, or seaborn.`);
  fs.appendFile(logfile, "Code Node End"+JSON.stringify(resp.content)+"\n-------------------------\n");
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
