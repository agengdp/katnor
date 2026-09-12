import { subscribeToEvents, type KatnorEvent } from '$lib/eventsSocket';

/**
 * PLAN.md 4.8's agent sprite states, computed purely from the live event
 * stream (never polled) - shared by the Office page's canvas renderer and
 * the Team page's accessibility fallback (PLAN.md 4.8: "the Team page
 * shows the same live status list"), so "what is Ravi doing right now"
 * means the same thing in both places because it's the same store.
 */
export type LiveAgentState = 'idle' | 'working' | 'talking' | 'waiting_human' | 'blocked' | 'offline';

export interface LiveAgentStatus {
  state: LiveAgentState;
  /** A short human-readable detail - a tool name while working, a message snippet while talking. */
  detail: string | null;
  taskId: string | null;
  runId: string | null;
  updatedAt: number;
}

const DEFAULT_STATUS: LiveAgentStatus = { state: 'idle', detail: null, taskId: null, runId: null, updatedAt: 0 };

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

/**
 * One shared instance (exported below) rather than one per component: the
 * underlying event subscription is ref-counted here so mounting both the
 * Office and Team pages at once (or navigating between them) doesn't
 * double-subscribe or drop events between an unmount and the next mount.
 */
class LiveStatusStore {
  statuses = $state<Record<string, LiveAgentStatus>>({});
  private unsubscribe: (() => void) | null = null;
  private refCount = 0;

  /** Always returns a status - agents never seen in an event yet (or never seeded) read as `idle`. */
  get(agentId: string): LiveAgentStatus {
    return this.statuses[agentId] ?? DEFAULT_STATUS;
  }

  private set(agentId: string, patch: Partial<Omit<LiveAgentStatus, 'updatedAt'>>): void {
    const existing = this.get(agentId);
    this.statuses = { ...this.statuses, [agentId]: { ...existing, ...patch, updatedAt: Date.now() } };
  }

  /**
   * Seeds an agent's status from its DB row (`agent.status`) the first
   * time this store hears about it - so a paused/fired agent reads
   * correctly even before this browser session has seen a live event
   * about them. A no-op once any event (live or a prior seed) has already
   * set something, since live data always wins over the DB snapshot.
   */
  seedFromAgentStatus(agentId: string, dbStatus: 'active' | 'paused' | 'offline'): void {
    if (agentId in this.statuses) return;
    if (dbStatus !== 'active') {
      this.set(agentId, { state: 'offline', detail: null, taskId: null, runId: null });
    }
  }

  private handle = (event: KatnorEvent): void => {
    const payload = event.payload ?? {};
    switch (event.type) {
      case 'run.started': {
        const agentId = str(payload, 'agent_id');
        if (!agentId) return;
        const trigger = str(payload, 'trigger');
        this.set(agentId, {
          state: trigger === 'mention' || trigger === 'human' ? 'talking' : 'working',
          detail: null,
          taskId: str(payload, 'task_id'),
          runId: str(payload, 'run_id'),
        });
        return;
      }
      case 'run.step_recorded': {
        const agentId = str(payload, 'agent_id');
        if (!agentId) return;
        const kind = str(payload, 'kind');
        const detail = str(payload, 'detail');
        if (kind === 'tool_call') {
          this.set(agentId, { state: 'working', detail });
        } else if (kind === 'message' && detail) {
          this.set(agentId, { state: 'talking', detail });
        }
        return;
      }
      case 'run.finished': {
        const agentId = str(payload, 'agent_id');
        if (!agentId) return;
        const status = str(payload, 'status');
        this.set(agentId, {
          state: status === 'waiting_human' ? 'waiting_human' : 'idle',
          detail: null,
          runId: null,
        });
        return;
      }
      case 'agent.fired': {
        const agentId = str(payload, 'agent_id');
        if (agentId) this.set(agentId, { state: 'offline', detail: null, taskId: null, runId: null });
        return;
      }
      case 'task.updated': {
        // Only "blocked" is worth reflecting here - every other status
        // transition on a task is already implied by the run started/
        // finished around it.
        if (str(payload, 'status') === 'blocked') {
          const assigneeId = str(payload, 'assignee_id');
          if (assigneeId) this.set(assigneeId, { state: 'blocked', detail: null, taskId: str(payload, 'task_id') });
        }
        return;
      }
      default:
        return;
    }
  };

  /** Call once per mounted consumer (in an `$effect`); pair with `stop()` in its cleanup. */
  start(): void {
    this.refCount += 1;
    if (!this.unsubscribe) {
      this.unsubscribe = subscribeToEvents(this.handle);
    }
  }

  stop(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0 && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

export const liveStatusStore = new LiveStatusStore();
