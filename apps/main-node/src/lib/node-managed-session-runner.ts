import { SessionSandboxRuntime, type SessionSandboxMode } from "@open-managed-agents/session-runtime";
import {
  withSandboxExecutionGuard,
  type SandboxExecutor,
} from "@open-managed-agents/sandbox";
import { randomUUID } from "node:crypto";
import type {
  HarnessContext,
  HarnessInterface,
} from "@open-managed-agents/agent/harness/interface";
import { ConfigError } from "@open-managed-agents/shared";
import type {
  Environment,
  Session,
  SessionEventView,
  SpanModelUsageView,
  ToolResultContentBlock,
} from "@open-managed-agents/managed-agents-application";
import {
  abortedError,
  abortableDelay,
  linkAbort,
  untilAborted,
  type NodeManagedSessionRunner,
  type NodeManagedSessionRunnerAcceptInput,
  type StartNodeManagedSessionRuntime,
  type StopNodeManagedSessionRuntime,
  type ArchiveNodeManagedSessionThread,
} from "./node-managed-session-runtime.js";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { ManagedNodeHarnessRuntime } from "./node-managed-harness-runtime.js";
import type { WorkspaceBinding, WorkspacePersistencePort, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import type { NodeManagedWorkspaceCheckpoints } from "./node-managed-workspace-checkpoints.js";
import { ScopedSessionMap } from "./scoped-session-map.js";
import {
  ManagedNodeSubagents,
  managedEventThread,
  type ManagedNodeCreateSubagent,
  type ManagedNodeSubagentControl,
  type ManagedNodeSubagentPolicy,
  type ManagedNodeSubagentThreads,
} from "./node-managed-subagents.js";

export type { ManagedNodeSubagentControl } from "./node-managed-subagents.js";

interface ManagedRunnerSubagentContext {
  subagents?: ManagedNodeSubagentControl;
  delegateToAgent?: (agentId: string, message: string) => Promise<string>;
}

interface ManagedRunnerContext {
  workspaceId: string;
  session: Session;
  environment: Environment;
}

interface ManagedWorkspaceState {
  port: WorkspacePersistencePort;
  binding: WorkspaceBinding;
  scope: RuntimeResourceScope;
  fence: SessionExecutionFence;
  activeId: string | null;
  /** A failed/interrupted turn may leave bytes that were never published. */
  trusted: boolean;
}

export type ManagedNodeToolConfirmation = Extract<
  NodeManagedSessionRunnerAcceptInput["events"][number],
  { type: "user.tool_confirmation" }
>;

export type ManagedNodeConfirmableToolUse = Extract<
  SessionEventView,
  { type: "agent.tool_use" | "agent.mcp_tool_use" }
>;

export interface ExecuteManagedNodeConfirmedTool {
  workspaceId: string;
  session: Session;
  environment: Environment;
  sandbox: SandboxExecutor;
  confirmation: ManagedNodeToolConfirmation;
  toolUse: ManagedNodeConfirmableToolUse;
  abortSignal: AbortSignal;
}

export interface ManagedNodeConfirmedToolExecutionResult {
  content?: ToolResultContentBlock[];
  isError?: boolean | null;
}

export interface ManagedNodeConfirmedToolExecutionPort {
  execute(
    input: ExecuteManagedNodeConfirmedTool,
  ): Promise<ManagedNodeConfirmedToolExecutionResult>;
}

export type ManagedNodeDefinedOutcome = Extract<
  NodeManagedSessionRunnerAcceptInput["events"][number],
  { type: "user.define_outcome" }
>;

export interface EvaluateManagedNodeOutcome {
  workspaceId: string;
  session: Session;
  environment: Environment;
  outcome: ManagedNodeDefinedOutcome;
  historyEvents: SessionEventView[];
  iteration: number;
  abortSignal: AbortSignal;
}

export interface ManagedNodeOutcomeEvaluationResult {
  result: "satisfied" | "needs_revision" | "failed";
  explanation: string;
  usage: SpanModelUsageView;
}

export interface ManagedNodeOutcomeEvaluationPort {
  evaluate(
    input: EvaluateManagedNodeOutcome,
  ): Promise<ManagedNodeOutcomeEvaluationResult>;
}

export interface DefaultNodeManagedSessionRunnerDependencies {
  /**
   * In-place retry of a harness failure while the turn has produced no
   * `agent.*` event (e.g. the model call failed before producing output). Each
   * retry emits `session.error{retrying}` + `session.status_rescheduled`.
   * Default: 3 attempts, backoff min(30s, 2s * 2^(n-1)).
   */
  harnessRetry?: { attempts: number; delayMs(attempt: number): number };
  subagentThreads?: ManagedNodeSubagentThreads;
  subagentPolicy?(input: ManagedRunnerContext): ManagedNodeSubagentPolicy | Promise<ManagedNodeSubagentPolicy>;
  resolveSubagentSession?(input: ManagedRunnerContext & { request: ManagedNodeCreateSubagent }): Promise<Session>;
  confirmedTools: ManagedNodeConfirmedToolExecutionPort;
  outcomes: ManagedNodeOutcomeEvaluationPort;
  sandboxMode?(input: ManagedRunnerContext): SessionSandboxMode | Promise<SessionSandboxMode>;
  buildSandbox(input: ManagedRunnerContext & { signal?: AbortSignal }): Promise<SandboxExecutor>;
  /** Optional checkpoint_restore workspace. Ordinary OSS mounts are a different strategy. */
  workspaceCheckpoints?: NodeManagedWorkspaceCheckpoints;
  prepareSandbox?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    runtimeGeneration: string;
    signal?: AbortSignal;
  }): Promise<void>;
  /** Fenced turn barrier for provider-neutral writable state reconciliation. */
  /** Extra runtime-state check before reusing a warm sandbox (for example
   * shared Session outputs advanced by another replica). */
  isSandboxCurrent?(input: ManagedRunnerContext & { runtimeGeneration: string }): Promise<boolean>;
  synchronizeSandbox?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    runtimeGeneration: string;
    executionFence: SessionExecutionFence;
  }): Promise<void>;
  /** Runs after all terminal facts have committed, while the execution still
   * owns its existing fence. Suitable for immutable output publication. */
  afterExecution?(input: ManagedRunnerContext & {
    sandbox: SandboxExecutor;
    runtimeGeneration: string;
    executionFence: SessionExecutionFence;
  }): Promise<void>;
  buildModel(input: ManagedRunnerContext): Promise<HarnessContext["model"]>;
  buildTools(
    input: ManagedRunnerContext & ManagedRunnerSubagentContext & { sandbox: SandboxExecutor },
  ): Promise<HarnessContext["tools"]>;
  disposeTools?(tools: HarnessContext["tools"]): Promise<void>;
  buildHarness(): HarnessInterface;
  buildHarnessContext(input: ManagedRunnerContext & ManagedRunnerSubagentContext & {
    acceptedEvents: NodeManagedSessionRunnerAcceptInput["events"];
    sandbox: SandboxExecutor;
    runtime: ManagedNodeHarnessRuntime;
    model: HarnessContext["model"];
    tools: HarnessContext["tools"];
  }): Promise<HarnessContext>;
  clock: { now(): Date };
  ids: { nextEventId(): string };
  runtimeGenerations?: { next(): string };
}

