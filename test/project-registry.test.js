import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../codex-plugin/codex-design-bridge/mcp/project-registry.mjs";

test("persists, deduplicates, and forgets project records without touching projects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cdb-project-registry-"));
  const registryDir = path.join(root, "registry");
  const registryPath = path.join(registryDir, "projects.json");
  const projectDir = path.join(root, "project-a");
  await mkdir(projectDir);
  t.after(async () => {
    await unlink(registryPath).catch(() => {});
    await rmdir(registryDir).catch(() => {});
    await rmdir(projectDir).catch(() => {});
    await rmdir(root).catch(() => {});
  });
  let now = new Date("2026-08-13T10:00:00.000Z");
  const registry = new ProjectRegistry({
    filePath: registryPath,
    now: () => now,
  });

  await registry.upsert({
    projectKey: "project-key-a",
    projectId: "project-a",
    name: "First name",
    projectDir,
    sourceKind: "native",
  });
  now = new Date("2026-08-13T11:00:00.000Z");
  await registry.upsert({
    projectKey: "project-key-a",
    projectId: "project-a",
    name: "Renamed project",
    projectDir,
    sourceKind: "native",
  });

  const reopened = new ProjectRegistry({ filePath: registryPath });
  assert.deepEqual(await reopened.list(), [{
    projectKey: "project-key-a",
    projectId: "project-a",
    name: "Renamed project",
    projectDir: path.resolve(projectDir),
    sourceKind: "native",
    lastOpenedAt: "2026-08-13T11:00:00.000Z",
  }]);
  assert.equal(await reopened.forget("project-key-a"), true);
  assert.deepEqual(await reopened.list(), []);
  assert.ok(await readFile(registryPath, "utf8"));
  await mkdir(path.join(projectDir, "still-here"));
  await rmdir(path.join(projectDir, "still-here"));
});
