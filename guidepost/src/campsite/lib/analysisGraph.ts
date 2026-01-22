import { boolean, z } from "zod";
import { StateGraph, END, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import {GPTConfig} from "../../local_configs.js";
import fs from "fs/promises";
const logfile = './log.txt';

const llm = new ChatOpenAI(GPTConfig);

export const AnalysisState = z.object({
  stage: z.enum(["conversation", "hypothesis", "refinement", "codegen", "done", "pause"]),

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

async function evaluateClarity(original: string, clarifications: Array<string> = []) {
  fs.appendFile(logfile, "Evaluating Clarity\n");
  
  if(clarifications.length === 0){
    const response = await llm.invoke(
      `Does the following research question need more details to be formalized into a hypothesis? 
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
  const clarityScore = await evaluateClarity(state.initialUserQuestion, state.clarifications);
  fs.appendFile(logfile, `Clarity Score: ${clarityScore}\n`);

  const needsMore = clarityScore < 0.5;

  if (needsMore) {
    
    fs.appendFile(logfile, "Clarification Required"+"\n-------------------------\n");

    //this should come from the llm
    const response = await llm.invoke(`
      Please provide a prompt to the user that asks them to clarify their question: 
      ${state.initialUserQuestion} 
      and keep in mind previous clarifications: 
      ${state.clarifications?.join("; ")}`);
    // const prompt = `Please clarify your question: "${state.userQuestion}"`;
    
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
  const resp = await llm.invoke(` Generate a formal statistical hypothesis from this question: ${state.initialUserQuestion} and these clarifications: ${state.clarifications?.join("; ")}`);
  fs.appendFile(logfile, "Hypothesis Node End"+JSON.stringify(resp.content)+"\n-------------------------\n");
  return { hypothesis: resp.content, stage: "codegen" };
};

const codegenNode = async (state: AnalysisStateType) => {
  fs.appendFile(logfile, "Code Node Start\n");
  const resp = await llm.invoke(`Generate analysis code for: ${state.hypothesis}`);
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