function findLastMatching<T, S extends T>(
  values: readonly T[],
  predicate: (value: T) => value is S,
): S | undefined;
function findLastMatching<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): T | undefined;
function findLastMatching<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return value;
  }
  return undefined;
}

export class DefaultNodeManagedSessionRunner
  implements NodeManagedSessionRunner
{
  private readonly sandboxRuntimes = new ScopedSessionMap<SessionSandboxRuntime>();
  private readonly sandboxes = new ScopedSessionMap<SandboxExecutor>();
  private readonly runtimeGenerations = new ScopedSessionMap<string>();
  private readonly sandboxConfigurationFingerprints = new ScopedSessionMap<string>();
  private readonly abortControllers = new ScopedSessionMap<AbortController>();
  private readonly subagentExecutions = new ScopedSessionMap<ManagedNodeSubagents>();
  private readonly workspaces = new ScopedSessionMap<ManagedWorkspaceState>();

  constructor(
    private readonly dependencies: DefaultNodeManagedSessionRunnerDependencies,
  ) {}

  /** `lease_lost` means another owner will reclaim and re-run this execution:
   * the stale attempt must not tell the client its turn failed. */
  cancel(input: { workspaceId: string; sessionId: string; reason?: string }): void {
    this.abortControllers.get(input)?.abort(input.reason ?? "cancelled");
  }

  /** Returns only a prepared live runtime, scoped exactly like execution. */
  connectedSandbox(input: { workspaceId: string; sessionId: string }): SandboxExecutor | null {
    return this.sandboxes.get(input) ?? null;
  }

  async start(input: StartNodeManagedSessionRuntime): Promise<void> {
    const startup = new AbortController();
    const unlinkParent = linkAbort(input.signal, startup);
    const signal = startup.signal;
    let registered = false;
    try {
      if (signal.aborted) throw abortedError(signal);
      const fingerprint = JSON.stringify({
        resources: input.session.resources,
        skills: input.session.agent.skills,
        environment: input.environment.config,
      });
      const existing = this.sandboxes.get(input);
      if (this.dependencies.workspaceCheckpoints !== undefined && input.executionFence === undefined) {
        throw new Error("Managed workspace checkpoint_restore requires a Session Execution fence");
      }
      const trusted = this.dependencies.workspaceCheckpoints === undefined || this.workspaces.get(input)?.trusted === true;
      let reusable = existing !== undefined
        && this.sandboxConfigurationFingerprints.get(input) === fingerprint
        && trusted;
      if (reusable && this.dependencies.isSandboxCurrent !== undefined) {
        reusable = await untilAborted(this.dependencies.isSandboxCurrent({
          workspaceId: input.workspaceId, session: input.session, environment: input.environment,
          runtimeGeneration: this.runtimeGenerations.get(input)!,
        }), signal);
      }
      if (reusable) return;
      if (existing !== undefined) {
        const previousWorkspace = this.workspaces.get(input);
        this.workspaces.delete(input);
        if (previousWorkspace !== undefined) {
          await previousWorkspace.port.release({
            scope: previousWorkspace.scope,
            fence: this.dependencies.workspaceCheckpoints!.runtimeFence(previousWorkspace.fence, previousWorkspace.scope.environmentId),
            binding: previousWorkspace.binding,
          });
        }
        this.abortControllers.get(input)?.abort();
        this.abortControllers.delete(input);
        this.sandboxes.delete(input);
        this.sandboxRuntimes.delete(input);
        this.runtimeGenerations.delete(input);
        this.sandboxConfigurationFingerprints.delete(input);
        await untilAborted(existing.destroy?.() ?? Promise.resolve(), signal);
      }
      this.abortControllers.set(input, startup);
      registered = true;
      const runtimeGeneration = this.dependencies.runtimeGenerations?.next()
        ?? `runtime_${randomUUID()}`;
      const context = { workspaceId: input.workspaceId, session: input.session, environment: input.environment };
      const runtime = new SessionSandboxRuntime({
        mode: () => this.dependencies.sandboxMode?.(context) ?? "sandbox",
        create: () => {
          if (signal.aborted) throw abortedError(signal);
          return this.dependencies.buildSandbox({ ...context, signal });
        },
        prepare: (sandbox) => {
          if (signal.aborted) return Promise.reject(abortedError(signal));
          return this.dependencies.prepareSandbox?.({ ...context, sandbox, runtimeGeneration, signal }) ?? Promise.resolve();
        },
      });
      const allocation = runtime.acquire();
      const sandbox = await untilAborted(allocation, signal, async (created) => {
        await created.destroy?.().catch(() => undefined);
      });
      let workspace: ManagedWorkspaceState | undefined;
      try {
        const checkpoints = this.dependencies.workspaceCheckpoints;
        if (checkpoints !== undefined) {
          const fence = input.executionFence!;
          const scope = {
            workspaceId: input.workspaceId,
            environmentId: input.environment.id,
            sessionId: input.sessionId,
            workId: fence.executionId,
          };
          const active = await untilAborted(checkpoints.active(scope), signal);
          const port = checkpoints.port(sandbox);
          const runtimeFence = checkpoints.runtimeFence(fence, scope.environmentId);
          const binding = await untilAborted(port.materialize({
            scope, fence: runtimeFence, strategy: "checkpoint_restore",
            activeCheckpoint: active?.candidate ?? null,
            idempotencyKey: runtimeGeneration,
            signal,
          }), signal);
          workspace = { port, binding, scope, fence, activeId: active?.candidate.id ?? null, trusted: true };
          // A missing/corrupt published archive is a hard failure. Session
          // inputs and the harness must never observe an empty replacement.
          await untilAborted(port.attach({
            scope, fence: runtimeFence, strategy: "checkpoint_restore", binding,
            sandbox: { provider: "node", runtimeId: runtimeGeneration },
            signal,
          }), signal);
        }
        await untilAborted(runtime.prepare(), signal);
      } catch (error) {
        if (workspace !== undefined) {
          await workspace.port.release({
            scope: workspace.scope,
            fence: this.dependencies.workspaceCheckpoints!.runtimeFence(workspace.fence, workspace.scope.environmentId),
            binding: workspace.binding,
          }).catch(() => undefined);
        }
        await sandbox.destroy?.().catch(() => undefined);
        throw error;
      }
      if (workspace !== undefined) this.workspaces.set(input, workspace);
      this.sandboxRuntimes.set(input, runtime);
      this.sandboxes.set(input, sandbox);
      this.runtimeGenerations.set(input, runtimeGeneration);
      this.sandboxConfigurationFingerprints.set(input, fingerprint);
    } finally {
      unlinkParent();
      if (registered && this.abortControllers.get(input) === startup) {
        this.abortControllers.delete(input);
      }
    }
  }

  async stop(input: StopNodeManagedSessionRuntime): Promise<void> {
    await this.discardSandbox(input);
  }

  private async discardSandbox(input: { workspaceId: string; sessionId: string }): Promise<void> {
    this.abortControllers.get(input)?.abort();
    this.abortControllers.delete(input);
    const workspace = this.workspaces.get(input);
    this.workspaces.delete(input);
    const sandbox = this.sandboxes.get(input);
    this.sandboxes.delete(input);
    if (workspace !== undefined) {
      // The port only releases binding-local state; the published blob is immutable.
      await workspace.port.release({
        scope: workspace.scope,
        fence: this.dependencies.workspaceCheckpoints!.runtimeFence(workspace.fence, workspace.scope.environmentId),
        binding: workspace.binding,
      });
    }
    this.sandboxRuntimes.delete(input);
    this.runtimeGenerations.delete(input);
    this.sandboxConfigurationFingerprints.delete(input);
    await sandbox?.destroy?.();
  }

  async accept(input: NodeManagedSessionRunnerAcceptInput): Promise<void> {
    if (input.events.some((event) => event.type === "user.interrupt")) {
      this.abortControllers.get(input)?.abort();
      return;
    }
    const event = findLastMatching(
      input.events,
      (candidate) => candidate.type !== "system.message",
    );
    if (event === undefined) {
      throw new Error("Managed Node runner received no actionable event");
    }
    if (
      event.type !== "user.message" &&
      event.type !== "user.custom_tool_result" &&
      event.type !== "user.tool_result" &&
      event.type !== "user.tool_confirmation" &&
      event.type !== "user.define_outcome"
    ) {
      throw new Error(
        `Managed Node runner does not yet support ${event.type}`,
      );
    }
    const rawSandbox = this.sandboxes.get(input);
    if (rawSandbox === undefined) {
      throw new Error(`Session ${input.sessionId} sandbox was not started`);
    }
    const runtimeGeneration = this.runtimeGenerations.get(input);
    if (runtimeGeneration === undefined) {
      throw new Error(`Session ${input.sessionId} runtime generation was not started`);
    }
    const checkpointService = this.dependencies.workspaceCheckpoints;
    const workspace = this.workspaces.get(input);
    if (checkpointService !== undefined) {
      if (input.executionFence === undefined || workspace === undefined) {
        throw new Error("Managed workspace checkpoint_restore requires a prepared fenced sandbox");
      }
      const current = await checkpointService.active(workspace.scope);
      if (current?.candidate.id !== (workspace.activeId ?? undefined)) {
        // Another replica published since this sandbox was prepared. Never
        // execute against a stale workspace; a new sandbox must cold-restore.
        await this.discardSandbox(input);
        throw new Error("Managed workspace checkpoint changed; reacquire the sandbox");
      }
    }
    // Until the turn, Memory/output sync and due checkpoints all settle,
    // a replacement attempt must cold-restore rather than reuse dirty bytes.
    if (workspace !== undefined) workspace.trusted = false;
    const abortController = new AbortController();
    this.abortControllers.set(input, abortController);
    // The Node execution worker owns the durable fence and cancels this
    // controller when renewal fails. The guard keeps provider calls from a
    // stale runner from continuing after that cancellation; canonical frame
    // writes are fenced separately by DefaultNodeManagedSessionRuntimeDriver.
    const sandbox = input.executionFence === undefined
      ? rawSandbox
      : withSandboxExecutionGuard(rawSandbox, {
          signal: abortController.signal,
        });
    const runtime = new ManagedNodeHarnessRuntime({
      initialEvents: input.initialEvents,
      events: input.historyEvents.filter((event) => managedEventThread(event) === "sthr_primary"),
      sandbox,
      abortSignal: abortController.signal,
      output: input.output,
      clock: this.dependencies.clock,
      ids: this.dependencies.ids,
    });
    runtime.broadcastProducedEvent({ type: "session.status_running" });
    let turnTools: HarnessContext["tools"] | undefined;
    let runFailed = false;
    try {
      if (event.type === "user.tool_confirmation") {
        const toolUse = findLastMatching(
          input.historyEvents,
          (candidate): candidate is ManagedNodeConfirmableToolUse =>
            (candidate.type === "agent.tool_use" ||
              candidate.type === "agent.mcp_tool_use") &&
            candidate.id === event.toolUseId,
        );
        if (toolUse === undefined) {
          throw new Error(
            `Tool use ${event.toolUseId} was not found in session history`,
          );
        }
        const result = event.result === "deny"
          ? {
              content: [{
                type: "text" as const,
                text: `Denied: ${event.denyMessage ?? "Tool execution was denied by the user."}`,
              }],
              isError: true,
            }
          : await this.dependencies.confirmedTools.execute({
              workspaceId: input.workspaceId,
              session: input.session,
              environment: input.environment,
              sandbox,
              confirmation: event,
              toolUse,
              abortSignal: abortController.signal,
            });
        runtime.broadcastProducedEvent(
          toolUse.type === "agent.mcp_tool_use"
            ? {
                type: "agent.mcp_tool_result",
                mcpToolUseId: toolUse.id,
                ...result,
              }
            : {
                type: "agent.tool_result",
                toolUseId: toolUse.id,
                ...result,
              },
        );
      }
      const context = {
        workspaceId: input.workspaceId,
        session: input.session,
        environment: input.environment,
      };
      const policy = await this.dependencies.subagentPolicy?.(context);
      let subagentContext: ManagedRunnerSubagentContext = {};
      if (policy?.enabled && this.dependencies.subagentThreads !== undefined) {
        const subagents = new ManagedNodeSubagents({
          ...context,
          parentThreadId: "sthr_primary",
          sandbox,
          abortSignal: abortController.signal,
          executionFence: input.executionFence,
          historyEvents: input.historyEvents,
          threads: this.dependencies.subagentThreads,
          policy,
          resolveSession: this.dependencies.resolveSubagentSession === undefined ? undefined :
            (request) => this.dependencies.resolveSubagentSession!({ ...context, request }),
          run: async ({ session, runtime: childRuntime, sandbox: childSandbox }) => {
            const childContext = { ...context, session };
            let childTools: HarnessContext["tools"] | undefined;
            try {
              const model = await this.dependencies.buildModel(childContext);
              childTools = await this.dependencies.buildTools({ ...childContext, sandbox: childSandbox });
              const harnessContext = await this.dependencies.buildHarnessContext({
                ...childContext, acceptedEvents: [], sandbox: childSandbox,
                runtime: childRuntime, model, tools: childTools,
              });
              await this.dependencies.buildHarness().run(harnessContext);
            } finally {
              if (childTools !== undefined) await this.dependencies.disposeTools?.(childTools);
            }
          },
          output: input.output,
          clock: this.dependencies.clock,
          ids: this.dependencies.ids,
        });
        this.subagentExecutions.set(input, subagents);
        subagentContext = {
          subagents,
          delegateToAgent: async (agentId, message) => {
            const child = await subagents.create({ agentId, message });
            const result = (await subagents.wait({ threadIds: [child.threadId] })).subagents[0]!;
            if (result.status === "failed") throw new Error(`Subagent ${child.threadId} failed`);
            return result.output ?? "(sub-agent produced no text output)";
          },
        };
      }
      const toolsPromise = this.dependencies
        .buildTools({ ...context, ...subagentContext, sandbox })
        .then((tools) => {
          turnTools = tools;
          return tools;
        });
      const [model, tools] = await Promise.all([
        this.dependencies.buildModel(context),
        toolsPromise,
      ]);
      const runHarness = async (): Promise<void> => {
        const harnessContext = await this.dependencies.buildHarnessContext({
          ...context,
          ...subagentContext,
          acceptedEvents: input.events,
          sandbox,
          runtime,
          model,
          tools,
        });
        const retry = this.dependencies.harnessRetry ??
          { attempts: 3, delayMs: (attempt: number) => Math.min(30_000, 2_000 * 2 ** (attempt - 1)) };
        for (let attempt = 1; ; attempt += 1) {
          const agentEventsBefore = runtime.agentEventCount;
          try {
            await this.dependencies.buildHarness().run(harnessContext);
            return;
          } catch (error) {
            const sideEffectFree = runtime.agentEventCount === agentEventsBefore;
            if (
              !sideEffectFree
              || attempt >= retry.attempts
              || abortController.signal.aborted
              || error instanceof ConfigError
            ) {
              throw error;
            }
            runtime.broadcastProducedEvent({
              type: "session.error",
              error: {
                type: "unknown_error",
                message: error instanceof Error ? error.message : String(error),
                retryStatus: "retrying",
              },
            });
            runtime.broadcastProducedEvent({ type: "session.status_rescheduled" });
            await abortableDelay(retry.delayMs(attempt), abortController.signal);
            if (abortController.signal.aborted) throw error;
          }
        }
      };
      await runHarness();
      if (event.type === "user.define_outcome") {
        const maxIterations = Math.min(
          20,
          Math.max(1, event.maxIterations ?? 3),
        );
        for (let iteration = 0; iteration < maxIterations; iteration += 1) {
          const evaluationHistory = runtime.getApplicationHistoryEvents();
          const startId = runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_start",
            outcomeId: event.outcomeId,
            iteration,
          });
          runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_ongoing",
            outcomeId: event.outcomeId,
            iteration,
          });
          let evaluation: ManagedNodeOutcomeEvaluationResult;
          try {
            evaluation = await this.dependencies.outcomes.evaluate({
              workspaceId: input.workspaceId,
              session: input.session,
              environment: input.environment,
              outcome: event,
              historyEvents: evaluationHistory,
              iteration,
              abortSignal: abortController.signal,
            });
          } catch (error) {
            const interrupted = abortController.signal.aborted ||
              (error instanceof Error && error.name === "AbortError");
            evaluation = {
              result: "failed",
              explanation: interrupted
                ? "outcome evaluation interrupted by user"
                : `outcome evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
              usage: {
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
              },
            };
            runtime.broadcastProducedEvent({
              type: "span.outcome_evaluation_end",
              outcomeId: event.outcomeId,
              outcomeEvaluationStartId: startId,
              iteration,
              result: interrupted ? "interrupted" : "failed",
              explanation: evaluation.explanation,
              usage: evaluation.usage,
            });
            break;
          }
          const needsRevision = evaluation.result === "needs_revision";
          const result = needsRevision && iteration === maxIterations - 1
            ? "max_iterations_reached"
            : evaluation.result;
          runtime.broadcastProducedEvent({
            type: "span.outcome_evaluation_end",
            outcomeId: event.outcomeId,
            outcomeEvaluationStartId: startId,
            iteration,
            result,
            explanation: evaluation.explanation,
            usage: evaluation.usage,
          });
          if (!needsRevision || result === "max_iterations_reached") break;
          runtime.appendOutcomeFeedback(iteration, evaluation.explanation);
          await runHarness();
        }
      }
    } catch (error) {
      runFailed = true;
      if (abortController.signal.reason === "lease_lost") throw error;
      runtime.broadcastProducedEvent({
        type: "session.error",
        error: {
          type: "unknown_error",
          message: error instanceof Error ? error.message : String(error),
          // The turn may have produced side effects (tool calls), so it is not
          // retried automatically: CMA semantics for a dead turn are `exhausted`.
          retryStatus: "exhausted",
        },
      });
      throw error;
    } finally {
      let finalizationError: Error | undefined;
      const subagents = this.subagentExecutions.get(input);
      try {
        if (runFailed) abortController.abort();
        await subagents?.drain();
      } catch (error) {
        finalizationError = error instanceof Error ? error : new Error(String(error));
      } finally {
        if (this.subagentExecutions.get(input) === subagents) this.subagentExecutions.delete(input);
      }
      try {
        if (turnTools !== undefined) {
          await this.dependencies.disposeTools?.(turnTools);
        }
      } catch (error) {
        finalizationError = error instanceof Error ? error : new Error(String(error));
      }
      try {
        if (
          input.executionFence !== undefined &&
          this.dependencies.synchronizeSandbox !== undefined
        ) {
          const executionFence = input.executionFence;
          await this.sandboxRuntimes.get(input)?.withSandbox(async () => {
            await this.dependencies.synchronizeSandbox!({
              workspaceId: input.workspaceId,
              session: input.session,
              environment: input.environment,
              sandbox: rawSandbox,
              runtimeGeneration,
              executionFence,
            });
          });
        }
      } catch (error) {
        finalizationError ??= error instanceof Error ? error : new Error(String(error));
      }
      // Turn completion is a safe point: all harness/subagent activity has
      // drained. The interval is a target between such points, not a timer
      // that snapshots files while tools are still writing.
      if (!runFailed && finalizationError === undefined && checkpointService !== undefined && workspace !== undefined && input.executionFence !== undefined) {
        try {
          const active = await checkpointService.active(workspace.scope);
          if (active?.candidate.id !== (workspace.activeId ?? undefined)) {
            throw new Error("Managed workspace checkpoint changed during execution");
          }
          if (checkpointService.due(active)) {
            const fence = input.executionFence;
            const candidate = await workspace.port.checkpoint({
              scope: { ...workspace.scope, workId: fence.executionId },
              fence: checkpointService.runtimeFence(fence, workspace.scope.environmentId),
              strategy: "checkpoint_restore", binding: workspace.binding,
              sandbox: { provider: "node", runtimeId: runtimeGeneration },
              idempotencyKey: `${fence.executionId}-${fence.attemptId}`,
              signal: abortController.signal,
            });
            if (!await checkpointService.publish({ fence, candidate, expectedId: workspace.activeId })) {
              throw new Error("Managed workspace checkpoint lost its Session Execution fence or canonical pointer");
            }
            workspace.activeId = candidate.id;
          }
        } catch (error) {
          finalizationError = error instanceof Error ? error : new Error(String(error));
        }
      }
      const leaseLost = abortController.signal.reason === "lease_lost";
      if (finalizationError !== undefined && !runFailed && !leaseLost) {
        runtime.broadcastProducedEvent({
          type: "session.error",
          error: {
            type: "unknown_error",
            message: finalizationError instanceof Error
              ? finalizationError.message
              : String(finalizationError),
            retryStatus: "exhausted",
          },
        });
      }
      if (!leaseLost) {
        runtime.broadcastProducedEvent({
          type: "session.status_idle",
          stopReason: { type: runFailed || finalizationError !== undefined ? "retries_exhausted" : "end_turn" },
        });
      }
      try {
        await runtime.drain();
        if (input.executionFence !== undefined) {
          await this.dependencies.afterExecution?.({
            workspaceId: input.workspaceId,
            session: input.session,
            environment: input.environment,
            sandbox: rawSandbox,
            runtimeGeneration,
            executionFence: input.executionFence,
          });
        }
      } finally {
        if (this.abortControllers.get(input) === abortController) {
          this.abortControllers.delete(input);
        }
      }
      if (finalizationError !== undefined && !runFailed) {
        throw finalizationError;
      }
      if (workspace !== undefined && !runFailed && !abortController.signal.aborted) {
        workspace.trusted = true;
      }
    }
  }

  async archiveThread(
    input: ArchiveNodeManagedSessionThread,
  ): Promise<void> {
    await this.subagentExecutions.get(input)?.archiveThread(input.threadId);
  }
}

