import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "../vendor/ws/wrapper.mjs";
import { preparePageManifest } from "../shared/page.mjs";
import { applyFastPageChanges } from "./fast-page-patch.mjs";

const PROTOCOL_VERSION = 14;
const SUPPORTED_PROTOCOL_VERSIONS = new Set([13, PROTOCOL_VERSION]);
const DEFAULT_PORT = 9847;
const OPERATION_TIMEOUT_MS = 20_000;
const PAGE_SEED_TRANSPORT_VERSION = 1;
const PAGE_SEED_SESSION_TIMEOUT_MS = 90_000;
const MAX_PAGE_SEED_NODES = 2000;
const MAX_PAGE_SEED_CHUNKS = 128;
const MAX_PAGE_SEED_CHUNK_NODES = 100;
const MAX_PAGE_SEED_TOTAL_BYTES = 64 * 1024 * 1024;
const TRUSTED_FIGMA_ORIGINS = new Set([
  "https://www.figma.com",
  "https://figma.com",
  "null",
]);

export class LocalFigmaBridge {
  constructor(
    projectDir,
    {
      host = "127.0.0.1",
      port = DEFAULT_PORT,
      onPrepareApply = null,
      onFastApply = null,
      onImportPages = null,
      onResetWorkspace = null,
      onListProjects = null,
      onOpenProject = null,
      onCreateFigmaProject = null,
      runtimeVersion = "",
      projectName = "",
      projectKey = "",
    } = {},
  ) {
    this.projectDir = path.resolve(projectDir);
    this.host = host;
    this.port = port;
    this.onPrepareApply =
      typeof onPrepareApply === "function" ? onPrepareApply : null;
    this.onFastApply =
      typeof onFastApply === "function" ? onFastApply : null;
    this.onImportPages =
      typeof onImportPages === "function" ? onImportPages : null;
    this.onResetWorkspace =
      typeof onResetWorkspace === "function" ? onResetWorkspace : null;
    this.onListProjects =
      typeof onListProjects === "function" ? onListProjects : null;
    this.onOpenProject =
      typeof onOpenProject === "function" ? onOpenProject : null;
    this.onCreateFigmaProject =
      typeof onCreateFigmaProject === "function" ? onCreateFigmaProject : null;
    this.runtimeVersion = String(runtimeVersion || "");
    this.projectName = String(projectName || path.basename(this.projectDir));
    this.projectKey = String(projectKey || "");
    this.httpServer = null;
    this.webSocketServer = null;
    this.clients = new Set();
    this.pages = new Map();
    this.pageSourceHashes = new Map();
    this.pageCatalog = new Map();
    this.pendingImports = new Map();
    this.pendingChangeCapture = null;
    this.pendingPageSeeds = new Map();
    this.token = "";
    this.unsentChanges = false;
    this.lastConnectedAt = "";
    this.lastError = "";
  }

