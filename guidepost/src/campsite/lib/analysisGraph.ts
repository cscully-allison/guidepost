import { boolean, z } from "zod";
import { StateGraph, END, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import {GPTConfig} from "../../local_configs.js";
import fs from "fs/promises";
import { stat } from "fs";
const logfile = './log.txt';

const llm = new ChatOpenAI(GPTConfig);

export const AnalysisState = z.object({
  stage: z.enum(["conversation", "hypothesis", "refinement", "codegen", "done", "pause"]),
  dataSummary: z.any(),

  initialUserQuestion: z.string(),
  clarifications: z.array(z.string()),

  hypothesis: z.string().optional(),
  code: z.string().optional(),

  clarificationNeeded: z.boolean().optional(),
  userPrompt: z.string().optional(),

  turns: z.number(),
  clarificationTurns: z.number(),

  waitingForUser: z.boolean().optional()
});

export type AnalysisStateType = z.infer<typeof AnalysisState>;

async function evaluateClarity(original: string, clarifications: Array<string> = [], dataSummary: any): Promise<number> {
  fs.appendFile(logfile, "Evaluating Clarity\n");
  
  if(clarifications.length === 0){
    const response = await llm.invoke(
      `Does the following research question with the provided context of this data summary need more details to be formalized into a hypothesis?
      Data Summary: ${JSON.stringify(dataSummary)}
      Original Question: ${original}
      Answer with json formatted with the follwing two fields:
        rating: a clarity rating from 0 to 1 where 0 means "not clear at all" and 1 means "completely clear".
        reasoning: a brief explanation of the rating.`
    );
    fs.appendFile(logfile, `Clarity Response: ${response.content}\n`);
    return parseFloat(JSON.parse(response.content).rating);
  }

  const response = await llm.invoke(
    `Does the following research question with clarifications need more details to be formalized into a hypothesis?
    Data Summary: ${JSON.stringify(dataSummary)} 
    Original Question: ${original}
    Clarifications: ${clarifications.join("; ")}
    Answer with json formatted with the follwing two fields:
      rating: a clarity rating from 0 to 1 where 0 means "not clear at all" and 1 means "completely clear".
      reasoning: a brief explanation of the rating.`
  );
  fs.appendFile(logfile, `Clarity Response: ${response.content}\n`);
  return parseFloat(JSON.parse(response.content).rating);

}

const conversationNode = async (state: AnalysisStateType) => {
  fs.appendFile(logfile, "Conversation Node Start\n");
  // Ask for a more course evaluation at this stage?
  // Vaugeness checker?
  // Asking for confidence level
  // High, medium, low confidence in how confident you are that this can be translated into working analysis code, poses a meaningful analytical question; even if that question is under 
  // specified right now
  const clarityScore = await evaluateClarity(state.initialUserQuestion, state.clarifications, state.dataSummary);
  fs.appendFile(logfile, `Clarity Score: ${clarityScore}\n`);

  const needsMore = clarityScore < 0.5;


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
      `);
    if(state.waitingForUser){
      const response = await llm.invoke(`
        Please respond only with a prompt to the user that asks them to clarify their question, do not mention that you are providing a clarification prompt.
        Original Question: 
        ${state.initialUserQuestion} 
        Also keep in mind previous clarifications: 
        ${state.clarifications?.join("; ")}
        the provided data summary:
        ${JSON.stringify(state.dataSummary)}
        and the question you last asked the user:
        ${state.userPrompt}
      `);
    }
    
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

};

const hypothesisNode = async (state: AnalysisStateType) => {
  fs.appendFile(logfile, "Hypothesis Node Start\n");
  const resp = await llm.invoke(`
    Generate a formal statistical hypothesis from this question: ${state.initialUserQuestion}
    and these clarifications: ${state.clarifications?.join("; ")}
    and this data summary: ${JSON.stringify(state.dataSummary)}`);
  fs.appendFile(logfile, "Hypothesis Node End"+JSON.stringify(resp.content)+"\n-------------------------\n");
  return { hypothesis: resp.content, stage: "codegen" };
};

const codegenNode = async (state: AnalysisStateType) => {
  fs.appendFile(logfile, "Code Node Start\n");
  const resp = await llm.invoke(`
    Generate analysis code for: ${state.hypothesis}, 
    using the data summarized as: ${JSON.stringify(state.dataSummary)}.
    The code should be in Python and use common data science libraries such as statsmodels, pandas, numpy, matplotlib, or seaborn.`);
  fs.appendFile(logfile, "Code Node End"+JSON.stringify(resp.content)+"\n-------------------------\n");
  return { code: resp.content, stage: "done" };
};

export const analysisAssistant = new StateGraph(AnalysisState)
  .addNode("conversation_manager", conversationNode)
  .addNode("hypothesis_manager", hypothesisNode)
  .addNode("codegen_manager", codegenNode)
  .addEdge(START, "conversation_manager")
  .addConditionalEdges(
    "conversation_manager", 
    s => s.stage, 
    { 
      hypothesis: "hypothesis_manager",
      pause: END
    }
  )
  .addConditionalEdges(
    "hypothesis_manager", 
    s => s.stage, 
    {
      conversation: "conversation_manager", // clarification loop
      codegen: "codegen_manager"
    }
  )
  .addConditionalEdges("codegen_manager", s => s.stage, { done: END })
  .compile();
