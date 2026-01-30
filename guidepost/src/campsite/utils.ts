import { ChatOpenAI } from "@langchain/openai";
import { GPTConfig } from "../local_configs";
import { z } from "zod";
import fs from "fs/promises";


export const llm = new ChatOpenAI(GPTConfig);

export const AnalysisState = z.object({
  stage: z.enum(["conversation", "hypothesis", "refinement", "artifactgen", "done", "pause", "break"]),
  dataSummary: z.any(),

  initialUserQuestion: z.string(),
  clarifications: z.array(z.string()),
  refinementQuestions: z.array(z.string()),
  refinementClarifications: z.array(z.string()),
  refinementReport: z.string().optional(),

  hypothesis: z.string().optional(),
  code: z.string().optional(),

  clarificationNeeded: z.boolean().optional(),
  userPrompt: z.string().optional(),

  turns: z.number(),
  clarificationTurns: z.number(),

  waitingForUser: z.boolean().optional(),
  substage: z.enum(["none", "refinement", "refined"]).optional()
});

export type AnalysisStateType = z.infer<typeof AnalysisState>;

export const logfile = './log.txt';

export async function log(msg: string) {
  fs.appendFile(logfile, msg);
}

async function logState(state: AnalysisStateType, note: string) {
  fs.appendFile(logfile, `State Log - ${note}:\n${JSON.stringify(state)}\n-------------------------\n`);
}