  async start() {
    this.token = randomBytes(24).toString("hex");
    this.httpServer = createServer((request, response) => {
      this.handleHttp(request, response).catch((error) => {
        sendJson(response, 500, {
          error: "bridge_error",
          message: error.message,
        });
      });
    });
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 10 * 1024 * 1024,
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(
        request.url || "/",
        `http://${request.headers.host || "localhost"}`,
      );
      if (
        !isTrustedFigmaOrigin(request.headers.origin) ||
        url.pathname !== "/ws" ||
        url.searchParams.get("token") !== this.token
      ) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    });
    this.webSocketServer.on("connection", (webSocket) =>
      this.handleConnection(webSocket),
    );

    await new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, this.host, resolve);
    });
    const address = this.httpServer.address();
    if (typeof address === "object" && address) {
      this.port = address.port;
    }
    return this.status();
  }

  async stop() {
    this.clearPageSeedSessions();
    for (const client of this.clients) {
      client.webSocket.terminate();
    }
    this.clients.clear();
    if (this.webSocketServer) {
      await new Promise((resolve) => this.webSocketServer.close(resolve));
      this.webSocketServer = null;
    }
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
      this.httpServer = null;
    }
  }

  async endSession() {
    this.broadcast({ type: "session.ended" });
    await new Promise((resolve) => setImmediate(resolve));
    await this.stop();
  }

  status() {
    const figmaPluginVersions = [
      ...new Set(
        this.readyClients()
          .map((client) => client.pluginVersion)
          .filter(Boolean),
      ),
    ];
    return {
      listening: Boolean(this.httpServer?.listening),
      connected: this.readyClients().length > 0,
      pluginClients: this.readyClients().length,
      unsentChanges: this.unsentChanges,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      runtimeVersion: this.runtimeVersion,
      projectName: this.projectName,
      projectKey: this.projectKey,
      figmaPluginVersions,
      wsUrl: `ws://localhost:${this.port}/ws`,
      port: this.port,
      pageStates: this.catalogEntries(),
    };
  }

  setWorkspaceIdentity({ projectName = "", projectKey = "" } = {}) {
    this.projectName = String(projectName || path.basename(this.projectDir));
    this.projectKey = String(projectKey || "");
  }

  setPageCatalog(pages) {
    const previous = this.pageCatalog;
    this.pageCatalog = new Map(
      (Array.isArray(pages) ? pages : []).map((page) => {
        const old = previous.get(page.id) || {};
        const imported = this.pages.get(page.id);
        const sourceChanged =
          imported?.sourceHash && imported.sourceHash !== page.sourceHash;
        return [
          page.id,
          {
            id: page.id,
            name: page.name,
            entry: page.entry || "",
            route: page.route || page.path || "/",
            sourceHash: page.sourceHash || "",
            acceptsFigmaSeed: Boolean(page.acceptsFigmaSeed),
            state: !imported
              ? page.syncState || old.state || "not_imported"
              : sourceChanged
                ? "source_changed"
                : old.state === "figma_changed" || old.state === "conflict"
                  ? old.state
                  : page.syncState || "synced",
            error: page.syncState === "failed" ? old.error || "最近更新失败" : "",
          },
        ];
      }),
    );
    this.broadcastCatalog();
  }

  async pushPage(manifest) {
    const clients = this.readyClients();
    if (clients.length === 0) {
      throw new Error(
        "请先在 Figma 中打开本地 CDB 插件，然后再试一次。",
      );
    }
    const prepared = preparePageManifest({
      json: JSON.stringify(manifest),
      sourcePath: manifest.source?.file || "current-preview",
    });
    this.pages.set(prepared.pageId, prepared);
    const projectSourceHash =
      this.pageCatalog.get(prepared.pageId)?.sourceHash || "";
    this.pageSourceHashes.set(prepared.pageId, projectSourceHash);
    const resultPromise = this.waitForImport(prepared.pageId);
    this.broadcast({ type: "page.upsert", page: prepared });
    const result = await resultPromise;
    if (!result?.ok) {
      this.updateCatalogState(prepared.pageId, "failed", result?.error || "导入失败");
      throw new Error(result?.error || "Figma 没有完成页面导入。");
    }
    try {
      await storePageBaseline(this.projectDir, manifest, projectSourceHash);
    } catch (error) {
      this.lastError = `page_baseline_store_failed:${error instanceof Error ? error.message : String(error)}`;
    }
    this.updateCatalogState(prepared.pageId, "synced");
    return {
      ...result,
      nodeCount: prepared.nodeIds.length,
    };
  }

  async captureChanges() {
    if (this.readyClients().length === 0) {
      throw new Error(
        "请先在 Figma 中打开本地 CDB 插件，然后再试一次。",
      );
    }
    if (this.pendingChangeCapture) {
      throw new Error("Figma 修改正在读取中，请稍候。");
    }
    const requestId = `changes-${Date.now()}`;
    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingChangeCapture = null;
        reject(new Error("读取 Figma 修改超时，请确认本地插件仍然打开。"));
      }, OPERATION_TIMEOUT_MS);
      this.pendingChangeCapture = {
        requestId,
        results: [],
        expectedCount: null,
        resolve: (value) => {
          clearTimeout(timer);
          this.pendingChangeCapture = null;
          resolve(value);
        },
      };
    });
    this.broadcast({ type: "page.changes.request", requestId });
    return resultPromise;
  }

  handleConnection(webSocket) {
    const client = {
      webSocket,
      ready: false,
      pluginVersion: "",
      messageQueue: Promise.resolve(),
    };
    this.clients.add(client);
    webSocket.on("message", (raw) => {
      client.messageQueue = client.messageQueue
        .then(() => this.handleMessage(client, raw))
        .catch((error) => {
          sendSocket(webSocket, {
            type: "bridge.error",
            error: error.message,
          });
        });
    });
    const discardClient = () => {
      this.clients.delete(client);
      this.clearPageSeedSessions(client);
    };
    webSocket.on("close", discardClient);
    webSocket.on("error", discardClient);
  }

  async handleMessage(client, raw) {
    const message = JSON.parse(String(raw));
    if (message.type === "plugin.hello") {
      if (!SUPPORTED_PROTOCOL_VERSIONS.has(message.protocolVersion)) {
        this.lastError = "version_mismatch";
        sendSocket(client.webSocket, {
          type: "bridge.error",
          code: "version_mismatch",
          error: "Figma 插件版本与当前设计工作台不匹配，请更新后重新打开插件。",
        });
        return;
      }
      const pluginVersion = String(message.pluginVersion || "");
      const expectedVersion = formalVersion(this.runtimeVersion);
      if (
        message.protocolVersion === PROTOCOL_VERSION &&
        expectedVersion &&
        pluginVersion !== expectedVersion
      ) {
        this.lastError = "version_mismatch";
        sendSocket(client.webSocket, {
          type: "bridge.error",
          code: "version_mismatch",
          error: `Figma 插件版本 ${pluginVersion || "未知"} 与当前 CDB ${expectedVersion} 不匹配，请更新后重新打开插件。`,
        });
        return;
      }
      client.ready = true;
      client.pluginVersion = pluginVersion || `protocol-${message.protocolVersion}`;
      this.unsentChanges = Boolean(message.unsentChanges);
      for (const pageId of message.changedPageIds || []) {
        this.markCatalogFigmaChanged(pageId);
      }
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = "";
      sendSocket(client.webSocket, {
        type: "plugin.ready",
        protocolVersion: PROTOCOL_VERSION,
        runtimeVersion: this.runtimeVersion,
        figmaPluginVersion: client.pluginVersion,
        assets: 0,
        pages: this.pageCatalog.size,
        projectName: this.projectName,
        projectKey: this.projectKey,
        projectDir: this.projectDir,
        localWorkspace: true,
        pageSeedTransportVersion: PAGE_SEED_TRANSPORT_VERSION,
      });
      for (const page of this.pages.values()) {
        sendSocket(client.webSocket, { type: "page.upsert", page });
      }
      sendSocket(client.webSocket, {
        type: "page.catalog",
        pages: this.catalogEntries(),
      });
      return;
    }
    if (message.type === "page.changes.status") {
      this.unsentChanges = Boolean(message.unsentChanges);
      for (const pageId of message.changedPageIds || []) {
        this.markCatalogFigmaChanged(pageId);
      }
      return;
    }
    if (message.type === "workspace.reset.request") {
      if (!this.onResetWorkspace) {
        sendSocket(client.webSocket, {
          type: "workspace.reset.result",
          ok: false,
          error: "当前工作台不支持从 Figma 重置。",
        });
        return;
      }
      try {
        const restoredPages = await this.onResetWorkspace();
        for (const resolveImport of this.pendingImports.values()) {
          resolveImport({ ok: false, error: "Figma 页面关联已清空。" });
        }
        this.pendingImports.clear();
        this.clearPageSeedSessions();
        this.pendingChangeCapture?.resolve({
          empty: true,
          changeCount: 0,
          snapshotPath: "",
          relativePath: "",
        });
        this.pendingChangeCapture = null;
        await invalidatePageBaselines(this.projectDir);
        this.pages.clear();
        this.pageSourceHashes.clear();
        this.setPageCatalog(restoredPages || []);
        this.unsentChanges = false;
        sendSocket(client.webSocket, {
          type: "workspace.reset.result",
          ok: true,
          pages: this.catalogEntries(),
        });
      } catch (error) {
        sendSocket(client.webSocket, {
          type: "workspace.reset.result",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === "project.catalog.request") {
      try {
        const projects = this.onListProjects
          ? await this.onListProjects()
          : [{
              projectKey: this.projectKey,
              name: this.projectName,
              projectDir: this.projectDir,
              active: true,
              status: "available",
            }];
        sendSocket(client.webSocket, {
          type: "project.catalog",
          projects,
          activeProjectKey: this.projectKey,
        });
      } catch (error) {
        sendSocket(client.webSocket, {
          type: "project.action.result",
          ok: false,
          action: "list",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === "project.open.request") {
      if (!this.onOpenProject) {
        sendSocket(client.webSocket, {
          type: "project.action.result",
          ok: false,
          action: "open",
          error: "当前工作台不支持从 Figma 切换项目。",
        });
        return;
      }
      try {
        const projectKey = String(message.projectKey || "");
        if (!projectKey) throw new Error("没有选择要打开的 CDB 项目。");
        if (projectKey === this.projectKey) {
          sendSocket(client.webSocket, {
            type: "project.action.result",
            ok: true,
            action: "open",
            projectKey,
            reconnecting: false,
          });
          return;
        }
        const projects = this.onListProjects ? await this.onListProjects() : [];
        const selected = projects.find((project) => project.projectKey === projectKey);
        if (!selected || selected.status !== "available") {
          throw new Error("这个项目不可用，请刷新项目列表后重试。");
        }
        const opened = await this.onOpenProject(projectKey);
        sendSocket(client.webSocket, {
          type: "project.action.result",
          ok: true,
          action: "open",
          projectKey,
          projectDir: opened?.projectDir || selected.projectDir || "",
          reconnecting: true,
        });
        opened?.start?.();
      } catch (error) {
        sendSocket(client.webSocket, {
          type: "project.action.result",
          ok: false,
          action: "open",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === "project.create.request") {
      if (!this.onCreateFigmaProject) {
        sendSocket(client.webSocket, {
          type: "project.action.result",
          ok: false,
          action: "create",
          error: "当前工作台不支持从 Figma 新建项目。",
        });
        return;
      }
      try {
        const projectName = String(message.projectName || "Figma Design").trim();
        const created = await this.onCreateFigmaProject({ projectName });
        if (created?.cancelled) {
          sendSocket(client.webSocket, {
            type: "project.action.result",
            ok: true,
            action: "create",
            cancelled: true,
          });
          return;
        }
        sendSocket(client.webSocket, {
          type: "project.action.result",
          ok: true,
          action: "create",
          projectKey: created?.projectKey || "",
          reconnecting: true,
        });
        created?.start?.();
      } catch (error) {
        sendSocket(client.webSocket, {
          type: "project.action.result",
          ok: false,
          action: "create",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === "page.import.request") {
      const requested = [...new Set(message.pageIds || [])].filter((pageId) =>
        this.pageCatalog.has(pageId),
      );
      if (!this.onImportPages || requested.length === 0) {
        sendSocket(client.webSocket, {
          type: "page.import.request.result",
          ok: false,
          error: "没有可导入的 CDB 页面。",
        });
        return;
      }
      Promise.resolve(this.onImportPages(requested))
        .then(() => {
          sendSocket(client.webSocket, {
            type: "page.import.request.result",
            ok: true,
            pageIds: requested,
          });
        })
        .catch((error) => {
          for (const pageId of requested) {
            this.updateCatalogState(pageId, "failed", error.message);
          }
          sendSocket(client.webSocket, {
            type: "page.import.request.result",
            ok: false,
            error: error.message,
          });
        });
      return;
    }
    if (message.type === "page.import.result") {
      const result = message.result || {};
      const pending = this.pendingImports.get(result.pageId);
      if (pending) {
        this.pendingImports.delete(result.pageId);
        pending(result);
      }
      return;
    }
    if (message.type === "page.seed.begin") {
      try {
        this.beginPageSeed(client, message);
      } catch (error) {
        sendPageSeedFailure(client, message, error);
      }
      return;
    }
    if (message.type === "page.seed.chunk") {
      try {
        this.recordPageSeedChunk(client, message, Buffer.byteLength(String(raw)));
      } catch (error) {
        const session = this.pendingPageSeeds.get(message.changeSetId);
        if (session?.client === client) {
          this.failPageSeed(
            session,
            error instanceof Error ? error.message : String(error),
          );
        } else {
          sendPageSeedFailure(client, message, error);
        }
      }
      return;
    }
    if (message.type === "page.seed.complete") {
      try {
        await this.completePageSeed(client, message);
      } catch (error) {
        sendPageSeedFailure(client, message, error);
      }
      return;
    }
    if (message.type === "page.changes.record") {
      await this.applyPageChangeRecord(client, message);
      return;
    }
    if (message.type === "page.changes.complete") {
      this.completeChangeCapture(message.requestId, message.count);
      this.unsentChanges = false;
      return;
    }
    if (message.type === "page.changes.empty") {
      this.pendingChangeCapture?.resolve({
        empty: true,
        changeCount: 0,
        snapshotPath: "",
        relativePath: "",
      });
      this.unsentChanges = false;
      return;
    }
    if (message.type === "ping") {
      sendSocket(client.webSocket, { type: "pong" });
    }
  }

  async applyPageChangeRecord(
    client,
    message,
    { atomicPageSeed = false } = {},
  ) {
    const catalogPage = this.pageCatalog.get(message.changeSet?.pageId);
    const changes = Array.isArray(message.changeSet?.changes)
      ? message.changeSet.changes
      : [];
    const isPageSeed =
      changes.length === 1 && changes[0]?.property === "pageSeed";
    if (
      catalogPage?.acceptsFigmaSeed &&
      catalogPage.state === "not_imported" &&
      !isPageSeed
    ) {
      throw new Error(
        "请先把所选 Figma Frame 完整生成到 Codex，再同步普通样式修改。",
      );
    }
    const stored = await storeChangeSet(this.projectDir, message.changeSet);
    let fastApply;
    try {
      const pageId = message.changeSet?.pageId;
      let manifest = this.pages.get(pageId) || null;
      let baselineSourceHash = this.pageSourceHashes.get(pageId) || "";
      if (!manifest && pageId) {
        const restored = await loadPageBaseline(this.projectDir, pageId);
        if (restored) {
          manifest = restored.prepared;
          baselineSourceHash = restored.projectSourceHash;
          this.pages.set(pageId, restored.prepared);
          this.pageSourceHashes.set(pageId, baselineSourceHash);
        }
      }
      let preparation = null;
      if (this.onPrepareApply) {
        try {
          preparation = await this.onPrepareApply({
            pageId: pageId || null,
            changeSet: message.changeSet,
            manifest,
            baselineSourceHash,
            catalogPage: catalogPage || null,
          });
        } catch (error) {
          preparation = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (preparation?.error) {
        throw new Error(`preapply_failed:${preparation.error}`);
      }
      fastApply = await applyFastPageChanges({
        projectDir: this.projectDir,
        changeSet: message.changeSet,
        manifest:
          manifest ||
          (catalogPage ? { ...catalogPage, pageId: catalogPage.id } : null),
        baselineManifest: manifest,
        baselineSourceHash,
        currentManifest: preparation?.currentManifest || null,
        currentSourceHash:
          preparation?.currentSourceHash || catalogPage?.sourceHash || "",
      });
    } catch (error) {
      const changes = Array.isArray(message.changeSet?.changes)
        ? message.changeSet.changes
        : [];
      fastApply = {
        appliedCount: 0,
        pendingCount: changes.length,
        changedFiles: [],
        durationMs: 0,
        pending: changes.map((change) => ({
          nodeId: change?.nodeId || null,
          property: change?.property || null,
          reason: "fast_apply_failed",
        })),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.updateCatalogState(
      message.changeSet?.pageId,
      atomicPageSeed && fastApply.pendingCount > 0
        ? "not_imported"
        : fastApply.pendingCount > 0
          ? "conflict"
          : "synced",
    );
    const captured = {
      empty: false,
      changeCount:
        (message.changeSet?.changes?.length || 0) +
        (message.changeSet?.annotations?.length || 0),
      snapshotPath: stored.absolutePath,
      relativePath: stored.relativePath,
      figma: message.changeSet?.figma || null,
      changeSet: message.changeSet || null,
      fastApply,
    };
    let synchronized = null;
    if (this.onFastApply && (!atomicPageSeed || fastApply.pendingCount === 0)) {
      try {
        synchronized = await this.onFastApply({
          ...captured,
          pageId: message.changeSet?.pageId || null,
        });
      } catch {
        // The change snapshot and source patch are already durable.
      }
    }
    if (synchronized?.fastApply) {
      fastApply = synchronized.fastApply;
      captured.fastApply = fastApply;
    }
    let synchronizedPage = null;
    if (
      fastApply.pendingCount === 0 &&
      fastApply.appliedCount > 0 &&
      synchronized?.pageManifest
    ) {
      try {
        synchronizedPage = preparePageManifest({
          json: JSON.stringify(synchronized.pageManifest),
          sourcePath:
            synchronized.pageManifest.source?.file || "current-preview",
        });
        const projectSourceHash =
          synchronized.projectSourceHash ||
          synchronized.sourceHash ||
          catalogPage?.sourceHash ||
          "";
        this.pages.set(synchronizedPage.pageId, synchronizedPage);
        this.pageSourceHashes.set(
          synchronizedPage.pageId,
          projectSourceHash,
        );
        await storePageBaseline(
          this.projectDir,
          synchronized.pageManifest,
          projectSourceHash,
        );
      } catch (error) {
        this.lastError = `page_baseline_refresh_failed:${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.updateCatalogState(
      message.changeSet?.pageId,
      atomicPageSeed && fastApply.pendingCount > 0
        ? "not_imported"
        : fastApply.pendingCount > 0
          ? "conflict"
          : "synced",
    );
    const state =
      fastApply.pendingCount === 0
        ? "applied"
        : fastApply.appliedCount > 0
          ? "partial"
          : "pending";
    if (atomicPageSeed && state !== "applied") {
      sendSocket(client.webSocket, {
        type: "page.seed.result",
        ok: false,
        requestId: message.requestId || null,
        changeSetId: message.changeSet?.changeSetId || null,
        pageId: message.changeSet?.pageId || null,
        error: fastApplyErrorMessage(fastApply),
        fastApply,
      });
    } else {
      sendSocket(client.webSocket, {
        type: "page.changes.ack",
        requestId: message.requestId || null,
        changeSetId: message.changeSet?.changeSetId || null,
        pageId: message.changeSet?.pageId || null,
        sourceHash:
          synchronizedPage?.sourceHash ||
          synchronized?.sourceHash ||
          message.changeSet?.sourceHash ||
          null,
        previousSourceHash: message.changeSet?.sourceHash || null,
        state,
        path: stored.relativePath,
        changeCount: captured.changeCount,
        fastApply,
      });
    }
    this.recordCapturedChange(message.requestId, captured);
    this.unsentChanges = false;
    return captured;
  }

  beginPageSeed(client, message) {
    const requestId = requiredString(message.requestId, "requestId");
    const changeSetId = requiredString(message.changeSetId, "changeSetId");
    if (message.transportVersion !== PAGE_SEED_TRANSPORT_VERSION) {
      throw new Error("不支持的页面分块传输版本。");
    }
    if (this.pendingPageSeeds.has(changeSetId)) {
      throw new Error("页面分块会话已存在，请直接重试。");
    }
    const pageId = requiredString(message.pageId, "pageId");
    const sourceHash = requiredString(message.sourceHash, "sourceHash");
    if (
      [...this.pendingPageSeeds.values()].some(
        (session) => session.client === client || session.pageId === pageId,
      )
    ) {
      throw new Error("已有页面正在传输，请等待完成后再试。");
    }
    const catalogPage = this.pageCatalog.get(pageId);
    if (
      !catalogPage?.acceptsFigmaSeed ||
      catalogPage.state !== "not_imported" ||
      catalogPage.sourceHash !== sourceHash
    ) {
      throw new Error("当前 Codex 页面不再接受这次 Figma 页面生成。");
    }
    const nodeCount = boundedInteger(
      message.nodeCount,
      1,
      MAX_PAGE_SEED_NODES,
      "nodeCount",
    );
    const chunkCount = boundedInteger(
      message.chunkCount,
      1,
      MAX_PAGE_SEED_CHUNKS,
      "chunkCount",
    );
    const session = {
      client,
      requestId,
      changeSetId,
      pageId,
      sourceHash,
      nodeCount,
      chunkCount,
      rootNodeType: requiredString(message.rootNodeType, "rootNodeType"),
      rootNodeName: String(message.rootNodeName || "Figma page"),
      figma: message.figma && typeof message.figma === "object"
        ? message.figma
        : null,
      chunks: new Map(),
      totalBytes: 0,
      timer: null,
    };
    session.timer = setTimeout(() => {
      this.failPageSeed(session, "页面分块传输超时，源码保持原样，请重试。");
    }, PAGE_SEED_SESSION_TIMEOUT_MS);
    this.pendingPageSeeds.set(changeSetId, session);
  }

  recordPageSeedChunk(client, message, rawBytes) {
    const session = this.pageSeedSession(client, message);
    const index = boundedInteger(
      message.index,
      0,
      session.chunkCount - 1,
      "index",
    );
    const records = Array.isArray(message.records) ? message.records : null;
    if (
      !records ||
      records.length === 0 ||
      records.length > MAX_PAGE_SEED_CHUNK_NODES ||
      session.chunks.has(index)
    ) {
      throw new Error("页面分块数据无效或重复。");
    }
    session.totalBytes += rawBytes;
    if (session.totalBytes > MAX_PAGE_SEED_TOTAL_BYTES) {
      throw new Error("页面分块总量超过 64 MB 安全限制。");
    }
    session.chunks.set(index, records);
  }

  async completePageSeed(client, message) {
    let session = null;
    let applying = false;
    try {
      session = this.pageSeedSession(client, message);
      if (session.chunks.size !== session.chunkCount) {
        throw new Error("页面分块不完整，源码保持原样。");
      }
      const records = [];
      for (let index = 0; index < session.chunkCount; index += 1) {
        const chunk = session.chunks.get(index);
        if (!chunk) {
          throw new Error(`缺少页面分块 ${index + 1}。`);
        }
        records.push(...chunk);
      }
      if (records.length !== session.nodeCount) {
        throw new Error("页面节点总数与分块清单不一致。");
      }
      const root = rebuildPageSeedTree(records);
      applying = true;
      clearTimeout(session.timer);
      session.timer = null;
      await this.applyPageChangeRecord(client, {
        type: "page.changes.record",
        requestId: session.requestId,
        changeSet: {
          protocolVersion: PROTOCOL_VERSION,
          changeSetId: session.changeSetId,
          pageId: session.pageId,
          sourceHash: session.sourceHash,
          changes: [{
            nodeId: "page-root",
            nodeName: session.rootNodeName,
            nodeType: session.rootNodeType,
            sourceRef: { selector: '[data-codex-id="page-root"]' },
            category: "structure",
            property: "pageSeed",
            from: null,
            to: { node: root },
          }],
          annotations: [],
          figma: session.figma,
        },
      }, { atomicPageSeed: true });
      this.deletePageSeedSession(session);
    } catch (error) {
      if (session) {
        if (applying) {
          this.deletePageSeedSession(session);
          throw error;
        }
        this.failPageSeed(session, error instanceof Error ? error.message : String(error));
        return;
      }
      throw error;
    }
  }

  pageSeedSession(client, message) {
    if (message.transportVersion !== PAGE_SEED_TRANSPORT_VERSION) {
      throw new Error("不支持的页面分块传输版本。");
    }
    const changeSetId = requiredString(message.changeSetId, "changeSetId");
    const session = this.pendingPageSeeds.get(changeSetId);
    if (
      !session ||
      session.client !== client ||
      session.requestId !== message.requestId
    ) {
      throw new Error("页面分块会话不存在或已经失效。");
    }
    return session;
  }

  failPageSeed(session, error) {
    this.deletePageSeedSession(session);
    sendSocket(session.client.webSocket, {
      type: "page.seed.result",
      ok: false,
      requestId: session.requestId,
      changeSetId: session.changeSetId,
      pageId: session.pageId,
      error,
    });
  }

  deletePageSeedSession(session) {
    clearTimeout(session.timer);
    this.pendingPageSeeds.delete(session.changeSetId);
  }

  clearPageSeedSessions(client = null) {
    for (const session of this.pendingPageSeeds.values()) {
      if (!client || session.client === client) {
        clearTimeout(session.timer);
        this.pendingPageSeeds.delete(session.changeSetId);
      }
    }
  }

  async handleHttp(request, response) {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    );
    if (request.method === "OPTIONS") {
      if (!isTrustedFigmaOrigin(request.headers.origin)) {
        sendJson(response, 403, { error: "origin_not_allowed" });
        return;
      }
      response.writeHead(204, corsHeaders(request));
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        ...this.status(),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/pair") {
      if (!isTrustedFigmaOrigin(request.headers.origin)) {
        sendJson(response, 403, { error: "origin_not_allowed" });
        return;
      }
      sendJson(
        response,
        200,
        {
          ok: true,
          token: this.token,
          wsUrl: `ws://localhost:${this.port}/ws`,
          projectName: this.projectName,
          projectKey: this.projectKey,
        },
        corsHeaders(request),
      );
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  waitForImport(pageId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImports.delete(pageId);
        reject(new Error("Figma 页面导入超时，请确认本地插件仍然打开。"));
      }, OPERATION_TIMEOUT_MS);
      this.pendingImports.set(pageId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  recordCapturedChange(requestId, captured) {
    const pending = this.pendingChangeCapture;
    if (!pending || pending.requestId !== requestId) return;
    pending.results.push(captured);
    this.finishChangeCaptureIfReady();
  }

  completeChangeCapture(requestId, count) {
    const pending = this.pendingChangeCapture;
    if (!pending || pending.requestId !== requestId) return;
    pending.expectedCount = Number.isInteger(count) ? Math.max(0, count) : 0;
    this.finishChangeCaptureIfReady();
  }

  finishChangeCaptureIfReady() {
    const pending = this.pendingChangeCapture;
    if (
      !pending ||
      pending.expectedCount === null ||
      pending.results.length < pending.expectedCount
    ) {
      return;
    }
    if (pending.results.length === 0) {
      pending.resolve({
        empty: true,
        changeCount: 0,
        snapshotPath: "",
        snapshotPaths: [],
        relativePath: "",
      });
      return;
    }
    const fastApplies = pending.results
      .map((result) => result.fastApply)
      .filter(Boolean);
    const changedFiles = [
      ...new Set(fastApplies.flatMap((result) => result.changedFiles || [])),
    ];
    pending.resolve({
      empty: false,
      changeCount: pending.results.reduce(
        (sum, result) => sum + (result.changeCount || 0),
        0,
      ),
      snapshotPath: pending.results.at(-1).snapshotPath,
      snapshotPaths: pending.results.map((result) => result.snapshotPath),
      relativePath: pending.results.at(-1).relativePath,
      figma: pending.results.at(-1).figma || null,
      pages: pending.results.length,
      fastApply: {
        appliedCount: fastApplies.reduce(
          (sum, result) => sum + (result.appliedCount || 0),
          0,
        ),
        pendingCount: fastApplies.reduce(
          (sum, result) => sum + (result.pendingCount || 0),
          0,
        ),
        changedFiles,
        durationMs: fastApplies.reduce(
          (sum, result) => sum + (result.durationMs || 0),
          0,
        ),
        pending: fastApplies.flatMap((result) => result.pending || []),
        transactionId:
          fastApplies.map((result) => result.transactionId).filter(Boolean).at(-1) || "",
        undoAvailable: fastApplies.some((result) => result.undoAvailable),
      },
    });
  }

  readyClients() {
    return [...this.clients].filter((client) => client.ready);
  }

  broadcast(message) {
    for (const client of this.readyClients()) {
      sendSocket(client.webSocket, message);
    }
  }

  catalogEntries() {
    return [...this.pageCatalog.values()].map((page) => ({ ...page }));
  }

  updateCatalogState(pageId, state, error = "") {
    if (!pageId || !this.pageCatalog.has(pageId)) return;
    this.pageCatalog.set(pageId, {
      ...this.pageCatalog.get(pageId),
      state,
      error,
    });
    this.broadcastCatalog();
  }

  markCatalogFigmaChanged(pageId) {
    const current = this.pageCatalog.get(pageId);
    if (!current) return;
    if (current.acceptsFigmaSeed && current.state === "not_imported") {
      return;
    }
    this.updateCatalogState(
      pageId,
      current.state === "source_changed" ? "conflict" : "figma_changed",
    );
  }

  broadcastCatalog() {
    this.broadcast({ type: "page.catalog", pages: this.catalogEntries() });
  }
}

function rebuildPageSeedTree(records) {
  const nodes = new Map();
  const childRecords = new Map();
  let rootRecord = null;
  for (const record of records) {
    if (!record || typeof record !== "object") {
      throw new Error("页面节点记录无效。");
    }
    const definition = record.node;
    const nodeId =
      definition && typeof definition.id === "string"
        ? definition.id.trim()
        : "";
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(nodeId) ||
      nodes.has(nodeId) ||
      !["frame", "image", "svg", "text"].includes(definition?.type)
    ) {
      throw new Error("页面节点 ID 重复或节点类型无效。");
    }
    if (
      definition.children !== undefined &&
      (!Array.isArray(definition.children) || definition.children.length > 0)
    ) {
      throw new Error("页面分块不能携带未声明的嵌套节点。");
    }
    const node = { ...definition };
    if (node.type === "frame") {
      node.children = [];
    } else {
      delete node.children;
    }
    nodes.set(nodeId, node);
    const parentId = record.parentId;
    if (parentId === null) {
      if (
        rootRecord ||
        nodeId !== "page-root" ||
        node.type !== "frame" ||
        record.index !== 0
      ) {
        throw new Error("页面必须且只能包含一个 page-root 根节点。");
      }
      rootRecord = { ...record, node };
      continue;
    }
    if (typeof parentId !== "string" || !parentId) {
      throw new Error("页面节点缺少有效父节点。");
    }
    const index = boundedInteger(record.index, 0, MAX_PAGE_SEED_NODES, "index");
    const children = childRecords.get(parentId) || [];
    children.push({ index, nodeId });
    childRecords.set(parentId, children);
  }
  if (!rootRecord) {
    throw new Error("页面缺少 page-root 根节点。");
  }
  for (const [parentId, children] of childRecords) {
    const parent = nodes.get(parentId);
    if (!parent || parent.type !== "frame") {
      throw new Error("页面节点引用了不存在或不可包含子节点的父节点。");
    }
    children.sort((left, right) => left.index - right.index);
    for (let index = 0; index < children.length; index += 1) {
      if (children[index].index !== index) {
        throw new Error("页面子节点顺序不连续或重复。");
      }
      parent.children.push(nodes.get(children[index].nodeId));
    }
  }
  const visited = new Set();
  const active = new Set();
  const visit = (node) => {
    if (active.has(node.id)) {
      throw new Error("页面节点包含循环引用。");
    }
    if (visited.has(node.id)) {
      throw new Error("页面节点被多个父节点重复引用。");
    }
    active.add(node.id);
    visited.add(node.id);
    for (const child of node.children || []) {
      visit(child);
    }
    active.delete(node.id);
  };
  visit(rootRecord.node);
  if (visited.size !== nodes.size) {
    throw new Error("页面分块包含未连接到根节点的孤立节点。");
  }
  return rootRecord.node;
}

function requiredString(value, field) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 256) {
    throw new Error(`页面分块字段 ${field} 无效。`);
  }
  return result;
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`页面分块字段 ${field} 超出安全范围。`);
  }
  return value;
}

function fastApplyErrorMessage(fastApply) {
  if (typeof fastApply?.error === "string" && fastApply.error) {
    return fastApply.error;
  }
  if (typeof fastApply?.error?.message === "string" && fastApply.error.message) {
    return fastApply.error.message;
  }
  const reason = fastApply?.pending?.[0]?.reason;
  return reason
    ? `页面无法安全写入：${reason}。源码保持原样。`
    : "页面无法安全写入，源码保持原样。";
}

function sendPageSeedFailure(client, message, error) {
  sendSocket(client.webSocket, {
    type: "page.seed.result",
    ok: false,
    requestId: message.requestId || null,
    changeSetId: message.changeSetId || null,
    pageId: message.pageId || null,
    error: error instanceof Error ? error.message : String(error),
  });
}

async function storeChangeSet(projectDir, changeSet) {
  if (!changeSet || typeof changeSet !== "object") {
    throw new Error("Figma 修改数据无效。");
  }
  const directory = path.join(
    projectDir,
    ".figma-sync",
    "workspace-changes",
  );
  await mkdir(directory, { recursive: true });
  const fileName = `${Date.now()}-${safeName(changeSet.pageId || "page")}.json`;
  const absolutePath = path.join(directory, fileName);
  const temporary = `${absolutePath}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(
      {
        protocolVersion: PROTOCOL_VERSION,
        capturedAt: new Date().toISOString(),
        ...changeSet,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await rename(temporary, absolutePath);
  return {
    absolutePath,
    relativePath: path
      .relative(projectDir, absolutePath)
      .replaceAll("\\", "/"),
  };
}

async function storePageBaseline(projectDir, manifest, projectSourceHash = "") {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Page baseline is invalid.");
  }
  const prepared = preparePageManifest({
    json: JSON.stringify(manifest),
    sourcePath: manifest.source?.file || "current-preview",
  });
  const directory = path.join(projectDir, ".figma-sync", "page-baselines");
  await mkdir(directory, { recursive: true });
  const absolutePath = path.join(
    directory,
    `${safeName(prepared.pageId || "page")}.json`,
  );
  const temporary = `${absolutePath}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(
      {
        version: 1,
        pageId: prepared.pageId,
        projectSourceHash: String(projectSourceHash || ""),
        savedAt: new Date().toISOString(),
        manifest,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await rename(temporary, absolutePath);
  return { prepared, absolutePath };
}

async function loadPageBaseline(projectDir, pageId) {
  const file = path.join(
    projectDir,
    ".figma-sync",
    "page-baselines",
    `${safeName(pageId || "page")}.json`,
  );
  try {
    const stored = JSON.parse(await readFile(file, "utf8"));
    let resetAt = "";
    try {
      resetAt = await readFile(path.join(path.dirname(file), ".reset"), "utf8");
    } catch {
      // No workspace reset marker has been written.
    }
    if (
      stored?.version !== 1 ||
      stored.pageId !== pageId ||
      !stored.manifest ||
      (resetAt && resetAt.trim() >= String(stored.savedAt || ""))
    ) {
      return null;
    }
    const prepared = preparePageManifest({
      json: JSON.stringify(stored.manifest),
      sourcePath: stored.manifest.source?.file || "current-preview",
    });
    if (prepared.pageId !== pageId) return null;
    return {
      prepared,
      projectSourceHash: String(stored.projectSourceHash || ""),
    };
  } catch {
    return null;
  }
}

async function invalidatePageBaselines(projectDir) {
  const directory = path.join(projectDir, ".figma-sync", "page-baselines");
  const marker = path.join(directory, ".reset");
  await mkdir(directory, { recursive: true });
  await writeFile(marker, new Date().toISOString(), "utf8");
}

function safeName(value) {
  return String(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function formalVersion(version) {
  return String(version || "").split("+")[0];
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "cache-control": "no-store",
    vary: "Origin, Access-Control-Request-Private-Network",
  };
}

function isTrustedFigmaOrigin(origin) {
  return typeof origin === "string" && TRUSTED_FIGMA_ORIGINS.has(origin);
}

function sendJson(response, status, value, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendSocket(webSocket, value) {
  if (webSocket.readyState === 1) {
    webSocket.send(JSON.stringify(value));
  }
}
