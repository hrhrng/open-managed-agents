import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssemblyState } from "../types";

/** Layer-2 component contracts (PR2 stubs; presets wire in later PRs). */

export interface PromptSectionContributor {
  readonly id: string;
  contribute(): Promise<string | null>;
}

export interface SkillExposer {
  expose(): Promise<{ section: string; loadedSkillIds: string[] }>;
}

export interface BudgetGuard {
  trim(messages: AgentMessage[]): Promise<AgentMessage[]>;
}

export interface PermissionGate {
  beforeToolCall(toolName: string): Promise<{ allow: boolean; reason?: string }>;
}

export interface ContextReassembler {
  reassembleAfterCompaction(state: AssemblyState, summary: string): Promise<AssemblyState>;
}

export interface WindowPolicyDriver {
  readonly name: string;
  onTurnStart(): Promise<void>;
}
