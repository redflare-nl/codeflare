/** Separates workspace knowledge from explicitly reusable agent knowledge. */
import { createHash } from 'crypto';
import * as path from 'path';
import { EvidenceItem } from './evidence';
import { KnowledgeStore, LandscapeInput, LandscapeRecord, SkillInput, SkillRecord, SkillOutcome, knowledgeContext } from './missionKnowledge';

export type KnowledgeScope = 'project' | 'global';
/** What a clear actually removed, per scope; a missing scope was not touched. */
export interface ClearedRecords { states: number; embeddings: number; artifacts: number; legacyFile?: string; }
export interface ClearedKnowledge { project?: ClearedRecords; global?: ClearedRecords; }
export interface ScopedSkillRecord extends SkillRecord { scope: KnowledgeScope; }
export interface ScopedKnowledgeSnapshot {
  schemaVersion: 1;
  landscapes: LandscapeRecord[];
  skills: ScopedSkillRecord[];
}

function normalized(directory: string): string {
  const resolved = path.resolve(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export class ScopedKnowledgeStore {
  private readonly project?: KnowledgeStore;
  private readonly global: KnowledgeStore;
  private readonly workspaceId?: string;
  private readonly legacyFile?: string;
  private migration?: Promise<void>;

  /** Directories must come from ExtensionContext storageUri/globalStorageUri, never a repository fallback. */
  constructor(projectDirectory: string | undefined, globalDirectory: string, legacyProjectRoot?: string) {
    if (projectDirectory) {
      if (normalized(projectDirectory) === normalized(globalDirectory)) {
        throw new Error('Project and global knowledge must use different storage directories');
      }
      this.project = new KnowledgeStore(projectDirectory);
      this.workspaceId = createHash('sha256').update(normalized(projectDirectory)).digest('hex');
      if (legacyProjectRoot) { this.legacyFile = path.join(path.resolve(legacyProjectRoot), '.codeflare', 'knowledge.json'); }
    }
    this.global = new KnowledgeStore(globalDirectory, 'global');
  }

  private async projectStore(): Promise<KnowledgeStore> {
    if (!this.project) { throw new Error('Project knowledge requires an open workspace with workspace storage. Choose global scope only for reusable knowledge.'); }
    if (this.legacyFile && !this.migration) {
      // On failure, every project read/write continues reporting the problem until
      // the legacy data is repaired. It must never be silently shadowed by new data.
      this.migration = this.project.migrateLegacyFile(this.legacyFile).then(() => undefined).catch(error => {
        this.migration = undefined;
        throw error;
      });
    }
    await this.migration;
    return this.project;
  }

  private async store(scope: KnowledgeScope): Promise<KnowledgeStore> {
    if (scope === 'project') { return this.projectStore(); }
    if (scope === 'global') { return this.global; }
    throw new Error('Knowledge scope must be project or global');
  }

  async recordLandscape(missionId: string, data: LandscapeInput): Promise<string> {
    return (await this.projectStore()).recordLandscape(missionId, data);
  }

  async saveSkill(data: SkillInput, scope: KnowledgeScope = 'project'): Promise<string> {
    return `[${scope}] ${await (await this.store(scope)).saveSkill(data, this.workspaceId)}`;
  }

  async getSkill(name: string, scope: KnowledgeScope = 'project'): Promise<ScopedSkillRecord | undefined> {
    const snapshot = await (await this.store(scope)).list();
    const key = name.trim().toLocaleLowerCase('en-US');
    const skill = snapshot.skills.find(entry => entry.name.toLocaleLowerCase('en-US') === key);
    return skill ? { ...skill, scope } : undefined;
  }

  /** Caller must establish actual use of this version; the model cannot supply validation proof. */
  async validateSkill(name: string, missionId: string, evidence: EvidenceItem[], scope: KnowledgeScope = 'project', expectedVersion?: number): Promise<string> {
    return this.recordSkillOutcome(name, missionId, 'success', evidence, scope, expectedVersion);
  }

  async recordSkillOutcome(name: string, missionId: string, outcome: SkillOutcome, evidence: EvidenceItem[], scope: KnowledgeScope = 'project', expectedVersion?: number, control = false): Promise<string> {
    // Machine proof stays auditable globally, while local command text/paths stay
    // in the workspace evidence journal. Preserve all proof qualifiers for checks.
    const scopedEvidence = scope === 'global' && Array.isArray(evidence)
      ? evidence.map(item => item && typeof item === 'object'
        ? { ...item, description: 'Execution supplied by the mission controller.' }
        : item)
      : evidence;
    return `[${scope}] ${await (await this.store(scope)).recordSkillOutcome(name, missionId, outcome, scopedEvidence, expectedVersion, this.workspaceId, control)}`;
  }

  /** Promotion creates a generalized hypothesis, not copied project evidence. */
  async promoteSkill(name: string, generalized: SkillInput): Promise<string> {
    const source = await this.getSkill(name, 'project');
    if (!source || source.status !== 'validated') { throw new Error('Promotion requires a currently validated project skill'); }
    if (!generalized.domains?.length) { throw new Error('A generalized candidate must declare its applicable domains'); }
    if (generalized.summary === source.summary && generalized.whenToUse === source.whenToUse
      && JSON.stringify(generalized.steps) === JSON.stringify(source.steps)) {
      throw new Error('Promotion requires explicitly generalized content rather than copying a project record');
    }
    return `[global] ${await this.global.saveSkill(generalized, this.workspaceId, { operation: 'promoted',
      sources: [{ name: source.name, version: source.version, scope: 'project', ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}) }] })}`;
  }

  async mergeSkills(names: string[], merged: SkillInput, scope: KnowledgeScope = 'project'): Promise<string> {
    return `[${scope}] ${await (await this.store(scope)).mergeSkills(names, merged, this.workspaceId)}`;
  }

  async deleteSkill(name: string, scope: KnowledgeScope = 'project', reason = 'Removed from future recall'): Promise<string> {
    return `[${scope}] ${await (await this.store(scope)).deleteSkill(name, reason)}`;
  }

  async list(): Promise<ScopedKnowledgeSnapshot> {
    const [project, global] = await Promise.all([
      this.project ? this.projectStore().then(store => store.list()) : undefined,
      this.global.list(),
    ]);
    return { schemaVersion: 1, landscapes: project?.landscapes ?? [], skills: [
      ...(project?.skills.map(skill => ({ ...skill, scope: 'project' as const })) ?? []),
      ...global.skills.map(skill => ({ ...skill, scope: 'global' as const })),
    ] };
  }

  async context(query: string): Promise<string> {
    return knowledgeContext(query, (await this.list()).skills);
  }

  /**
   * Erase stored knowledge. 'project' touches only this workspace, 'global' only
   * the reusable agent store, 'all' both. Each scope is reported separately so the
   * caller can say what was actually deleted; clearing the project scope without
   * an open workspace is reported, not silently treated as success.
   */
  async clearScope(scope: KnowledgeScope | 'all'): Promise<ClearedKnowledge> {
    const cleared: ClearedKnowledge = {};
    if (scope === 'project' || scope === 'all') {
      if (!this.project) {
        if (scope === 'project') { throw new Error('Project memory requires an open workspace with workspace storage.'); }
      } else {
        // Deliberately not projectStore(): a legacy migration must not run (and
        // possibly re-import) on the way to deleting everything.
        const removed = await this.project.clear();
        // The legacy path belongs to this scope, not to the store, so archive it
        // here — otherwise the next read re-imports what was just deleted.
        const legacyFile = this.legacyFile ? await KnowledgeStore.archiveLegacyFile(this.legacyFile) : undefined;
        cleared.project = { ...removed, ...(legacyFile ? { legacyFile } : {}) };
        this.migration = undefined;
      }
    }
    if (scope === 'global' || scope === 'all') {
      cleared.global = await this.global.clear();
    }
    return cleared;
  }
}
