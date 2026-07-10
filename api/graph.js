// api/graph.js  — orchestration layer for chat.js
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
// reuse your EXISTING functions — no rewrites:
import {
  routeToAgent, getLiveTrainingContext,
  denseRetrieve, sparseRetrieve, reciprocalRankFusion,
  evaluateRetrieval, rewriteQuery, webSearchFallback,
  rerankerScore, callModelWithFallback, generateSuggestions,
} from "./chat-lib.js";

// 1 ── State: one object flows through every node (this is your checkpoint)
const S = Annotation.Root({
  messages:     Annotation(),
  queryText:    Annotation(),
  agent:        Annotation(),
  liveTraining: Annotation({ default: () => "" }),
  chunks:       Annotation({ default: () => [] }),
  evalScore:    Annotation({ default: () => 0 }),
  rewrites:     Annotation({ reducer: (a, b) => a + b, default: () => 0 }), // loop counter
  reply:        Annotation(),
  suggestions:  Annotation(),
});

// 2 ── Nodes: thin wrappers that return the slice of state they change
const route = async (s) => {
  const agent = routeToAgent(s.queryText);
  const live  = agent.key === "running" ? await getLiveTrainingContext() : "";
  return { agent, liveTraining: live };
};
const retrieve = async (s) => {
  const merged = reciprocalRankFusion(
    await denseRetrieve(s.queryText), await sparseRetrieve(s.queryText));
  return { chunks: merged };
};
const grade    = async (s) => ({ evalScore: await evaluateRetrieval(s.queryText, s.chunks) });
const rewrite  = async (s) => ({ queryText: await rewriteQuery(s.queryText), rewrites: 1 });
const search   = async (s) => ({ chunks: await webSearchFallback(s.queryText) });
const rerank   = async (s) => ({ chunks: await rerankerScore(s.queryText, s.chunks) });
const generate = async (s) => ({ reply: await callModelWithFallback(s) });
const suggest  = async (s) => ({ suggestions: await generateSuggestions(s.queryText, s.reply, s.agent.key) });

// 3 ── Conditional edge: the "grade" decision, now a named router with a loop cap
const afterGrade = (s) => {
  if (s.evalScore >= 0.6)  return "rerank";        // good enough
  if (s.rewrites   >= 2)   return "search";        // give up rewriting → web fallback
  return "rewrite";                                 // try a better query
};

// 4 ── Wire the graph (reads exactly like the diagram)
export const chatGraph = new StateGraph(S)
  .addNode("route", route).addNode("retrieve", retrieve).addNode("grade", grade)
  .addNode("rewrite", rewrite).addNode("search", search).addNode("rerank", rerank)
  .addNode("generate", generate).addNode("suggest", suggest)
  .addEdge(START, "route").addEdge("route", "retrieve").addEdge("retrieve", "grade")
  .addConditionalEdges("grade", afterGrade, ["rewrite", "search", "rerank"])
  .addEdge("rewrite", "retrieve")   // the loop
  .addEdge("search", "rerank")
  .addEdge("rerank", "generate").addEdge("generate", "suggest").addEdge("suggest", END)
  .compile();
