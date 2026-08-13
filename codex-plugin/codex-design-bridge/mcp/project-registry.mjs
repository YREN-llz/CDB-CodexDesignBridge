import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_VERSION = 1;
const MAX_PROJECTS = 100;

export class ProjectRegistry {
  constructor({ filePath, now = () => new Date() } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("CDB project registry requires an explicit file path.");
    }
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.writeQueue = Promise.resolve();
  }

  async list() {
    await this.writeQueue;
    const registry = await this.readRegistry();
    return registry.projects.map((project) => ({ ...project }));
  }

  async find(projectKey) {
    const normalizedKey = normalizeProjectKey(projectKey);
    if (!normalizedKey) return null;
    const projects = await this.list();
    return projects.find((project) => project.projectKey === normalizedKey) || null;
  }

  async upsert(project) {
    const normalized = normalizeProject(project, this.now().toISOString());
    if (!normalized) {
      throw new Error("CDB project registry received an invalid project record.");
    }
    return this.enqueueWrite(async () => {
      const registry = await this.readRegistry();
      const comparablePath = normalizeComparablePath(normalized.projectDir);
      const projects = registry.projects.filter((candidate) =>
        candidate.projectKey !== normalized.projectKey &&
        normalizeComparablePath(candidate.projectDir) !== comparablePath
      );
      projects.unshift(normalized);
      const next = {
        version: REGISTRY_VERSION,
        updatedAt: normalized.lastOpenedAt,
        projects: sortProjects(projects).slice(0, MAX_PROJECTS),
      };
      await this.writeRegistry(next);
      return { ...normalized };
    });
  }

  async forget(projectKey) {
    const normalizedKey = normalizeProjectKey(projectKey);
    if (!normalizedKey) return false;
    return this.enqueueWrite(async () => {
      const registry = await this.readRegistry();
      const projects = registry.projects.filter(
        (project) => project.projectKey !== normalizedKey,
      );
      if (projects.length === registry.projects.length) return false;
      await this.writeRegistry({
        version: REGISTRY_VERSION,
        updatedAt: this.now().toISOString(),
        projects,
      });
      return true;
    });
  }

  enqueueWrite(operation) {
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async readRegistry() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      const projects = Array.isArray(parsed?.projects)
        ? parsed.projects
            .map((project) => normalizeProject(project))
            .filter(Boolean)
        : [];
      const unique = [];
      const keys = new Set();
      const paths = new Set();
      for (const project of sortProjects(projects)) {
        const comparablePath = normalizeComparablePath(project.projectDir);
        if (keys.has(project.projectKey) || paths.has(comparablePath)) continue;
        keys.add(project.projectKey);
        paths.add(comparablePath);
        unique.push(project);
      }
      return {
        version: REGISTRY_VERSION,
        updatedAt: normalizeTimestamp(parsed?.updatedAt),
        projects: unique.slice(0, MAX_PROJECTS),
      };
    } catch {
      return { version: REGISTRY_VERSION, updatedAt: "", projects: [] };
    }
  }

  async writeRegistry(registry) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(registry, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}

function normalizeProject(value, fallbackOpenedAt = "") {
  if (!value || typeof value !== "object") return null;
  const projectKey = normalizeProjectKey(value.projectKey);
  const projectDir = normalizeProjectDir(value.projectDir);
  if (!projectKey || !projectDir) return null;
  return {
    projectKey,
    projectId: cleanText(value.projectId, 80),
    name: cleanText(value.name, 80) || path.basename(projectDir),
    projectDir,
    sourceKind: cleanText(value.sourceKind, 60),
    lastOpenedAt:
      normalizeTimestamp(value.lastOpenedAt) ||
      normalizeTimestamp(fallbackOpenedAt) ||
      new Date(0).toISOString(),
  };
}

function normalizeProjectKey(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{7,127}$/.test(candidate) ? candidate : "";
}

function normalizeProjectDir(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return path.resolve(value.trim());
}

function normalizeComparablePath(value) {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function cleanText(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function normalizeTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function sortProjects(projects) {
  return [...projects].sort(
    (left, right) =>
      Date.parse(right.lastOpenedAt || 0) - Date.parse(left.lastOpenedAt || 0),
  );
}
