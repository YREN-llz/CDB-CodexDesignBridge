import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chooseLocalProjectLocation,
  createDirectoryPickerCommand,
  parseDirectoryPickerResult,
} from "../codex-plugin/codex-design-bridge/mcp/local-directory-picker.mjs";

test("builds a hidden Windows native folder picker command", () => {
  const command = createDirectoryPickerCommand({
    platform: "win32",
    initialDir: "C:\\Designs",
    purpose: "figma",
    environment: { SystemRoot: "C:\\Windows", PATH: "test-path" },
  });

  assert.equal(
    command.command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.deepEqual(command.args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-STA",
  ]);
  assert.equal(command.options.windowsHide, true);
  assert.equal(command.options.env.CDB_DIRECTORY_PICKER_INITIAL, "C:\\Designs");
  assert.equal(
    command.options.env.CDB_DIRECTORY_PICKER_TITLE,
    "选择 Figma 项目的保存位置",
  );
  assert.match(command.args.at(-1), /FolderBrowserDialog/);
});

test("builds macOS and Linux native folder picker commands", () => {
  const mac = createDirectoryPickerCommand({
    platform: "darwin",
    initialDir: "/Users/designer/Projects",
  });
  assert.equal(mac.command, "/usr/bin/osascript");
  assert.match(mac.args.at(-1), /choose folder/);
  assert.equal(
    mac.options.env.CDB_DIRECTORY_PICKER_INITIAL,
    "/Users/designer/Projects",
  );

  const linux = createDirectoryPickerCommand({
    platform: "linux",
    initialDir: "/home/designer/Projects",
  });
  assert.equal(linux.command, "zenity");
  assert.ok(linux.args.includes("--directory"));
  assert.ok(linux.args.includes("--filename=/home/designer/Projects/"));
  assert.deepEqual(linux.cancelExitCodes, [1]);
});

test("labels an existing-project picker as an open action", () => {
  const command = createDirectoryPickerCommand({
    platform: "win32",
    purpose: "open",
    environment: { SystemRoot: "C:\\Windows" },
  });
  assert.equal(
    command.options.env.CDB_DIRECTORY_PICKER_TITLE,
    "选择要打开的 CDB 项目文件夹",
  );
});

test("parses selection, cancellation, and picker failures", () => {
  assert.deepEqual(
    parseDirectoryPickerResult({ code: 0, stdout: "C:\\Designs\r\n" }),
    { cancelled: false, path: "C:\\Designs" },
  );
  assert.deepEqual(
    parseDirectoryPickerResult({
      code: 0,
      stdout: "__CDB_DIRECTORY_PICKER_CANCELLED__",
    }),
    { cancelled: true, path: "" },
  );
  assert.deepEqual(
    parseDirectoryPickerResult({ code: 1, cancelExitCodes: [1] }),
    { cancelled: true, path: "" },
  );
  assert.throws(
    () => parseDirectoryPickerResult({ code: 2, stderr: "picker failed" }),
    /picker failed/,
  );
});

test("returns an existing selected directory without creating files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cdb-picker-selected-"));
  t.after(() => rmdir(root));
  const before = await readdir(root);

  const result = await chooseLocalProjectLocation({
    initialDir: root,
    platform: "win32",
    execute: async () => ({ code: 0, stdout: root, stderr: "" }),
  });

  assert.deepEqual(result, {
    selected: true,
    cancelled: false,
    path: path.resolve(root),
    platform: "win32",
  });
  assert.deepEqual(await readdir(root), before);
});

test("cancelling the native picker has zero filesystem effects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cdb-picker-cancelled-"));
  t.after(() => rmdir(root));
  const before = await readdir(root);

  const result = await chooseLocalProjectLocation({
    initialDir: root,
    platform: "win32",
    execute: async () => ({
      code: 0,
      stdout: "__CDB_DIRECTORY_PICKER_CANCELLED__",
      stderr: "",
    }),
  });

  assert.deepEqual(result, {
    selected: false,
    cancelled: true,
    path: "",
    platform: "win32",
  });
  assert.deepEqual(await readdir(root), before);
});

test("rejects a picker result that is not an existing directory", async () => {
  await assert.rejects(
    chooseLocalProjectLocation({
      platform: "win32",
      execute: async () => ({
        code: 0,
        stdout: path.join(os.tmpdir(), `missing-cdb-directory-${Date.now()}`),
        stderr: "",
      }),
    }),
    /不是可用的本地文件夹/,
  );
});
