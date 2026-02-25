import { runAgentDbSql } from './agent-db';

type AgentDbChangeOperation = 'insert' | 'update' | 'delete';

interface AgentDbChangeRow {
  seq: number;
  table_name: string;
  row_id: number;
  op: AgentDbChangeOperation;
  changed_at: number;
}

export interface AgentDbChange {
  seq: number;
  table: string;
  rowId: number;
  op: AgentDbChangeOperation;
  changedAt: number;
}

export interface AgentDbChangedEvent {
  cursor: number;
  changes: AgentDbChange[];
}

interface AgentDbChangesPublisherOptions {
  getDataDir: () => string;
  onChanges: (event: AgentDbChangedEvent) => void;
  onError?: (error: unknown) => void;
  pollIntervalMs?: number;
  batchSize?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_BATCH_SIZE = 100;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid db_changes row: expected object');
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Invalid db_changes row: "${fieldName}" must be a number`);
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid db_changes row: "${fieldName}" must be a string`);
}

function asOperation(value: unknown): AgentDbChangeOperation {
  if (value === 'insert' || value === 'update' || value === 'delete') {
    return value;
  }
  throw new Error('Invalid db_changes row: "op" must be insert/update/delete');
}

function toChangeRow(value: unknown): AgentDbChangeRow {
  const row = asObject(value);
  return {
    seq: asNumber(row.seq, 'seq'),
    table_name: asString(row.table_name, 'table_name'),
    row_id: asNumber(row.row_id, 'row_id'),
    op: asOperation(row.op),
    changed_at: asNumber(row.changed_at, 'changed_at'),
  };
}

function toEventChange(row: AgentDbChangeRow): AgentDbChange {
  return {
    seq: row.seq,
    table: row.table_name,
    rowId: row.row_id,
    op: row.op,
    changedAt: row.changed_at,
  };
}

export class AgentDbChangesPublisher {
  private readonly getDataDir: () => string;
  private readonly onChanges: (event: AgentDbChangedEvent) => void;
  private readonly onError: (error: unknown) => void;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;

  private cursor = 0;
  private isStarted = false;
  private isPolling = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(options: AgentDbChangesPublisherOptions) {
    this.getDataDir = options.getDataDir;
    this.onChanges = options.onChanges;
    this.onError = options.onError ?? ((error) => console.error('[agent-db-changes] poll failed', error));
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;

    try {
      this.cursor = await this.readMaxCursor();
    } catch (error) {
      this.onError(error);
      this.cursor = 0;
    }

    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.isStarted = false;
    this.isPolling = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async readMaxCursor(): Promise<number> {
    const rows = await runAgentDbSql(this.getDataDir(), {
      sql: 'SELECT COALESCE(MAX(seq), 0) AS seq FROM db_changes',
    });

    if (!rows.length) {
      return 0;
    }

    const row = asObject(rows[0]);
    return asNumber(row.seq, 'seq');
  }

  private async pollOnce(): Promise<void> {
    if (!this.isStarted || this.isPolling) {
      return;
    }

    this.isPolling = true;

    try {
      while (this.isStarted) {
        const rows = await runAgentDbSql(this.getDataDir(), {
          sql: 'SELECT seq, table_name, row_id, op, changed_at FROM db_changes WHERE seq > ? ORDER BY seq ASC LIMIT ?',
          params: [this.cursor, this.batchSize],
        });

        if (!rows.length) {
          return;
        }

        const parsedRows = rows.map((row) => toChangeRow(row));
        const changes = parsedRows.map((row) => toEventChange(row));
        this.cursor = parsedRows[parsedRows.length - 1].seq;
        this.onChanges({ cursor: this.cursor, changes });

        if (rows.length < this.batchSize) {
          return;
        }
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.isPolling = false;
    }
  }
}
