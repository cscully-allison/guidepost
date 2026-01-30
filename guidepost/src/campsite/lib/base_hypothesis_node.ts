import { AnalysisStateType, log, llm } from "../utils";

async function underspecificationCheck(original_question: string, current_clairifcations:Array<string>, dataSummary:any){
    log(`Underspecification check\n`)
    const response = await llm.invoke(
    ` This is an initial step before fully generating a formal hypothesis. Using the provided research question and any clarifications provided, identify if any elements may be underspecified.

    Do not focus on any implementation details or very low level details at this stage. Only consider points that are critically necessary for an accurate translation from research question to formal hypothesis.
    
    Only return individual underspecifications as a json formatted list of clarification requests. 
    
    Original Question: ${original_question}
    Current Clarifications (may be empty): ${current_clairifcations.join(';')}
    
    Keep in mind that hypotheses may be specified in the context of this dataset, summarized by the following summary.
    
    Relevant Data: ${JSON.stringify(dataSummary)}

    It may be the case that no further clarifications are needed. In that case, return a json formatted empty list.
    `
  )

  log(`Underspecification check done: ${response.content}\n`)

  return JSON.parse(String(response.content));
}


export const hypothesisNode = async (state: AnalysisStateType) => {
  log("Hypothesis Node Start\n");

  if(state.substage === "none"){
    let clarification_prompts:Array<string> = [];
    clarification_prompts = await underspecificationCheck(state.initialUserQuestion, state.clarifications, state.dataSummary)
    log(`Clarifications Required: ${JSON.stringify(clarification_prompts)}`);
    
    if(clarification_prompts.length > 0){
        state.refinementQuestions = clarification_prompts;
        state.substage = "refinement";
        state.stage = "conversation";
        
        //return only if there are clarification prompts required
        return state;
    }
  }

  let resp;
  resp = await llm.invoke(`
      Generate a formal statistical hypothesis from this question: ${state.initialUserQuestion}
      ${state.clarifications.length > 0 ? `, and these initial clarifications ${state.clarifications.join("; ")}`:``}
      and this data summary: ${JSON.stringify(state.dataSummary)}
      ${state.refinementReport ? `and these refinement clarifications: ${state.refinementReport} which answer these identified underspecification ambiguities: ${state.refinementQuestions.join("; ")} `:``}
    `);
  
  log("Hypothesis Node End"+JSON.stringify(resp.content)+"\n-------------------------\n");
  
  log("Onto Artifact Gen\n");
  return { ...state, hypothesis: resp.content, hypothesis_context: '', stage: "artifactgen" };
  
};