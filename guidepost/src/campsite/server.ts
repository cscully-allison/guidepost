// server.ts
import express from "express";
import cors from "cors";
import { analysisAssistant, AnalysisStateType } from "./lib/analysisGraph.ts";
import fs from "fs/promises";

const app = express();
app.use(cors());
app.use(express.json());

const logfile = './log.txt';

// In-memory session store
const sessions = new Map<string, AnalysisStateType>();

let query:number = 0;


app.post("/analyze", async (req, res) => {
    const { sessionId, question, dataSummary } = req.body;
    let state: AnalysisStateType;

    // fs.appendFile(logfile, `Call to /analyze: ${JSON.stringify(dataSummary)}\n`);

    if (sessions.has(sessionId)) {
        state = sessions.get(sessionId)!;
    } else {
        // New session
        state = {
            dataSummary: dataSummary,
            initialUserQuestion: question,
            clarifications: [],
            hypothesis: undefined,
            code: undefined,
            stage: "conversation",
            clarificationNeeded: undefined,
            turns: 0,
            clarificationTurns: 0,
            waitingForUser: false
        };
        sessions.set(sessionId, state);
    }

    //update followup questions while we are waiting
    if(state.waitingForUser){
        state.clarifications.push(question);
    }

    
    // fs.appendFile(logfile, `Call to /analyze post init: ${JSON.stringify(dataSummary)}\n`);

    const result:any = await analysisAssistant.invoke(state);
    sessions.set(sessionId, result); // persist updated state

    if (result.waitingForUser) {
        // Return prompt to frontend
        return res.json({
            ...result,
            waiting: true
        });
    }

    // Return final result
    return res.json({
        waiting: false,
        hypothesis: result.hypothesis,
        code: result.code
    });
});

app.get("/ping", (req, res) => res.send(`${query++}`));

const port = Number(process.argv[2]) || 3000;

app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`READY:${port}\n`);
});

export function startServer(port: number) {
    return app.listen(port, "127.0.0.1", () => {
        console.log(`READY:${port}`);
    });
}