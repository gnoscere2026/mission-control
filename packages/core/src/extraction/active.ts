import { extractCommitmentsV1, type ExtractionPromptModule } from "./extract_commitments.v1";

// THE single config place for the active extraction version (CLAUDE.md
// conventions; EVAL-SPEC §5.3 — activation = changing this reference, then
// `npm run eval:activate` records the prompt_versions row from the committed
// results file).
export const ACTIVE_EXTRACTION: ExtractionPromptModule = extractCommitmentsV1;

// Registry the eval harness selects versions from (--version vN).
export const EXTRACTION_VERSIONS: Record<string, ExtractionPromptModule> = {
  v1: extractCommitmentsV1,
};
