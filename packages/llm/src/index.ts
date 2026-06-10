// The provider-agnostic LLM layer (CLAUDE.md invariant 3): complete() and
// embed() are the only ways the rest of the repo touches a model, and the
// only writers of model_calls. MC-201 shipped embed() (Phase 2).
export const LLM_PACKAGE = "@mission-control/llm";
export * from "./config";
export * from "./types";
export * from "./complete";
export * from "./embed";
// ./voyage is deliberately NOT exported: the adapter factory would let callers
// bypass embed() and its model_calls write (same treatment as ./anthropic).
