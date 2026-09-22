import {
  isAdvancedFamily,
  withDefaultMetadata,
  type RegisteredToolMetadata,
  type ToolDescriptor,
  type ToolFamilyId,
  type ToolMetadata,
  type ToolPhase,
} from './types.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DuplicateToolError extends Error {
  override name = 'DuplicateToolError';
  constructor(toolName: string) {
    super(`Tool "${toolName}" is already registered`);
  }
}

export class UnknownToolError extends Error {
  override name = 'UnknownToolError';
  constructor(toolName: string) {
    super(`Unknown tool requested: "${toolName}"`);
  }
}

export class DuplicateLogicalIdError extends Error {
  override name = 'DuplicateLogicalIdError';
  constructor(family: ToolFamilyId, logicalId: string) {
    super(`Logical id "${logicalId}" is already registered in family "${family}"`);
  }
}

export class UnknownLogicalIdError extends Error {
  override name = 'UnknownLogicalIdError';
  constructor(logicalId: string) {
    super(`Unknown tool logical id requested: "${logicalId}"`);
  }
}

export class InvalidExposureError extends Error {
  override name = 'InvalidExposureError';
  constructor(family: ToolFamilyId, exposure: string) {
    super(
      family === 'core'
        ? `Core tools must have exposure "always"; got "${exposure}"`
        : `Advanced-family tools must have exposure "opt-in"; got "${exposure}" for family "${family}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface ToolRegistryRequest {
  /** Filter by phase. If omitted, all phases are included. */
  phase?: ToolPhase;
  /**
   * Filter to a specific set of names.
   * - Empty array returns [].
   * - Unknown names throw UnknownToolError before returning anything.
   * - Known names that do not match the phase filter are silently excluded.
   * - Results are always returned in registration order, not request order.
   */
  names?: readonly string[];
  /** Restrict to a single family (e.g. `browser`). */
  family?: ToolFamilyId;
  /**
   * Filter to a specific set of logical ids (family-scoped identifiers).
   * - Empty array returns [].
   * - Unknown logical ids throw UnknownLogicalIdError before returning anything.
   */
  logicalIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  /**
   * Register a tool descriptor.
   * Throws DuplicateToolError if a tool with the same name is already registered.
   * State is unchanged on error.
   */
  register(descriptor: ToolDescriptor): void;

  /**
   * Return full descriptors matching the request.
   * Order is deterministic: registration order, not request order.
   */
  getTools(request?: ToolRegistryRequest): ToolDescriptor[];

  /**
   * Return metadata-only entries (no executor) matching the request.
   * Same deterministic order as getTools.
   */
  list(request?: ToolRegistryRequest): RegisteredToolMetadata[];

  /** True if a tool with this exact name is registered. */
  has(name: string): boolean;

  /** True if a logical id has been registered. */
  hasLogicalId(logicalId: string): boolean;

  /** Distinct families in deterministic registration order. */
  getFamilies(): readonly ToolFamilyId[];

  /**
   * Convenience: descriptors filtered to a single family, honoring any other
   * fields in `request`.
   */
  getByFamily(family: ToolFamilyId, request?: ToolRegistryRequest): ToolDescriptor[];
}

interface RegistryEntry {
  descriptor: ToolDescriptor;
  metadata: RegisteredToolMetadata;
}

class ToolRegistryImpl implements ToolRegistry {
  private readonly _entries = new Map<string, RegistryEntry>();
  private readonly _order: string[] = [];
  private readonly _logicalIds = new Map<string, string>();
  private readonly _familyOrder: ToolFamilyId[] = [];
  private readonly _familySeen = new Set<ToolFamilyId>();

  register(descriptor: ToolDescriptor): void {
    const { name } = descriptor.metadata;
    if (this._entries.has(name)) {
      throw new DuplicateToolError(name);
    }

    const inflated = withDefaultMetadata(descriptor.metadata);
    this._validateExposure(inflated);

    if (this._logicalIds.has(inflated.logicalId)) {
      throw new DuplicateLogicalIdError(inflated.family, inflated.logicalId);
    }

    const inflatedDescriptor: ToolDescriptor = {
      ...descriptor,
      metadata: inflated,
    };

    this._entries.set(name, { descriptor: inflatedDescriptor, metadata: inflated });
    this._order.push(name);
    this._logicalIds.set(inflated.logicalId, name);
    if (!this._familySeen.has(inflated.family)) {
      this._familySeen.add(inflated.family);
      this._familyOrder.push(inflated.family);
    }
  }

  getTools(request: ToolRegistryRequest = {}): ToolDescriptor[] {
    return this._filter(request).map((name) => this._entries.get(name)!.descriptor);
  }

  list(request: ToolRegistryRequest = {}): RegisteredToolMetadata[] {
    return this._filter(request).map((name) => cloneMetadata(this._entries.get(name)!.metadata));
  }

  has(name: string): boolean {
    return this._entries.has(name);
  }

  hasLogicalId(logicalId: string): boolean {
    return this._logicalIds.has(logicalId);
  }

  getFamilies(): readonly ToolFamilyId[] {
    return [...this._familyOrder];
  }

  getByFamily(family: ToolFamilyId, request: ToolRegistryRequest = {}): ToolDescriptor[] {
    return this.getTools({ ...request, family });
  }

  private _validateExposure(metadata: RegisteredToolMetadata): void {
    const advanced = isAdvancedFamily(metadata.family);
    if (metadata.family === 'core' && metadata.exposure !== 'always') {
      throw new InvalidExposureError(metadata.family, metadata.exposure);
    }
    if (advanced && metadata.exposure !== 'opt-in') {
      throw new InvalidExposureError(metadata.family, metadata.exposure);
    }
  }

  private _validateNames(names: readonly string[] | undefined): void {
    if (names === undefined) return;
    for (const name of names) {
      if (!this._entries.has(name)) {
        throw new UnknownToolError(name);
      }
    }
  }

  private _validateLogicalIds(logicalIds: readonly string[] | undefined): void {
    if (logicalIds === undefined) return;
    for (const logicalId of logicalIds) {
      if (!this._logicalIds.has(logicalId)) {
        throw new UnknownLogicalIdError(logicalId);
      }
    }
  }

  private _filter(request: ToolRegistryRequest): string[] {
    const { phase, names, family, logicalIds } = request;

    // Validate before short-circuiting on empty filters so the caller gets a
    // stable "unknown identifier" error regardless of query composition.
    this._validateNames(names);
    this._validateLogicalIds(logicalIds);

    if (names !== undefined && names.length === 0) return [];
    if (logicalIds !== undefined && logicalIds.length === 0) return [];

    const nameSet = names !== undefined ? new Set(names) : undefined;
    const logicalIdNames =
      logicalIds !== undefined
        ? new Set(logicalIds.map((id) => this._logicalIds.get(id)!).filter((n): n is string => Boolean(n)))
        : undefined;

    return this._order.filter((name) => {
      if (nameSet !== undefined && !nameSet.has(name)) return false;
      if (logicalIdNames !== undefined && !logicalIdNames.has(name)) return false;

      const entry = this._entries.get(name)!;
      if (family !== undefined && entry.metadata.family !== family) return false;
      if (phase !== undefined && !entry.metadata.allowedPhases.includes(phase)) return false;
      return true;
    });
  }
}

function cloneMetadata(metadata: RegisteredToolMetadata): RegisteredToolMetadata {
  return {
    ...metadata,
    allowedPhases: [...metadata.allowedPhases],
    outputCapPolicy: { ...metadata.outputCapPolicy },
    policy: { ...metadata.policy },
  };
}

export function createToolRegistry(initialTools?: readonly ToolDescriptor[]): ToolRegistry {
  const registry = new ToolRegistryImpl();
  if (initialTools) {
    for (const tool of initialTools) {
      registry.register(tool);
    }
  }
  return registry;
}

/**
 * Public helper: expose `withDefaultMetadata` under a name callers already
 * discovered when tracing test failures. Kept as a stable re-export so future
 * consumers do not reach into `./types.ts`.
 */
export function inflateToolMetadata(metadata: ToolMetadata): RegisteredToolMetadata {
  return withDefaultMetadata(metadata);
}
