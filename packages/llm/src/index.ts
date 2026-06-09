// The provider-agnostic LLM layer (CLAUDE.md invariant 3): complete() is the
// only way the rest of the repo touches a model, and the only writer of
// model_calls. embed() arrives with MC-201 (Phase 2).
export const LLM_PACKAGE = "@mission-control/llm";
export * from "./config";
export * from "./types";
export * from "./complete";
